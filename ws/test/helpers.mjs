// test/helpers.mjs — node:test 公共工具
import {once} from 'node:events';
import {WebSocket as WS, WebSocketServer} from '../src/index.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 拒绝用的超时 promise (unref, 不会拖住进程) */
export function timeout(ms, label = 'operation') {
	return new Promise((_, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} 超时 (${ms}ms)`)), ms);
		timer.unref?.();
	});
}

/** 等事件, 超时直接失败 (避免测试挂死); 不因 'error' 事件中断 */
export function waitFor(emitter, event, ms = 2000) {
	return Promise.race([
		new Promise((resolve) => emitter.once(event, (...args) => resolve(args))),
		timeout(ms, `等待 "${event}" 事件`),
	]);
}

/**
 * 起一个监听随机端口的 WebSocketServer, 测试结束自动关闭并断开所有连接。
 * @param {import('node:test').TestContext} t
 * @param {object} [options]
 */
export async function startServer(t, options = {}) {
	const wss = new WebSocketServer({ port: 0, ...options });
	await once(wss._server, 'listening');
	const { port } = wss.address();

	t.after(async () => {
		for (const client of wss.clients) client.terminate();
		await new Promise((r) => wss.close(r));
		await sleep(20);
	});

	return { wss, port, url: (path = '/') => `ws://127.0.0.1:${port}${path}` };
}

/** 服务端回声: 原样发回 (保持文本/二进制类型) */
export function echoOn(wss, handler) {
	wss.on('connection', (ws, req) => {
		ws.on('error', () => {});
		ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
		handler?.(ws, req);
	});
}

/**
 * 建立客户端连接, 等到 open; 测试结束自动断开。
 * @param {import('node:test').TestContext} t
 * @param {string} url
 * @param {object|string[]} [options]
 * @returns {Promise<import('../src/index.js').WebSocket>}
 */
export async function connect(t, url, options = {}) {
	const ws = new WS(url, options);
	t.after(() => {
		try { ws.terminate(); } catch {}
	});

	await Promise.race([
		new Promise((res, rej) => {
			ws.once('open', res);
			ws.once('error', rej);
		}),
		timeout(3000, '建立连接'),
	]);

	return ws;
}

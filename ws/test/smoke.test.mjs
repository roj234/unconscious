/**
 * shim 冒烟测试: 验证 ws 风格 API 语义 + 与 ws 客户端的互通。
 * 用法: node --test test/
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';

import {WebSocket as ShimWebSocket} from '../src/index.js';
// 包名自引用 (package.json exports) → 实际解析到本包的 src/index.js。
// 想真正验证与 ws 的互通, 请 `npm i -D ws` 并把下面这行换成 from 'ws'。

import {connect, echoOn, sleep, startServer, timeout, waitFor} from './helpers.mjs';

describe('ws 客户端 -> shim 服务端', () => {
	it('文本与二进制回声 (deflate 关)', async (t) => {
		const { wss, url } = await startServer(t, { perMessageDeflate: false });
		echoOn(wss);

		const ws = await connect(t, url());

		ws.send('hello');
		const [textData, textBinary] = await waitFor(ws, 'message');
		assert.equal(textData.toString(), 'hello');
		assert.equal(textBinary, false);

		ws.send(Buffer.from([1, 2, 3]));
		const [binData, binBinary] = await waitFor(ws, 'message');
		assert.equal(binData.length, 3);
		assert.equal(binBinary, true);
	});

	it('deflate 开, 64KB 载荷压缩回声一致', async (t) => {
		const { wss, url } = await startServer(t, { perMessageDeflate: { threshold: 0 } });
		echoOn(wss);

		const ws = await connect(t, url(), { perMessageDeflate: true });

		const payload = Buffer.alloc(64 * 1024, 0x61);
		ws.send(payload);
		const [reply] = await waitFor(ws, 'message');
		assert.equal(Buffer.compare(reply, payload), 0);
	});

	it('shim 客户端 -> shim 服务端回声 + readyState', async (t) => {
		const { wss, url } = await startServer(t, { perMessageDeflate: false });
		echoOn(wss);

		const ws = await connect(t, url(), { perMessageDeflate: false });
		assert.equal(ws.readyState, ShimWebSocket.OPEN);

		ws.send('shim-client-echo');
		const [data, isBinary] = await waitFor(ws, 'message');
		assert.equal(data.toString(), 'shim-client-echo');
		assert.equal(isBinary, false);
	});

	it('客户端主动 close 时服务端收到 code/reason', async (t) => {
		const { wss, url } = await startServer(t, { perMessageDeflate: false });

		const closeInfo = new Promise((resolve) => {
			wss.once('connection', (ws) => {
				ws.on('error', () => {});
				ws.on('close', (code, reason) => resolve({ code, reason: String(reason) }));
			});
		});

		const ws = await connect(t, url());
		ws.close(4001, 'bye');

		const { code, reason } = await Promise.race([closeInfo, timeout(2000, '服务端 close 事件').then(() => assert.fail('服务端未收到 close'))]);
		assert.equal(code, 4001);
		assert.equal(reason, 'bye');
	});

	it('clients 集合跟踪连接数', async (t) => {
		const { wss, url } = await startServer(t, { perMessageDeflate: false });
		wss.on('connection', (ws) => ws.on('error', () => {}));

		const ws = await connect(t, url());
		await sleep(100);
		assert.equal(wss.clients.size, 1);

		ws.close(1000, 'done');
		await waitFor(ws, 'close');
		await sleep(100);
		assert.equal(wss.clients.size, 0);
	});

	it('子协议协商', async (t) => {
		const { wss, url } = await startServer(t, { protocols: ['chat'] });

		const negotiated = new Promise((resolve) => {
			wss.on('connection', (ws) => {
				ws.on('error', () => {});
				resolve(ws.protocol);
			});
		});

		await connect(t, url(), ['chat']);
		assert.equal(await negotiated, 'chat');
	});
});

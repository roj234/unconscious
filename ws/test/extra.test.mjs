/**
 * 扩展回归测试: 分片 / ping-pong / sendFragment / 限制 / close 握手 / deflate 协商 / bufferreleased / 边界
 * 用法: node --test test/
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import net from 'node:net';

import {WebSocket as ShimWS, WebSocketServer} from '../src/index.js';
// 包名自引用 → 本包 src/index.js (见 helpers/README 说明)
import {WebSocket as WSClient} from '@roj234/ws';

import {connect, echoOn, sleep, startServer, timeout, waitFor} from './helpers.mjs';

describe('分片', () => {
	it('服务端 sendFragment 分片 / 客户端 partialmessage 流式接收', async (t) => {
		const { wss, url } = await startServer(t, { perMessageDeflate: false });

		wss.on('connection', (ws) => {
			ws.on('error', () => {});
			ws.on('message', (data) => {
				if (data.toString() !== 'frag-me') return;
				ws.sendFragment(0x1, Buffer.from('hello '), false);
				ws.sendFragment(0x0, Buffer.from('frag '), false);
				ws.sendFragment(0x0, Buffer.from('world'), true);
			});
		});

		// 1) ws 风格客户端把 3 个分片聚合为一条消息
		const c = await connect(t, url());
		c.send('frag-me');
		const [merged] = await waitFor(c, 'message');
		assert.equal(merged.toString(), 'hello frag world');

		// 2) shim 客户端手动分片 → 服务端 partialmessage 逐片交付
		const partials = [];
		let resolvePartials;
		const partialsDone = new Promise((r) => { resolvePartials = r; });

		wss.once('connection', (sws) => {
			sws.on('partialmessage', (payload, isBinary, isLast) => {
				partials.push([payload.toString(), isBinary, isLast]);
				if (isLast) resolvePartials();
			});
		});

		const sc = await connect(t, url(), {});
		sc.sendFragment(0x1, Buffer.from('shim '), false);
		sc.sendFragment(0x0, Buffer.from('frag'), true);

		await Promise.race([partialsDone, timeout(2000, 'partialmessage')]);
		assert.equal(partials.length, 2);
		assert.equal(partials[0][0], 'shim ');
		assert.equal(partials[1][0], 'frag');
		assert.equal(partials[1][2], true);
	});
});

describe('ping / pong', () => {
	it('客户端 ping → 服务端自动 pong', async (t) => {
		const { wss, url } = await startServer(t, { perMessageDeflate: false });
		wss.on('connection', (ws) => ws.on('error', () => {}));

		const c = await connect(t, url());
		c.ping('hi');
		const [pong] = await waitFor(c, 'pong');
		assert.equal(pong.toString(), 'hi');
	});

	it('服务端 ping → 客户端触发 ping 事件并自动 pong', async (t) => {
		const { wss, url } = await startServer(t, { perMessageDeflate: false });
		wss.on('connection', (ws) => ws.on('error', () => {}));

		const sc = await connect(t, url(), {});
		const gotPing = waitFor(sc, 'ping');

		wss.clients.forEach((w) => {
			if (w.readyState === 1) w.ping('svr-ping');
		});

		const [payload] = await gotPing;
		assert.equal(payload.toString(), 'svr-ping');
	});

	it('无参 ping 得到空 pong / 字符串 ping 回显', async (t) => {
		const { wss, url } = await startServer(t, { perMessageDeflate: false });
		wss.on('connection', (ws) => ws.on('error', () => {}));

		const sc = await connect(t, url(), {});

		sc.ping();
		const [emptyPong] = await waitFor(sc, 'pong');
		assert.equal(emptyPong.length, 0);

		sc.ping('hey');
		const [strPong] = await waitFor(sc, 'pong');
		assert.equal(strPong.toString(), 'hey');
	});
});

describe('限制与关闭握手', () => {
	it('超过 maxPayload 被 1009 关闭', async (t) => {
		const { wss, url } = await startServer(t, { maxPayload: 1024, perMessageDeflate: false });
		wss.on('connection', (ws) => ws.on('error', () => {}));

		const c = await connect(t, url());
		c.send(Buffer.alloc(2048));

		const [code] = await waitFor(c, 'close');
		assert.equal(code, 1009);
	});

	it('服务端 sendClose(1008, denied)', async (t) => {
		const { wss, url } = await startServer(t, { perMessageDeflate: false });
		wss.on('connection', (ws) => {
			ws.on('error', () => {});
			ws.sendClose(1008, 'denied');
		});

		// 先挂 close 监听再连接, 避免帧到得太快
		const c = new WSClient(url());
		t.after(() => { try { c.terminate(); } catch {} });
		c.on('error', () => {});
		const closed = waitFor(c, 'close');

		const [code, reason] = await closed;
		assert.equal(code, 1008);
		assert.equal(String(reason), 'denied');
	});

	it('未掩码客户端帧导致服务端关闭连接', async (t) => {
		const { wss, port } = await startServer(t, { perMessageDeflate: false });
		wss.on('connection', (ws) => ws.on('error', () => {}));

		const sock = net.connect(port, '127.0.0.1');
		t.after(() => sock.destroy());
		sock.on('error', () => {});
		await new Promise((r) => sock.once('connect', r));

		// 完成 HTTP 升级握手
		const key = Buffer.from('dGhlIHNhbXBsZSBub25jZQ==');
		sock.write(
			'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
			`Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
		);
		await new Promise((r) => {
			sock.once('data', (d) => { if (d.includes(Buffer.from('101'))) r(); });
		});

		// FIN=1 opcode=1, 未设置 MASK 位
		sock.write(Buffer.from([0x81, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f]));

		const closed = await Promise.race([
			new Promise((r) => { sock.on('close', () => r(true)); sock.on('error', () => r(true)); }),
			sleep(2000).then(() => false),
		]);
		assert.equal(closed, true);
	});
});

describe('握手前的 close / terminate', () => {
	it('close(code) 不崩溃且最终触发 close', async (t) => {
		const { url } = await startServer(t, { perMessageDeflate: false });

		const ws = new ShimWS(url(), {});
		t.after(() => { try { ws.terminate(); } catch {} });
		ws.on('error', () => {});

		const closed = waitFor(ws, 'close', 1500);
		ws.close(4001, 'early');

		const [code] = await closed;
		assert.equal(code, 4001);
	});

	it('terminate() 不崩溃且触发 close(1006)', async (t) => {
		const { url } = await startServer(t, { perMessageDeflate: false });

		const ws = new ShimWS(url(), {});
		t.after(() => { try { ws.terminate(); } catch {} });
		ws.on('error', () => {});

		const closed = waitFor(ws, 'close', 1500);
		ws.terminate();

		const [code] = await closed;
		assert.equal(code, 1006);
	});

	it('不传 options 也可连接 (ws 兼容)', async (t) => {
		const { wss, url } = await startServer(t, { perMessageDeflate: false });
		wss.on('connection', (ws) => ws.on('error', () => {}));

		const c = await connect(t, url());
		assert.equal(c.readyState, ShimWS.OPEN);
	});
});

describe('deflate / 扩展协商', () => {
	it('客户端 perMessageDeflate 配置反映到 extensions / compressThreshold', async (t) => {
		const { url } = await startServer(t, { perMessageDeflate: { threshold: 0 } });

		const c0 = await connect(t, url(), { perMessageDeflate: false });
		assert.equal(c0.extensions, '');

		const c1 = await connect(t, url(), { perMessageDeflate: true });
		assert.equal(c1.extensions, 'permessage-deflate');
		assert.equal(c1.compressThreshold, 1024);
	});

	it('client/server_max_window_bits 协商并正确压缩往返', async (t) => {
		const { wss, url } = await startServer(t, { perMessageDeflate: { threshold: 0 } });

		const negotiated = new Promise((resolve) => {
			wss.on('connection', (ws) => {
				ws.on('error', () => {});
				ws.on('message', (data) => ws.send(data));
				resolve({ inflate: ws.inflateWindowBits, deflate: ws.deflateWindowBits });
			});
		});

		const c = await connect(t, url(), {
			perMessageDeflate: { clientMaxWindowBits: 8, serverMaxWindowBits: 10, threshold: 0 },
		});

		const bits = await Promise.race([negotiated, timeout(2000, 'connection 协商')]);
		assert.equal(bits.inflate, 8, 'client_max_window_bits 应写入 inflateWindowBits');
		assert.equal(bits.deflate, 10, 'server_max_window_bits 应写入 deflateWindowBits');

		const data = Buffer.alloc(64 * 1024, 0x61);
		c.send(data);
		const [reply] = await waitFor(c, 'message');
		assert.equal(Buffer.compare(reply, data), 0);
	});
});

describe('send 数据类型', () => {
	it('ArrayBuffer / TypedArray / 空字符串', async (t) => {
		const { wss, url } = await startServer(t, { perMessageDeflate: false });
		echoOn(wss);

		const c = await connect(t, url(), {});

		c.send(new Uint8Array([9, 8, 7]).buffer);
		const [abData, abBinary] = await waitFor(c, 'message');
		assert.equal(Buffer.from(abData)[0], 9);
		assert.equal(abBinary, true);

		c.send(new Uint8Array([5, 6]));
		const [u8Data, u8Binary] = await waitFor(c, 'message');
		assert.equal(Buffer.from(u8Data).length, 2);
		assert.equal(u8Binary, true);

		c.send('');
		const [emptyData, emptyBinary] = await waitFor(c, 'message');
		assert.equal(emptyData.length, 0);
		assert.equal(emptyBinary, false);
	});
});

describe('服务器形态', () => {
	it('noServer + handleUpgrade', async (t) => {
		const httpServer = createServer((req, res) => res.end('http'));
		const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

		t.after(async () => {
			for (const client of wss.clients) client.terminate();
			await new Promise((r) => wss.close(r));
			httpServer.closeAllConnections?.();
			await new Promise((r) => httpServer.close(r));
		});

		httpServer.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head));
		echoOn(wss);

		httpServer.listen(0);
		await new Promise((r) => httpServer.once('listening', r));
		const { port } = httpServer.address();

		const c = await connect(t, `ws://127.0.0.1:${port}/`);
		c.send('upgrade-ok');
		const [reply] = await waitFor(c, 'message');
		assert.equal(reply.toString(), 'upgrade-ok');
	});

	it('path 过滤: 正确路径可连接, 错误路径被拒且 terminate 不崩溃', async (t) => {
		const { wss, url } = await startServer(t, { path: '/ws', perMessageDeflate: false });
		wss.on('connection', (ws) => ws.on('error', () => {}));

		const ok = await connect(t, url('/ws?x=1'));
		assert.equal(ok.readyState, ShimWS.OPEN);

		const bad = new ShimWS(url('/other'), {});
		t.after(() => { try { bad.terminate(); } catch {} });
		bad.on('error', () => {});

		const outcome = await Promise.race([
			new Promise((r) => bad.once('error', () => r('error'))),
			new Promise((r) => bad.once('open', () => r('open'))),
			sleep(1500).then(() => 'timeout'),
		]);
		assert.equal(outcome, 'error');
		assert.doesNotThrow(() => bad.terminate(), '未握手 terminate() 不应崩溃');
	});
});

describe('heartbeat', () => {
	it('空闲时发出 ping, 收到 pong 后连接保持存活', async (t) => {
		const { wss, url } = await startServer(t, { perMessageDeflate: false });
		wss.on('connection', (ws) => ws.on('error', () => {}));

		const c = await connect(t, url());
		const srvWs = [...wss.clients][0];
		t.after(() => srvWs.stopHeartbeat());

		let gotSrvPing = false;
		c.on('ping', () => { gotSrvPing = true; });

		srvWs.startHeartbeat(100, 400);
		await sleep(350);

		assert.equal(gotSrvPing, true, '服务端心跳应发出 ping');
		assert.equal(srvWs.readyState, ShimWS.OPEN, '心跳后连接应仍存活');

		srvWs.stopHeartbeat();
	});
});

describe('bufferreleased', () => {
	it('分片发送在全部帧释放后触发一次 (服务端 + 客户端)', async (t) => {
		const { wss, url } = await startServer(t, {
			perMessageDeflate: false,
			fragmentSize: 100,
		});
		echoOn(wss);

		const c = await connect(t, url());
		const srvWs = [...wss.clients][0];

		const releasedSrv = [];
		srvWs.on('bufferreleased', (buf) => releasedSrv.push(buf.length));

		c.send(Buffer.alloc(350, 0x62));
		const [echo] = await waitFor(c, 'message');
		assert.equal(echo.length, 350);
		await sleep(200);
		assert.deepEqual(releasedSrv, [350], '分片消息应只触发一次 bufferreleased, 携带原始 buffer 长度');

		const sc = await connect(t, url(), {});
		const releasedCli = [];
		sc.on('bufferreleased', (buf) => releasedCli.push(buf.length));
		sc.send(Buffer.alloc(50, 0x63));
		await sleep(100);
		assert.deepEqual(releasedCli, [50]);
	});
});

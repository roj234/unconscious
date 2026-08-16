/**
 * 单库压测 worker：启动一个 WebSocket 服务器，多连接 echo 流水线压测 + 内存采样。
 * 支持: permessage-deflate 开/关、ws concurrencyLimit、半随机/全'a' payload。
 * 输出一行 `RESULT <json>` 到 stdout。
 *
 * 用法: node bench-ws2-vs-ws-worker.mjs --lib ws2|ws --port N --conns N --msgs N --size N --window N
 *       [--payload random|aaa] [--compress on|off] [--wscc N]
 */
import {parseArgs} from 'node:util';
import {deflateSync} from 'node:zlib';
import {WebSocket as Ws2Client, WebSocketServer as Ws2Server} from '../src/index.js';
import {WebSocketServer as WsServer} from 'ws';

const { values } = parseArgs({
	options: {
		lib:       { type: 'string', default: 'ws2' },   // ws2 | ws
		port:      { type: 'string', default: '29000' },
		conns:     { type: 'string', default: '20' },
		msgs:      { type: 'string', default: '2000' },
		size:      { type: 'string', default: '1024' },
		window:    { type: 'string', default: '16' },
		payload:   { type: 'string', default: 'random' }, // random | aaa
		compress:  { type: 'string', default: 'on' },     // on | off
		wscc:      { type: 'string', default: '10' },     // ws concurrencyLimit, 0=无限
		timeoutMs: { type: 'string', default: '120000' },
	}
});

const PORT       = parseInt(values.port, 10);
const CONNS      = parseInt(values.conns, 10);
const MSGS       = parseInt(values.msgs, 10);
const SIZE       = parseInt(values.size, 10);
const WINDOW     = parseInt(values.window, 10);
const TIMEOUT_MS = parseInt(values.timeoutMs, 10);
const LIB        = values.lib;
const PAYLOAD    = values.payload;
const COMPRESS   = values.compress === 'on';
const WSCC       = parseInt(values.wscc, 10);
const MAX_PAYLOAD = 64 * 1024 * 1024;

if (LIB !== 'ws2' && LIB !== 'ws') { console.error('--lib 必须是 ws2 或 ws'); process.exit(1); }
if (PAYLOAD !== 'random' && PAYLOAD !== 'aaa') { console.error('--payload 必须是 random 或 aaa'); process.exit(1); }

// ---------- payload ----------
// 半随机文本: 固定 seed 的单词流 (中英混排), 统计上有重复结构 → 压缩比约 40~60%
const WORDS = [
	'assistant','user','content','message','hello','world','stream','token','think','reasoning',
	'模型','回答','问题','天气','很好','function','tool','call','result','json','data','chat',
	'agent','role','system','response','the','quick','brown','fox','jumps','over','lazy','dog',
	'performance','benchmark','websocket','compression','deflate','窗口','并发','吞吐','内存',
];
function makePayload(size) {
	let seed = 0x9e3779b9;
	const rand = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 0x100000000;
	const out = [];
	let len = 0;
	while (len < size) {
		const w = WORDS[(rand() * WORDS.length) | 0];
		out.push(w);
		len += w.length + 1;
	}
	return Buffer.from(out.join(' ').slice(0, size), 'utf8');
}
const payload = PAYLOAD === 'aaa' ? Buffer.alloc(SIZE, 0x61) : makePayload(SIZE);
const ratio = (deflateSync(payload).length / payload.length);

// ---------- 内存采样 ----------
const mem = { rssPeak: 0, heapUsedPeak: 0, externalPeak: 0, arrayBuffersPeak: 0, rssEnd: 0, heapUsedEnd: 0 };
let sampling = true;
const sampler = setInterval(() => {
	const m = process.memoryUsage();
	if (m.rss > mem.rssPeak) mem.rssPeak = m.rss;
	if (m.heapUsed > mem.heapUsedPeak) mem.heapUsedPeak = m.heapUsed;
	if (m.external > mem.externalPeak) mem.externalPeak = m.external;
	if (m.arrayBuffers > mem.arrayBuffersPeak) mem.arrayBuffersPeak = m.arrayBuffers;
}, 100);
const MB = 1048576;

// ---------- 启动服务器 ----------
const serverOpts = { port: PORT, maxPayload: MAX_PAYLOAD };
let server;

if (LIB === 'ws2') {
	server = new Ws2Server({
		...serverOpts,
		perMessageDeflate: COMPRESS ? { threshold: 0 } : false,
	});
	server.on('connection', (ws) => {
		ws.fragmentSize = 0;
		ws.on('error', () => {});
		ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
	});
	await new Promise((resolve) => server._server.on('listening', resolve));
} else {
	server = new WsServer({
		...serverOpts,
		perMessageDeflate: COMPRESS ? { threshold: 0, concurrencyLimit: WSCC } : false,
	});
	server.on('connection', (ws) => {
		ws.on('error', () => {});
		ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
	});
	await new Promise((resolve) => server.on('listening', resolve));
}

// ---------- 压测 (客户端统一 ws2, 消除客户端差异) ----------
const ClientCtor = Ws2Client;
const hammer = (connIdx) => new Promise((resolve) => {
	let ws;
	const timer = setTimeout(() => { try { ws?.close(); } catch {} resolve(); }, TIMEOUT_MS);

	ws = new ClientCtor(`ws://127.0.0.1:${PORT}/`, {
		perMessageDeflate: COMPRESS,
		maxPayload: MAX_PAYLOAD,
	});
	if (COMPRESS) ws.compressThreshold = 1;

	let sent = 0, received = 0;
	ws.on('open', () => {
		for (let i = 0; i < WINDOW && sent < MSGS; i++) { ws.send(payload, { binary: true }); sent++; }
	});
	ws.on('message', () => {
		received++;
		if (received >= MSGS) { clearTimeout(timer); try { ws.close(); } catch {} resolve(); }
		else if (sent < MSGS) { ws.send(payload, { binary: true }); sent++; }
	});
	ws.on('error', (e) => {
		clearTimeout(timer);
		console.error(`[${LIB}] 连接 ${connIdx} 出错:`, e?.message || e);
		try { ws.close(); } catch {} resolve();
	});
});

const t0 = performance.now();
await Promise.all(Array.from({ length: CONNS }, (_, i) => hammer(i)));
const elapsedMs = performance.now() - t0;

sampling = false;
clearInterval(sampler);
const end = process.memoryUsage();
mem.rssEnd = end.rss;
mem.heapUsedEnd = end.heapUsed;
try { server.close(); } catch {}

const totalMsgs = CONNS * MSGS;
const result = {
	lib: LIB,
	conns: CONNS, msgs: MSGS, size: SIZE, window: WINDOW,
	payload: PAYLOAD, compress: COMPRESS ? 'on' : 'off', wscc: WSCC,
	compressedRatio: ratio.toFixed(2),
	totalMsgs,
	elapsedMs: Math.round(elapsedMs),
	msgsPerSec: Math.round(totalMsgs / (elapsedMs / 1000)),
	mbPerSec: (totalMsgs * SIZE / (elapsedMs / 1000) / MB).toFixed(1),
	rssPeakMB: (mem.rssPeak / MB).toFixed(1),
	heapUsedPeakMB: (mem.heapUsedPeak / MB).toFixed(1),
	arrayBuffersPeakMB: (mem.arrayBuffersPeak / MB).toFixed(1),
	rssEndMB: (mem.rssEnd / MB).toFixed(1),
	heapUsedEndMB: (mem.heapUsedEnd / MB).toFixed(1),
};

console.log('RESULT ' + JSON.stringify(result));
process.exit(0);

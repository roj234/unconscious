/**
 * ws2 vs ws —— 多连接吞吐 + 内存峰值对比 (permessage-deflate 开/关, payload 可调)
 *
 * 用法:
 *   node bench-ws2-vs-ws.mjs                                          # 默认: 半随机文本, 压缩开
 *   node bench-ws2-vs-ws.mjs --payload aaa                            # 全'a' 对照
 *   node bench-ws2-vs-ws.mjs --compress off                           # 关压缩
 *   node bench-ws2-vs-ws.mjs --wscc 0                                 # ws 并发限制无限
 *   node bench-ws2-vs-ws.mjs --threadpool 8                           # 放大线程池
 *   node bench-ws2-vs-ws.mjs --conns 1 --rounds 3                     # 单连接对照
 */
import {spawn} from 'node:child_process';
import {parseArgs} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { values } = parseArgs({
	options: {
		conns:      { type: 'string', default: '20' },
		msgs:       { type: 'string', default: '2000' },
		size:       { type: 'string', default: '1024' },
		window:     { type: 'string', default: '16' },
		rounds:     { type: 'string', default: '3' },
		threadpool: { type: 'string', default: '4' },
		payload:    { type: 'string', default: 'random' },  // random | aaa
		compress:   { type: 'string', default: 'on' },      // on | off
		wscc:       { type: 'string', default: '10' },      // ws concurrencyLimit, 0=无限
	}
});

const CONNS      = parseInt(values.conns, 10);
const MSGS       = parseInt(values.msgs, 10);
const SIZE       = parseInt(values.size, 10);
const WINDOW     = parseInt(values.window, 10);
const ROUNDS     = parseInt(values.rounds, 10);
const THREADPOOL = parseInt(values.threadpool, 10);
const PAYLOAD    = values.payload;
const COMPRESS   = values.compress;
const WSCC       = values.wscc;

const workerPath = path.join(__dirname, 'bench-worker.mjs');
const BASE_PORT  = 29100;

function runWorker(lib, round) {
	const port = BASE_PORT + (lib === 'ws2' ? 0 : 1);
	const args = [
		workerPath,
		'--lib', lib,
		'--port', String(port),
		'--conns', String(CONNS),
		'--msgs', String(MSGS),
		'--size', String(SIZE),
		'--window', String(WINDOW),
		'--payload', PAYLOAD,
		'--compress', COMPRESS,
		'--wscc', WSCC,
		'--timeoutMs', '180000',
	];
	console.log(`  第${round}轮: 启动 ${lib} (port ${port}, threadpool=${THREADPOOL}) ...`);

	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, args, {
			env: { ...process.env, UV_THREADPOOL_SIZE: String(THREADPOOL) },
			stdio: ['ignore', 'pipe', 'inherit'],
		});
		let stdout = '';
		child.stdout.on('data', (d) => { stdout += d; });
		child.on('error', reject);
		child.on('exit', (code) => {
			if (code !== 0) return reject(new Error(`${lib} worker 退出码 ${code}`));
			const line = stdout.split('\n').filter(l => l.startsWith('RESULT ')).at(-1);
			if (!line) return reject(new Error(`${lib} 没有 RESULT 输出`));
			resolve(JSON.parse(line.slice('RESULT '.length)));
		});
	});
}

const results = { ws2: [], ws: [] };
for (let r = 1; r <= ROUNDS; r++) {
	const order = (r % 2 === 1) ? ['ws2', 'ws'] : ['ws', 'ws2'];
	for (const lib of order) {
		await runWorker(lib, r).then(res => results[lib].push(res), e => console.error('  失败:', e.message));
	}
}

const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
const summarize = (lib) => {
	const list = results[lib];
	if (!list.length) return null;
	return {
		msgsPerSec: Math.round(avg(list.map(x => x.msgsPerSec))),
		mbPerSec: avg(list.map(x => parseFloat(x.mbPerSec))).toFixed(1),
		elapsedMs: Math.round(avg(list.map(x => x.elapsedMs))),
		rssPeakMB: avg(list.map(x => parseFloat(x.rssPeakMB))).toFixed(1),
		heapUsedPeakMB: avg(list.map(x => parseFloat(x.heapUsedPeakMB))).toFixed(1),
		arrayBuffersPeakMB: avg(list.map(x => parseFloat(x.arrayBuffersPeakMB))).toFixed(1),
		rssEndMB: avg(list.map(x => parseFloat(x.rssEndMB))).toFixed(1),
		heapUsedEndMB: avg(list.map(x => parseFloat(x.heapUsedEndMB))).toFixed(1),
	};
};

const sWs2 = summarize('ws2');
const sWs  = summarize('ws');
const ratio = results.ws2[0]?.compressedRatio || '?';

console.log('\n==================================================================');
console.log(`== 多连接压测 (conns=${CONNS}, msgs=${MSGS}×${CONNS}, size=${SIZE}B, window=${WINDOW}, threadpool=${THREADPOOL}, payload=${PAYLOAD}, compress=${COMPRESS}, ws.concurrencyLimit=${WSCC}) ==`);
console.log(`   payload 压缩比 ≈ ${ratio} (越小越可压缩)`);
console.log('==================================================================');
console.log('每轮明细 (msgs/s | RSS峰值MB | heap峰值MB):');
for (let r = 0; r < ROUNDS; r++) {
	const w2 = results.ws2[r], w = results.ws[r];
	if (w2) console.log(`  round${r + 1}  ws2: ${w2.msgsPerSec} msgs/s | ${w2.rssPeakMB}MB | ${w2.heapUsedPeakMB}MB`);
	if (w)  console.log(`  round${r + 1}  ws : ${w.msgsPerSec} msgs/s | ${w.rssPeakMB}MB | ${w.heapUsedPeakMB}MB`);
}
console.log('\n平均:');
if (sWs2) console.log(`  ws2: ${sWs2.msgsPerSec} msgs/s (${sWs2.mbPerSec} MB/s)  RSS峰值 ${sWs2.rssPeakMB}MB  heap峰值 ${sWs2.heapUsedPeakMB}MB  arrayBuffers峰值 ${sWs2.arrayBuffersPeakMB}MB`);
if (sWs)  console.log(`  ws : ${sWs.msgsPerSec} msgs/s (${sWs.mbPerSec} MB/s)  RSS峰值 ${sWs.rssPeakMB}MB  heap峰值 ${sWs.heapUsedPeakMB}MB  arrayBuffers峰值 ${sWs.arrayBuffersPeakMB}MB`);

if (sWs2 && sWs) {
	console.log('\n对比:');
	console.log(`  吞吐 msgs/s : ws2/ws = ${(sWs2.msgsPerSec / sWs.msgsPerSec).toFixed(3)}x`);
	console.log(`  RSS 峰值    : ws2/ws = ${(parseFloat(sWs2.rssPeakMB) / parseFloat(sWs.rssPeakMB)).toFixed(3)}x`);
	console.log(`  heap 峰值   : ws2/ws = ${(parseFloat(sWs2.heapUsedPeakMB) / parseFloat(sWs.heapUsedPeakMB)).toFixed(3)}x`);
	console.log(`  arrayBuffers峰值: ws2/ws = ${(parseFloat(sWs2.arrayBuffersPeakMB) / parseFloat(sWs.arrayBuffersPeakMB)).toFixed(3)}x`);
}

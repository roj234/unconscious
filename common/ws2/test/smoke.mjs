/**
 * shim 冒烟测试: 验证 ws 风格 API 语义 + 与 ws 客户端的互通。
 * 用法: node src/smoke.mjs
 */
import {WebSocket as ShimWebSocket, WebSocketServer} from '../src/ndex.js';
import {WebSocket as WSClient} from 'ws';

let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}${extra ? '  [' + extra + ']' : ''}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${extra ? '  [' + extra + ']' : ''}`);
  }
}

async function startEchoServer(port, options) {
  const wss = new WebSocketServer({ port, ...options });
  wss.on('connection', (ws, req) => {
    ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
    ws.on('error', () => {});
  });
  await new Promise((r) => wss._server.on('listening', r));
  return wss;
}

async function withWsClient(port, deflate, fn) {
  const ws = new WSClient(`ws://127.0.0.1:${port}/`, { perMessageDeflate: deflate });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  await fn(ws);
  ws.close();
  await new Promise((r) => setTimeout(r, 50));
}

async function withShimClient(port, deflate, fn) {
  const ws = new ShimWebSocket(`ws://127.0.0.1:${port}/`, { perMessageDeflate: deflate });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  await fn(ws);
  ws.close(1000, 'done');
  await new Promise((r) => setTimeout(r, 50));
}

console.log('== 1. ws 客户端 -> shim 服务端 (deflate 关) ==');
{
  const port = 32100;
  const wss = await startEchoServer(port, { perMessageDeflate: false });
  await withWsClient(port, false, async (ws) => {
    const textReply = await new Promise((res) => {
      ws.on('message', (d, b) => res({ d: d.toString(), b }));
      ws.send('hello');
    });
    check('文本回声', textReply.d === 'hello' && textReply.b === false, JSON.stringify(textReply));

    const binReply = await new Promise((res) => {
      ws.once('message', (d, b) => res({ len: d.length, b }));
      ws.send(Buffer.from([1, 2, 3]));
    });
    check('二进制回声', binReply.len === 3 && binReply.b === true, JSON.stringify(binReply));
  });
  wss.close();
  await new Promise((r) => setTimeout(r, 100));
}

console.log('== 2. ws 客户端 -> shim 服务端 (deflate 开, 大载荷) ==');
{
  const port = 32101;
  const wss = await startEchoServer(port, { perMessageDeflate: { threshold: 0 } });
  await withWsClient(port, true, async (ws) => {
    const payload = Buffer.alloc(64 * 1024, 0x61);
    const reply = await new Promise((res) => {
      ws.once('message', (d) => res(Buffer.compare(d, payload)));
      ws.send(payload);
    });
    check('16KB 压缩回声一致', reply === 0);
  });
  wss.close();
  await new Promise((r) => setTimeout(r, 100));
}

console.log('== 3. shim 客户端 -> shim 服务端 ==');
{
  const port = 32102;
  const wss = await startEchoServer(port, { perMessageDeflate: false });
  await withShimClient(port, false, async (ws) => {
    const reply = await new Promise((res) => {
      ws.once('message', (d, b) => res({ s: d.toString(), b }));
      ws.send('shim-client-echo');
    });
    check('shim 客户端回声', reply.s === 'shim-client-echo' && reply.b === false, JSON.stringify(reply));

    const openState = ws.readyState;
    check('open 后 readyState=OPEN', openState === ShimWebSocket.OPEN, 'state=' + openState);
  });
  wss.close();
  await new Promise((r) => setTimeout(r, 100));
}

console.log('== 4. close 事件 (客户端主动关闭) ==');
{
  const port = 32103;
  const wss = await startEchoServer(port, { perMessageDeflate: false });
  const closeInfo = await new Promise((res) => {
    wss.once('connection', (ws) => ws.on('close', (code, reason) => res({ code, reason })));
    const ws = new WSClient(`ws://127.0.0.1:${port}/`);
    ws.on('open', () => ws.close(4001, 'bye'));
  });
  check('服务端收到 close(code,reason)', closeInfo.code === 4001 && closeInfo.reason === 'bye', JSON.stringify(closeInfo));
  wss.close();
  await new Promise((r) => setTimeout(r, 100));
}

console.log('== 5. clients 集合跟踪 ==');
{
  const port = 32104;
  const wss = await startEchoServer(port, { perMessageDeflate: false });
  const ws = new WSClient(`ws://127.0.0.1:${port}/`);
  await new Promise((res) => ws.on('open', res));
  await new Promise((r) => setTimeout(r, 100));
  check('connection 时 clients.size=1', wss.clients.size === 1, 'size=' + wss.clients.size);
  ws.close();
  await new Promise((r) => setTimeout(r, 200));
  check('close 后 clients.size=0', wss.clients.size === 0, 'size=' + wss.clients.size);
  wss.close();
  await new Promise((r) => setTimeout(r, 100));
}

console.log('== 6. 子协议协商 ==');
{
  const port = 32105;
  const wss = new WebSocketServer({ port, protocols: ['chat'] });
  wss.on('connection', (ws) => {
    check('协商子协议', ws.protocol === 'chat', 'protocol=' + ws.protocol);
    ws.on('message', (d) => ws.send(d, { binary: false }));
    ws.on('error', () => {});
  });
  await new Promise((r) => wss._server.on('listening', r));
  const ws = new WSClient(`ws://127.0.0.1:${port}/`, ['chat']);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.close();
  await new Promise((r) => setTimeout(r, 100));
  wss.close();
  await new Promise((r) => setTimeout(r, 100));
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

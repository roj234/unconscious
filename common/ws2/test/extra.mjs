// 扩展回归测试: 分片 / ping-pong / sendFragment / 限制 / close 握手 / deflate 协商 / bufferreleased / 边界
// 用法: node test/extra.mjs   (npm run test:extra)
import {WebSocket as ShimWS, WebSocketServer} from '../src/index.js';
import {WebSocket as WSClient} from 'ws';

let passed = 0, failed = 0;
const check = (name, cond, extra = '') => {
  if (cond) { passed++; console.log('  ok  ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  [' + extra + ']' : '')); }
};
const listen = (srv) => new Promise((r) => srv._server.on('listening', r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 1. sendFragment 服务端→ws客户端; partialmessage 服务端接收 ----
console.log('== 1. sendFragment 分片 ==');
{
  const port = 32201;
  const wss = new WebSocketServer({ port, perMessageDeflate: false });
  wss.on('connection', (ws) => {
    // 收到 "frag-me" 后用手动分片回 (不 echo, 避免撞车)
    ws.on('message', (d) => {
      if (d.toString() === 'frag-me') {
        ws.sendFragment(0x1, Buffer.from('hello '), false);
        ws.sendFragment(0x0, Buffer.from('frag '), false);
        ws.sendFragment(0x0, Buffer.from('world'), true);
      }
    });
    ws.on('error', () => {});
  });
  await listen(wss);
  const c = new WSClient(`ws://127.0.0.1:${port}/`);
  await new Promise((res, rej) => { c.on('open', res); c.on('error', rej); });

  const reply = await new Promise((res) => { c.once('message', (d) => res(d.toString())); c.send('frag-me'); });
  check('服务端 sendFragment 3片合并', reply === 'hello frag world', reply);

  // shim 客户端手动分片 → 服务端 partialmessage (先挂 listener 再连接)
  const partials = [];
  const doneP = new Promise((res) => {
    wss.once('connection', (sws) => {
      sws.on('partialmessage', (p, isBinary, isLast) => {
        partials.push([p.toString(), isBinary, isLast]);
        if (isLast) res();
      });
    });
  });
  const sc = new ShimWS(`ws://127.0.0.1:${port}/`, {});
  await new Promise((res, rej) => { sc.on('open', res); sc.on('error', rej); });
  sc.sendFragment(0x1, Buffer.from('shim '), false);
  sc.sendFragment(0x0, Buffer.from('frag'), true);
  await doneP;
  check('shim客户端分片→partialmessage', partials.length === 2 && partials[0][0] === 'shim ' && partials[1][0] === 'frag' && partials[1][2] === true,
    'partials=' + JSON.stringify(partials));
  sc.close(); c.close(); wss.close(); await sleep(100);
}

// ---- 2. ping/pong ----
console.log('== 2. ping/pong ==');
{
  const port = 32202;
  const wss = new WebSocketServer({ port, perMessageDeflate: false });
  wss.on('connection', (ws) => { ws.on('error', () => {}); });
  await listen(wss);

  const c = new WSClient(`ws://127.0.0.1:${port}/`);
  await new Promise((res, rej) => { c.on('open', res); c.on('error', rej); });

  const pong = await new Promise((res) => { c.once('pong', (d) => res(d.toString())); c.ping('hi'); });
  check('ws客户端 ping → 服务端自动 pong', pong === 'hi', pong);

  // 服务端 ping → shim 客户端应自动 pong, 且触发 ping 事件
  const sc = new ShimWS(`ws://127.0.0.1:${port}/`, {});
  await new Promise((res, rej) => { sc.on('open', res); sc.on('error', rej); });
  const gotPing = new Promise((res) => sc.on('ping', (d) => res(d.toString())));
  // 向所有连接发 ping
  wss.clients.forEach((w) => { if (w.readyState === 1) w.ping('svr-ping'); });
  check('shim客户端收到 ping 并自动 pong', (await gotPing) === 'svr-ping');
  sc.close(); c.close(); wss.close(); await sleep(100);
}

// ---- 3. payloadLimit 超限关闭 ----
console.log('== 3. payloadLimit ==');
{
  const port = 32203;
  const wss = new WebSocketServer({ port, maxPayload: 1024, perMessageDeflate: false });
  wss.on('connection', (ws) => { ws.on('error', () => {}); });
  await listen(wss);
  const c = new WSClient(`ws://127.0.0.1:${port}/`);
  const closeInfo = await new Promise((res) => {
    c.on('open', () => c.send(Buffer.alloc(2048)));
    c.on('close', (code, reason) => res({ code, reason }));
  });
  check('超限被服务端 1009 关闭', closeInfo.code === 1009, JSON.stringify(closeInfo));
  wss.close(); await sleep(100);
}

// ---- 4. 服务端主动 close 带 code/reason ----
console.log('== 4. 服务端主动 close ==');
{
  const port = 32204;
  const wss = new WebSocketServer({ port, perMessageDeflate: false });
  wss.on('connection', (ws) => {
    ws.sendClose(1008, 'denied');
    ws.on('error', () => {});
  });
  await listen(wss);
  const c = new WSClient(`ws://127.0.0.1:${port}/`);
  const info = await new Promise((res) => c.on('close', (code, reason) => res({ code, reason })));
  const reasonStr = Buffer.isBuffer(info.reason) ? info.reason.toString() : info.reason;
  check('客户端收到 close(1008,denied)', info.code === 1008 && reasonStr === 'denied', JSON.stringify({ code: info.code, reason: reasonStr }));
  wss.close(); await sleep(100);
}

// ---- 5. 客户端 deflate 配置 (发现 bug 用) ----
console.log('== 5. 客户端 deflate 配置 ==');
{
  const port = 32205;
  const wss = new WebSocketServer({ port, perMessageDeflate: { threshold: 0 } });
  wss.on('connection', (ws) => { ws.on('error', () => {}); });
  await listen(wss);

  // 关
  const c0 = new ShimWS(`ws://127.0.0.1:${port}/`, { perMessageDeflate: false });
  await new Promise((res, rej) => { c0.on('open', res); c0.on('error', rej); });
  check('deflate关闭时 extensions 应为空串', c0.extensions === '', 'extensions=' + JSON.stringify(c0.extensions));
  c0.close(); await sleep(50);

  // 开 (threshold 默认 1024)
  const c1 = new ShimWS(`ws://127.0.0.1:${port}/`, { perMessageDeflate: true });
  await new Promise((res, rej) => { c1.on('open', res); c1.on('error', rej); });
  check('deflate开启时 extensions=permessage-deflate', c1.extensions === 'permessage-deflate', 'extensions=' + JSON.stringify(c1.extensions));
  check('deflate开启时 compressThreshold 应=1024', c1.compressThreshold === 1024, 'compressThreshold=' + c1.compressThreshold);
  c1.close(); wss.close(); await sleep(100);
}

// ---- 6. ArrayBuffer / TypedArray / 空载荷 ----
console.log('== 6. send 类型 ==');
{
  const port = 32206;
  const wss = new WebSocketServer({ port, perMessageDeflate: false });
  wss.on('connection', (ws) => { ws.on('message', (d, b) => ws.send(d, { binary: b })); ws.on('error', () => {}); });
  await listen(wss);
  const c = new ShimWS(`ws://127.0.0.1:${port}/`, {});
  await new Promise((res, rej) => { c.on('open', res); c.on('error', rej); });

  const ab = new Uint8Array([9, 8, 7]).buffer;
  const r1 = await new Promise((res) => { c.once('message', (d, b) => res([Buffer.from(d)[0], b])); c.send(ab); });
  check('ArrayBuffer 发送', r1[0] === 9 && r1[1] === true, JSON.stringify(r1));

  const u8 = new Uint8Array([5, 6]);
  const r2 = await new Promise((res) => { c.once('message', (d, b) => res([Buffer.from(d).length, b])); c.send(u8); });
  check('TypedArray 发送', r2[0] === 2 && r2[1] === true, JSON.stringify(r2));

  const r3 = await new Promise((res) => { c.once('message', (d, b) => res([d.length, b])); c.send(''); });
  check('空字符串发送', r3[0] === 0 && r3[1] === false, JSON.stringify(r3));

  c.close(); wss.close(); await sleep(100);
}

// ---- 7. noServer + handleUpgrade ----
console.log('== 7. noServer + handleUpgrade ==');
{
  const { createServer } = await import('node:http');
  const httpServer = createServer((req, res) => res.end('http'));
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  httpServer.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head));
  const echoP = new Promise((resolve) => {
    wss.on('connection', (ws) => { ws.on('message', (d) => ws.send(d)); ws.on('error', () => {}); resolve(); });
  });
  httpServer.listen(32207);
  await new Promise((r) => httpServer.on('listening', r));
  const c = new ShimWS(`ws://127.0.0.1:32207/`, {});
  await new Promise((res, rej) => { c.on('open', res); c.on('error', rej); });
  await echoP;
  const r = await new Promise((res) => { c.once('message', (d) => res(d.toString())); c.send('upgrade-ok'); });
  check('noServer 模式 echo', r === 'upgrade-ok', r);
  c.close(); wss.close(); httpServer.close(); await sleep(100);
}

// ---- 8. path 过滤 ----
console.log('== 8. path 过滤 ==');
{
  const port = 32208;
  const wss = new WebSocketServer({ port, path: '/ws', perMessageDeflate: false });
  wss.on('connection', (ws) => { ws.on('error', () => {}); });
  await listen(wss);

  const okC = new ShimWS(`ws://127.0.0.1:${port}/ws?x=1`, {});
  let ok = false;
  await new Promise((res, rej) => { okC.on('open', () => { ok = true; res(); }); okC.on('error', rej); });
  check('正确 path 可连接', ok);
  okC.close();

  const badC = new ShimWS(`ws://127.0.0.1:${port}/other`, {});
  const badResult = await Promise.race([
    new Promise((res) => { badC.on('error', () => res('error')); badC.on('open', () => res('open')); }),
    sleep(1500).then(() => 'timeout'),
  ]);
  let termCrash = false;
  try { badC.terminate(); } catch { termCrash = true; }
  check('错误 path 被拒', badResult === 'error', badResult);
  check('未握手 terminate() 不崩溃', !termCrash, termCrash ? 'TypeError: #socket null' : '');
  wss.close(); await sleep(100);
}

// ---- 9. heartbeat ----
console.log('== 9. heartbeat ==');
{
  const port = 32209;
  const wss = new WebSocketServer({ port, perMessageDeflate: false });
  wss.on('connection', (ws) => { ws.on('error', () => {}); });
  await listen(wss);
  const c = new WSClient(`ws://127.0.0.1:${port}/`);
  await new Promise((res, rej) => { c.on('open', res); c.on('error', rej); });
  const srvWs = [...wss.clients][0];
  let gotSrvPing = false;
  c.on('ping', () => { gotSrvPing = true; });
  srvWs.startHeartbeat(100, 400); // 100ms 空闲即发 ping
  await sleep(350);
  check('服务端心跳发出 ping', gotSrvPing);
  check('心跳后连接仍存活', srvWs.readyState === 1, 'state=' + srvWs.readyState);
  srvWs.stopHeartbeat();
  c.close(); wss.close(); await sleep(100);
}

// ---- 10. 非法掩码 (未掩码客户端帧) ----
console.log('== 10. 未掩码帧被拒 ==');
{
  const port = 32210;
  const wss = new WebSocketServer({ port, perMessageDeflate: false });
  wss.on('connection', (ws) => { ws.on('error', () => {}); });
  await listen(wss);
  const net = await import('node:net');
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((r) => sock.on('connect', r));
  // 先完成 HTTP 升级握手
  const key = Buffer.from('dGhlIHNhbXBsZSBub25jZQ==');
  sock.write(
    'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
  );
  await new Promise((r) => { sock.once('data', (d) => { if (d.includes(Buffer.from('101'))) r(); }); });
  // 构造一个未掩码的 text 帧: FIN=1 opcode=1, len=5 (mask 位=0)
  sock.write(Buffer.from([0x81, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f]));
  const closed = await Promise.race([
    new Promise((r) => { sock.on('close', () => r(true)); sock.on('error', () => r(true)); }),
    sleep(2000).then(() => false),
  ]);
  check('未掩码帧导致连接被关闭', closed === true, 'closed=' + closed);
  sock.destroy(); wss.close(); await sleep(100);
}

// ---- 11. WebSocket(url) 不带 options (ws 兼容: 应可用) ----
console.log('== 11. WebSocket(url) 不带 options ==');
{
  const port = 32211;
  const wss = new WebSocketServer({ port, perMessageDeflate: false });
  wss.on('connection', (ws) => { ws.on('error', () => {}); });
  await listen(wss);
  let ok = false, errMsg = '';
  try {
    const c = new ShimWS(`ws://127.0.0.1:${port}/`);
    await new Promise((res, rej) => { c.on('open', res); c.on('error', rej); });
    ok = c.readyState === ShimWS.OPEN;
    c.close();
  } catch (e) { errMsg = e.message; }
  check('不传 options 可连接', ok, errMsg);
  wss.close(); await sleep(100);
}

// ---- 12. bufferreleased 事件 ----
console.log('== 12. bufferreleased ==');
{
  const port = 32212;
  const wss = new WebSocketServer({ port, perMessageDeflate: false, fragmentSize: 100 });
  wss.on('connection', (ws) => {
    ws.on('message', (d) => ws.send(d));
    ws.on('error', () => {});
  });
  await listen(wss);

  // 服务端发送: 大载荷自动分片, 应触发一次 bufferreleased 且携带原始 buffer
  const c = new WSClient(`ws://127.0.0.1:${port}/`);
  await new Promise((res, rej) => { c.on('open', res); c.on('error', rej); });
  const srvWs = [...wss.clients][0];
  const releasedSrv = [];
  srvWs.on('bufferreleased', (b) => releasedSrv.push(b.length));
  const payload = Buffer.alloc(350, 0x62);
  const echo = await new Promise((res) => { c.once('message', (d) => res(d.length)); c.send(payload); });
  await sleep(200);
  check('服务端分片发送触发 bufferreleased', echo === 350 && releasedSrv.length === 1 && releasedSrv[0] === 350,
    'echo=' + echo + ' released=' + JSON.stringify(releasedSrv));

  // 客户端发送: 单帧立即释放 (bufferreleased 是 ws2 特有事件, 用 shim 客户端验证)
  const sc = new ShimWS(`ws://127.0.0.1:${port}/`, {});
  await new Promise((res, rej) => { sc.on('open', res); sc.on('error', rej); });
  const releasedCli = [];
  sc.on('bufferreleased', (b) => releasedCli.push(b.length));
  sc.send(Buffer.alloc(50, 0x63));
  await sleep(100);
  check('客户端发送触发 bufferreleased', releasedCli.length === 1 && releasedCli[0] === 50, JSON.stringify(releasedCli));

  sc.close(); c.close(); wss.close(); await sleep(100);
}

// ---- 13. client_max_window_bits / server_max_window_bits 协商 ----
console.log('== 13. 窗口位协商 ==');
{
  const port = 32213;
  const wss = new WebSocketServer({ port, perMessageDeflate: { threshold: 0 } });
  wss.on('connection', (ws) => {
    check('服务端 inflateWindowBits=8 (client_max_window_bits)', ws.inflateWindowBits === 8, 'bits=' + ws.inflateWindowBits);
    check('服务端 deflateWindowBits=10 (server_max_window_bits)', ws.deflateWindowBits === 10, 'bits=' + ws.deflateWindowBits);
    ws.on('message', (d) => ws.send(d));
    ws.on('error', () => {});
  });
  await listen(wss);

  // ws 客户端: 请求 client_max_window_bits=8, server_max_window_bits=10
  const c = new WSClient(`ws://127.0.0.1:${port}/`, {
    perMessageDeflate: { clientMaxWindowBits: 8, serverMaxWindowBits: 10, threshold: 0 },
  });
  await new Promise((res, rej) => { c.on('open', res); c.on('error', rej); });

  // 小窗口 + 压缩往返必须一致
  const data = Buffer.alloc(64 * 1024, 0x61);
  const ok = await new Promise((res) => { c.once('message', (d) => res(Buffer.compare(d, data) === 0)); c.send(data); });
  check('窗口位协商后压缩回声一致', ok);
  c.close(); wss.close(); await sleep(100);
}

// ---- 14. 无参 ping/pong, 字符串 ping, 握手前 close/terminate ----
console.log('== 14. 无参 ping + 握手前 close/terminate ==');
{
  const port = 32214;
  const wss = new WebSocketServer({ port, perMessageDeflate: false });
  wss.on('connection', (ws) => { ws.on('error', () => {}); });
  await listen(wss);

  // shim 客户端无参 ping + 字符串 ping (服务端自动 pong)
  const sc = new ShimWS(`ws://127.0.0.1:${port}/`, {});
  await new Promise((res, rej) => { sc.on('open', res); sc.on('error', rej); });
  const pongEmpty = await new Promise((res) => { sc.once('pong', (d) => res(d.length)); sc.ping(); });
  const pongStr = await new Promise((res) => { sc.once('pong', (d) => res(d.toString())); sc.ping('hey'); });
  check('无参 ping 得到空 pong', pongEmpty === 0, 'len=' + pongEmpty);
  check('字符串 ping 正常回显', pongStr === 'hey', pongStr);
  sc.close(); await sleep(50);

  // 握手前 close() 不崩溃, 且最终触发 close
  const pre1 = new ShimWS(`ws://127.0.0.1:${port}/`, {});
  const closed1 = new Promise((res) => pre1.on('close', (code) => res(code)));
  pre1.close(4001, 'early');
  const code1 = await Promise.race([closed1, sleep(1500).then(() => 'timeout')]);
  check('握手前 close() 不崩溃且触发 close', code1 === 4001, 'code=' + code1);

  // 握手前 terminate() 不崩溃
  const pre2 = new ShimWS(`ws://127.0.0.1:${port}/`, {});
  const closed2 = new Promise((res) => pre2.on('close', (code) => res(code)));
  pre2.terminate();
  const code2 = await Promise.race([closed2, sleep(1500).then(() => 'timeout')]);
  check('握手前 terminate() 不崩溃且触发 close', code2 === 1006, 'code=' + code2);

  wss.close(); await sleep(100);
}

console.log(`\n结果: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

/**
 * mask 性能基准:
 *   A. 原地(unmask 语义, 接收端): 自定义 mask(buf,0,len,maskInt) vs ws _unmask vs bufferutil.unmask
 *   B. copy+mask(send 语义, ws frame 的做法): 自定义(copy+mask) vs ws _mask vs bufferutil.mask
 * ws 的 buffer-util.js 在有 bufferutil 原生模块时 mask>=48B / unmask>=32B 走原生。
 */
process.env.WS_NO_BUFFER_UTIL = '1';

const maskCustom = (await import('../src/_mask.mjs')).mask;
const wsBufUtil = (await import('../node_modules/ws/lib/buffer-util.js')).default;
const wsMaskJS = wsBufUtil.mask;   // 纯 JS
const wsUnmaskJS = wsBufUtil.unmask; // 纯 JS

// ws 原生版
const native = await import('bufferutil');
const nativeMask = native.mask;
const nativeUnmask = native.unmask;

function bench(name, fn, iters) {
  // 预热
  for (let i = 0; i < Math.min(iters, 20000); i++) fn();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  const ns = Number(process.hrtime.bigint() - t0);
  return ns / iters; // ns/op
}

function fmt(ns) {
  if (ns >= 1e6) return (ns / 1e6).toFixed(3) + ' ms';
  if (ns >= 1e3) return (ns / 1e3).toFixed(2) + ' µs';
  return ns.toFixed(1) + ' ns';
}

const maskBuf = Buffer.from([0x12, 0x34, 0x56, 0x78]);
const maskInt = maskBuf.readUInt32BE(0);

function makeCustomInplace(len) {
  const buf = Buffer.alloc(len, 0xab);
  return () => maskCustom(buf, 0, len, maskInt);
}
function makeWsUnmaskJS(len) {
  const buf = Buffer.alloc(len, 0xab);
  return () => wsUnmaskJS(buf, maskBuf);
}
function makeNativeUnmask(len) {
  const buf = Buffer.alloc(len, 0xab);
  return () => nativeUnmask(buf, maskBuf);
}

// ws send 语义: source 拷到 output 后 mask; 自定义这边等价于 copy 后原地 mask
function makeCustomSend(len) {
  const src = Buffer.alloc(len, 0xab);
  const out = Buffer.alloc(len);
  return () => { out.set(src); maskCustom(out, 0, len, maskInt); };
}
function makeWsMaskJS(len) {
  const src = Buffer.alloc(len, 0xab);
  const out = Buffer.alloc(len);
  return () => wsMaskJS(src, maskBuf, out, 0, len);
}
function makeNativeMask(len) {
  const src = Buffer.alloc(len, 0xab);
  const out = Buffer.alloc(len);
  return () => nativeMask(src, maskBuf, out, 0, len);
}

const sizes = [8, 16, 32, 64, 128, 256, 512, 1024, 16384, 65536];
const itersFor = (len) => Math.max(2000, Math.floor(5e8 / len));

console.log('== A. 原地 mask/unmask(接收端语义) ==');
console.log('size'.padEnd(9) + '自定义'.padStart(12) + 'ws纯JS'.padStart(12) + 'bufferutil原生'.padStart(14) + '自定义/原生'.padStart(13));
for (const len of sizes) {
  const iters = itersFor(len);
  const a = bench('a', makeCustomInplace(len), iters);
  const b = bench('b', makeWsUnmaskJS(len), iters);
  const c = bench('c', makeNativeUnmask(len), iters);
  console.log(
    `${len}B`.padEnd(9) + fmt(a).padStart(12) + fmt(b).padStart(12) + fmt(c).padStart(14) +
    (a / c).toFixed(2).padStart(12) + 'x'
  );
}

console.log('\n== B. copy+mask(send 语义, ws frame 做法) ==');
console.log('size'.padEnd(9) + '自定义(copy+mask)'.padStart(19) + 'ws纯JS'.padStart(12) + 'bufferutil原生'.padStart(14) + '自定义/原生'.padStart(13));
for (const len of sizes) {
  const iters = itersFor(len);
  const a = bench('a', makeCustomSend(len), iters);
  const b = bench('b', makeWsMaskJS(len), iters);
  const c = bench('c', makeNativeMask(len), iters);
  console.log(
    `${len}B`.padEnd(9) + fmt(a).padStart(19) + fmt(b).padStart(12) + fmt(c).padStart(14) +
    (a / c).toFixed(2).padStart(12) + 'x'
  );
}

// 正确性冒烟: 结果必须一致
{
  const len = 100; // 非 4 倍数 + 非对齐偏移
  const src = Buffer.alloc(len, 0xcd);
  const o1 = Buffer.from(src); const o2 = Buffer.from(src); const o3 = Buffer.from(src);
  const o4 = Buffer.from(src); const o5 = Buffer.from(src); const o6 = Buffer.from(src);
  maskCustom(o1, 0, len, maskInt);
  wsUnmaskJS(o2, maskBuf);
  nativeUnmask(o3, maskBuf);
  nativeMask(src, maskBuf, o4, 0, len);
  wsMaskJS(Buffer.from(src), maskBuf, o5, 0, len);
  o6.set(src); maskCustom(o6, 0, len, maskInt);
  const ok = (x, y) => x.equals(y);
  console.log('\n== 正确性 (len=100) ==');
  console.log('自定义  vs ws JS unmask :', ok(o1, o2) ? 'OK' : 'FAIL');
  console.log('自定义  vs 原生 unmask  :', ok(o1, o3) ? 'OK' : 'FAIL');
  console.log('原生mask vs ws JS mask  :', ok(o4, o5) ? 'OK' : 'FAIL');
  console.log('原生mask vs 自定义send  :', ok(o4, o6) ? 'OK' : 'FAIL');
}

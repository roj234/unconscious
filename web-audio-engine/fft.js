/* ============================================================================
 *  fft.js —— 迭代式 radix-2 Cooley-Tukey 复数 FFT（纯 JS，零依赖）
 *
 *  算法与参考实现 FFT.java 完全一致：
 *    · 原位运算（in-place），直接改写传入的 re / im 数组
 *    · 先做位反转置换，再逐级蝶形（halfm = 1,2,4,... N/2）
 *    · 正向旋转角 -π（e^{-iπj/halfm}），逆向 +π；不做 1/N 缩放，
 *      由 ifft() 负责缩放 —— 与 FFT.java 的 fft(data, ±π) / ifft() 一一对应
 *
 *  唯一的差异（不影响数值结果）：位反转索引表和各长度的旋转因子表按 N 缓存复用，
 *  避免同一次渲染里反复算 Math.cos / 位反转。
 *
 *  约定：长度必须是 2 的幂，re.length === im.length。
 * ==========================================================================*/

const tables = new Map();

/** 位反转（低位在前），等效于 Java 的 Integer.reverse(i) >>> (32 - bits) */
function reverseBits(i, bits) {
  let r = 0;
  for (let b = 0; b < bits; b++) { r = (r << 1) | (i & 1); i >>>= 1; }
  return r >>> 0;
}

function tablesFor(n) {
  let t = tables.get(n);
  if (t) return t;
  if (n < 2 || (n & (n - 1)) !== 0) throw new Error(`FFT 长度必须是 2 的幂（收到 ${n}）`);
  const bits = 32 - Math.clz32(n) - 1;                     // log2(n)
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) rev[i] = reverseBits(i, bits);
  const fwd = [], inv = [];
  for (let s = 0; s < bits; s++) {
    const halfm = 1 << s;
    const fre = new Float64Array(halfm), fim = new Float64Array(halfm);
    const ire = new Float64Array(halfm), iim = new Float64Array(halfm);
    for (let j = 0; j < halfm; j++) {
      const a = -Math.PI * j / halfm;                      // 正向角
      fre[j] = Math.cos(a); fim[j] = Math.sin(a);          // e^{-iπj/halfm}
      ire[j] = fre[j];      iim[j] = -fim[j];              // 逆向 = 共轭
    }
    fwd.push({ halfm, re: fre, im: fim });
    inv.push({ halfm, re: ire, im: iim });
  }
  t = { n, bits, rev, fwd, inv };
  tables.set(n, t);
  return t;
}

/** 统计用：本次渲染实际做了多少次变换 / 多少个采样点 */
export const fftStats = { transforms: 0, points: 0, butterflies: 0 };

/**
 * 原位 FFT：X[k] = Σ x[n] · e^{∓2πi/N · kn}
 * @param {Float64Array|Float32Array} re 实部（长度为 2 的幂）
 * @param {Float64Array|Float32Array} im 虚部（与 re 等长）
 * @param {boolean} inverse false = 正向（角 = -π），true = 逆向（角 = +π，不缩放）
 */
export function fft(re, im, inverse = false) {
  const n = re.length;
  if (im.length !== n) throw new Error('fft: re / im 长度不一致');
  const t = tablesFor(n);
  const rev = t.rev;

  // ① 位反转置换
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }

  // ② 逐级蝶形
  const stages = inverse ? t.inv : t.fwd;
  for (let si = 0; si < stages.length; si++) {
    const halfm = stages[si].halfm;
    const wr = stages[si].re, wi = stages[si].im;
    const step = halfm << 1;
    for (let i = 0; i < n; i += step) {
      for (let j = 0; j < halfm; j++) {
        const a = i + j, b = a + halfm;
        const br = re[b], bi = im[b];
        const tr = br * wr[j] - bi * wi[j];
        const ti = br * wi[j] + bi * wr[j];
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr;        im[a] += ti;
      }
    }
  }
  fftStats.transforms++;
  fftStats.points += n;
  fftStats.butterflies += (n / 2) * t.bits;
  return re;
}

/** 原位逆变换（自动缩放 1/N，结果即物理幅度） */
export function ifft(re, im) {
  fft(re, im, true);
  const s = 1 / re.length;
  for (let i = 0; i < re.length; i++) { re[i] *= s; im[i] *= s; }
  return re;
}

/** 便捷包装：对普通数组做一次正向变换，返回 {re, im} */
export function transform(re, im) {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error('长度必须是 2 的幂');
  const R = Float64Array.from(re), I = im ? Float64Array.from(im) : new Float64Array(n);
  fft(R, I, false);
  return { re: R, im: I };
}

/** ≥ n 的最小 2 的幂 */
export function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

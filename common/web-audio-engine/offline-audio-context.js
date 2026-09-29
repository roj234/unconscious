/* ============================================================================
 *  offline-audio-context.js —— 纯 JS 实现的 Web Audio 子集
 *
 *  为什么要它：node的 web-audio-context 存在多个bug，无法正常使用
 *
 *  未实现：实时 AudioContext、PannerNode/Spatial、ChannelSplitter/Merger、MediaStream、PeriodicWave 的 disableNormalization 等
 *  缺陷：通道数上限是立体声（2）。
 *
 *  ── 与规范的三处有意取舍（都在代码里注释了）──────────────────────────────
 *  ① 增益类参数是 a-rate（逐采样包络），滤波器系数按渲染块（128 采样）更新
 *     —— 结果与浏览器内核的差别在 3ms 量级的阶跃，听不出来。
 *  ② 无延时反馈环（gain 直接回灌自己）会被插入一个 128 采样的隐式延时，
 *     这是所有分块引擎的通用做法；有 DelayNode 的反馈环则完全正确
 *     （延时线先出后进，见 DelayNode._renderBlock）。
 *  ③ 调试用的剪枝：每个节点按"最早/最晚可能出声的时间窗"跳过整块计算，
 *     默认开启（一首歌能从 28k 节点降到每块只算正在响的几十个）。
 *     new OfflineAudioContext({ prune: false }) 可以关掉，用于验证剪枝无损。
 *
 * ==========================================================================*/

import {fft, ifft} from './fft.js';

export const RENDER_QUANTUM = 128;
const Q = RENDER_QUANTUM;
const ZERO = new Float32Array(Q);
const SILENT = [ZERO];                              // 单声道静音（共享，只读）
const SILENT2 = [ZERO, ZERO];                       // 立体声静音
const EMPTY_IN = [];                                // 没连线的输入端口（规范：空数组）
const EMPTY_OUT = [];                               // numberOfOutputs = 0 时的输出数组
const INF_WIN = { t0: -Infinity, t1: Infinity };    // 反馈环用的保守窗口

const clampNum = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const dB2lin = (db) => Math.pow(10, db / 20);

/* ==========================================================================
 *  AudioParam —— 值 + 自动化曲线 + 音频速率调制输入
 * ==========================================================================*/
class AudioParam {
  #acc;
  #buf;
  #cacheStart;
  #events;
  #k;
  #lastIdx;
  #seg;
  constructor(context, defaultValue, minValue = -3.4028235e38, maxValue = 3.4028235e38) {
    this.context = context;
    this.defaultValue = defaultValue;
    this.minValue = minValue;
    this.maxValue = maxValue;
    this._intrinsic = defaultValue;
    this.#events = [];                 // 按时间排序的自动化事件
    this._connections = [];            // 连到本参数的音频节点（a-rate 相加）
    this.#buf = null;                  // 逐采样值缓冲（按需分配）
    this.#cacheStart = -1;
    // 逐采样求值用的递推状态
    this.#seg = { kind: 'hold', v: defaultValue, t0: 0 };
    this.#k = 0;
    this.#acc = defaultValue;
    this.#lastIdx = -2;         // 不能是 -1：idx=0 时 idx-1 = -1 会误判成"上一采样已知"
  }

  /* ---------------------------------------------------------- 属性 */
  get value() {
    return this.#events.length ? this._valueAtSlow(this.context.currentTime) : this._intrinsic;
  }
  set value(v) {
    // 规范里 .value = v 等价于 setValueAtTime(v, currentTime)，但同时它也是"固有值"。
    // 这里两种语义兼顾：固有值直接生效（已有自动化曲线仍然会覆盖它），
    // 且不产生自动化事件 —— 这样常量参数走 _block()===null 的快路径
    // （延时的"先出后进"、振荡器的固定频率、增益的标量乘法都靠它）。
    const x = clampNum(Number(v), this.minValue, this.maxValue);
    this._intrinsic = Number.isFinite(x) ? x : this.defaultValue;
    this.#reset();
  }

  /* ------------------------------------------------------ 自动化写入 */
  setValueAtTime(v, t) { this.#add({ type: 'set', time: t, value: v }); return this; }
  linearRampToValueAtTime(v, t) { this.#add({ type: 'ramp', ramp: 'lin', time: t, value: v }); return this; }
  exponentialRampToValueAtTime(v, t) { this.#add({ type: 'ramp', ramp: 'exp', time: t, value: v }); return this; }
  setTargetAtTime(v, t, tc) { this.#add({ type: 'target', time: t, value: v, tc: Math.max(1e-9, tc) }); return this; }
  setValueCurveAtTime(curve, t, dur) {
    const c = Float32Array.from(curve);
    this.#add({ type: 'curve', time: t, value: c, curve: c, dur: Math.max(1e-9, dur) });
    return this;
  }
  cancelScheduledValues(t) {
    this.#events = this.#events.filter((e) => e.time < t);
    this.#reset();
    return this;
  }
  cancelAndHoldAtTime(t) {
    const v = this._valueAtSlow(t);
    this.cancelScheduledValues(t);
    return this.setValueAtTime(v, t);
  }

  #add(e) {
    e.time = Math.max(0, Number(e.time) || 0);
    e.value = typeof e.value === 'number' ? e.value : e.value;
    const ev = this.#events;
    let i = ev.length;
    while (i > 0 && ev[i - 1].time > e.time) i--;
    ev.splice(i, 0, e);
    this.#reset();
  }

  #reset() {
    this.#seg = { kind: 'hold', v: this._intrinsic, t0: 0 };
    this.#k = 0;
    this.#acc = this._intrinsic;
    this.#lastIdx = -2;
    this.#cacheStart = -1;
  }

  /* --------------------------------------------------- 曲线求值（精确） */
  #evalSeg(s, t) {
    switch (s.kind) {
      case 'hold': return s.v;
      case 'linear': {
        const f = (t - s.t0) / (s.t1 - s.t0);
        return f <= 0 ? s.v0 : f >= 1 ? s.v1 : s.v0 + (s.v1 - s.v0) * f;
      }
      case 'exp': {
        if (t <= s.t0) return s.v0;
        if (t >= s.t1) return s.v1;
        const f = (t - s.t0) / (s.t1 - s.t0);
        if (s.v0 <= 0 || s.v1 <= 0) return s.v0 + (s.v1 - s.v0) * f;    // 规范禁止指数穿越 0
        return s.v0 * Math.pow(s.v1 / s.v0, f);
      }
      case 'target': {
        const d = t - s.t0;
        return d <= 0 ? s.v0 : s.v1 + (s.v0 - s.v1) * Math.exp(-d / s.tc);
      }
      case 'curve': {
        const c = s.curve, x = (t - s.t0) / s.dur;
        if (x <= 0) return c[0];
        if (x >= 1) return c[c.length - 1];
        const p = x * (c.length - 1), i = Math.floor(p);
        return c[i] + (c[i + 1] - c[i]) * (p - i);
      }
      default: return s.v;
    }
  }

  /**
   * 处理第 i 个事件之后，参数处于哪一段曲线。
   * 段的定义：从"上一个事件时刻"到"下一个事件时刻"之间如何取值。
   * 下一个事件是 ramp → 本段是斜坡；否则按事件本身的类型（保持 / 指数逼近 / 曲线）。
   */
  #segAfter(prevSeg, i) {
    const ev = this.#events, e = ev[i];
    const vAt = this.#evalSeg(prevSeg, e.time);          // 事件时刻的当前值
    let seg;
    if (e.type === 'set' || e.type === 'ramp') {
      seg = { kind: 'hold', v: e.value, t0: e.time };
    } else if (e.type === 'target') {
      seg = { kind: 'target', t0: e.time, v0: vAt, v1: e.value, tc: e.tc, k: Math.exp(-(1 / this.context.sampleRate) / e.tc) };
    } else if (e.type === 'curve') {
      seg = { kind: 'curve', t0: e.time, curve: e.curve, dur: e.dur };
    } else {
      seg = prevSeg;
    }
    // 下一个事件是斜坡 → 本段就是从本事件时刻出发的斜坡
    const nx = ev[i + 1];
    if (nx && nx.type === 'ramp') {
      const v0 = this.#evalSeg(seg, e.time);
      const span = nx.time - e.time;
      const dt = 1 / this.context.sampleRate;
      if (nx.ramp === 'lin' || span <= 0 || v0 <= 0 || nx.value <= 0) {
        // 规范禁止指数斜坡穿越 0；这里退化成线性，避免 NaN
        seg = { kind: 'linear', t0: e.time, v0, v1: nx.value, t1: nx.time, d: span > 0 ? (nx.value - v0) * dt / span : 0 };
      } else {
        seg = { kind: 'exp', t0: e.time, v0, v1: nx.value, t1: nx.time, r: Math.pow(nx.value / v0, dt / span) };
      }
    }
    return seg;
  }

  /** 从零开始求 t 时刻的值（给 get value() 用，慢但精确，不依赖递推状态） */
  _valueAtSlow(t) {
    const ev = this.#events;
    let seg = { kind: 'hold', v: this._intrinsic, t0: 0 };
    for (let i = 0; i < ev.length && ev[i].time <= t; i++) seg = this.#segAfter(seg, i);
    return clampNum(this.#evalSeg(seg, t), this.minValue, this.maxValue);
  }

  /** 段内递推一步（比每采样调 #evalSeg 快一个数量级） */
  #next(seg, prev, t) {
    switch (seg.kind) {
      case 'hold': return seg.v;
      case 'linear': return prev + seg.d;
      case 'exp': return prev * seg.r;
      case 'target': return seg.v1 + (prev - seg.v1) * seg.k;
      default: return this.#evalSeg(seg, t);            // 自定义曲线：老实查表
    }
  }

  /** 填一个渲染块的逐采样值 */
  #fill(start, len) {
    if (!this.#buf) this.#buf = new Float32Array(Q);
    const b = this.#buf, ev = this.#events;
    if (!ev.length) {
      const v = clampNum(this._intrinsic, this.minValue, this.maxValue);
      b.fill(v, 0, len);
      return b;
    }
    const dt = 1 / this.context.sampleRate;
    const lo = this.minValue, hi = this.maxValue;
    // 默认的极值范围（绝大多数参数都是）→ 逐采样 clamp 可省：clampNum 在范围内恒等
    const noClamp = lo === -3.4028235e38 && hi === 3.4028235e38;
    if (len <= 0) return b;
    const t0 = start * dt, tLast = (start + len - 1) * dt;
    // 把"当前段"一次性推到覆盖 t0 的那一段。
    // 原来是惰性推进，状态与逐采样推进完全一样（t0 就是第一个采样的 t）。
    let moved = false;
    while (this.#k < ev.length && ev[this.#k].time <= t0) {
      this.#seg = this.#segAfter(this.#seg, this.#k);
      this.#k++;
      moved = true;
    }
    if (moved) this.#lastIdx = -2;             // 换段：本块首采样必须精确求值
    const seg0 = this.#seg;
    const nextT = this.#k < ev.length ? ev[this.#k].time : Infinity;
    /* 整块落在一段里（绝大多数块都是）→ 首采样求值 + 段类型紧循环。
       递推公式与 #next 逐字相同，所以结果与逐采样路径逐比特一致。 */
    if (nextT > tLast && seg0.kind !== 'curve') {
      let v = this.#lastIdx === start - 1 ? this.#next(seg0, this.#acc, t0) : this.#evalSeg(seg0, t0);
      switch (seg0.kind) {
        case 'hold': {
          const hv = noClamp ? seg0.v : clampNum(seg0.v, lo, hi);
          b.fill(hv, 0, len);
          break;
        }
        case 'linear': {
          const d = seg0.d, m = len - 1;                 // 末采样单独写，好让 #acc 停在它上面
          if (noClamp) { for (let i = 0; i < m; i++) { b[i] = v; v += d; } b[m] = v; }
          else { for (let i = 0; i < m; i++) { b[i] = clampNum(v, lo, hi); v += d; } b[m] = clampNum(v, lo, hi); }
          break;
        }
        case 'exp': {
          const r = seg0.r, m = len - 1;
          if (noClamp) { for (let i = 0; i < m; i++) { b[i] = v; v *= r; } b[m] = v; }
          else { for (let i = 0; i < m; i++) { b[i] = clampNum(v, lo, hi); v *= r; } b[m] = clampNum(v, lo, hi); }
          break;
        }
        case 'target': {
          const v1 = seg0.v1, k = seg0.k, m = len - 1;
          if (noClamp) { for (let i = 0; i < m; i++) { b[i] = v; v = v1 + (v - v1) * k; } b[m] = v; }
          else { for (let i = 0; i < m; i++) { b[i] = clampNum(v, lo, hi); v = v1 + (v - v1) * k; } b[m] = clampNum(v, lo, hi); }
          break;
        }
        default: v = undefined;
      }
      if (v !== undefined) { this.#acc = v; this.#lastIdx = start + len - 1; return b; }
    }
    for (let i = 0; i < len; i++) {
      const idx = start + i, t = idx * dt;
      while (this.#k < ev.length && ev[this.#k].time <= t) {
        this.#seg = this.#segAfter(this.#seg, this.#k);
        this.#k++;
        this.#lastIdx = -2;                    // 换段：下一个采样必须精确求值
      }
      const seg = this.#seg;
      const v = this.#lastIdx === idx - 1 ? this.#next(seg, this.#acc, t) : this.#evalSeg(seg, t);
      this.#acc = v;
      this.#lastIdx = idx;
      b[i] = clampNum(v, this.minValue, this.maxValue);
    }
    return b;
  }

  /** 一个渲染块的参数值（含 a-rate 调制输入）；恒定参数返回 null（走快路径） */
  _block(start, len) {
    if (this.#cacheStart === start) return this.#buf;
    if (!this.#events.length && !this._connections.length) return null;
    const b = this.#fill(start, len);
    const conns = this._connections;
    for (let i = 0; i < conns.length; i++) {
      const o = conns[i]._getBlock(start, len);
      if (o.length < 2) { const s = o[0]; for (let j = 0; j < len; j++) b[j] += s[j]; }
      else { const s0 = o[0], s1 = o[1]; for (let j = 0; j < len; j++) b[j] += (s0[j] + s1[j]) * 0.5; }
    }
    this.#cacheStart = start;
    return b;
  }

  /** 恒定参数（无自动化、无调制）→ DSP 可以只读一个数 */
  #isConstant() { return !this.#events.length && !this._connections.length; }
}

/* ==========================================================================
 *  InputHist —— 卷积节点保存输入历史用的环形缓冲
 *  按"绝对采样位置"读写，早于 0 的位置读出来是 0。
 * ==========================================================================*/
class InputHist {
  constructor(len) { this.n = len; this.d = new Float32Array(len); this.end = 0; }

  push(src, start, len) {
    const d = this.d, n = this.n;
    let w = ((start % n) + n) % n;
    for (let i = 0; i < len; i++) { d[w] = src[i]; if (++w === n) w = 0; }
    this.end = start + len;
  }

  /** 读 [a, b) 到 dest[off..]，a 可以是负数（补 0） */
  read(a, b, dest, off) {
    const n = this.n, d = this.d;
    if (a < 0) {
      const pad = Math.min(b, 0) - a;
      for (let i = 0; i < pad; i++) dest[off + i] = 0;
      a = 0; off += pad;
    }
    if (b <= a) return;
    let r = a % n;
    const len = b - a;
    const first = Math.min(len, n - r);
    dest.set(d.subarray(r, r + first), off);
    if (len > first) dest.set(d.subarray(0, len - first), off + first);
  }
}

/* ==========================================================================
 *  AudioNode —— 拉取式渲染的基类
 *  每个渲染块里，节点最多计算一次（结果缓存），下游通过 _getBlock 取用。
 * ==========================================================================*/
class AudioNode {
  #active;
  #in;
  #ochBusy;
  #out;
  #rendering;
  #sched;
  #si;
  #tmp;
  #win;
  #winBusy;
  constructor(context, channelCount = 1) {
    this.context = context;
    this.numberOfInputs = 1;
    this.numberOfOutputs = 1;
    this.channelCount = channelCount;
    this.channelCountMode = 'max';
    this.channelInterpretation = 'speakers';
    this._sources = [];        // 上游节点（与 _srcOut/_srcIn 平行，下标一一对应）
    this._srcOut = [];         // 每条连线取上游的哪个输出端口
    this._srcIn = [];          // 每条连线送进本节点的哪个输入端口（仅多端口节点用）
    this._outputs = [];        // 下游节点 / AudioParam（disconnect 用）
    this._cache = null;
    this.#rendering = false;
    this.#out = null;
    this.#in = null;
    this.#tmp = null;
    this._tail = 0;            // 输入停后还能响多久（秒），用于剪枝窗口
    this.#win = null;
    this.#winBusy = false;
    this.#sched = null;        // 按 t0 排序的上游
    this.#si = 0;
    this.#active = [];         // 当前有声的上游
  }

  /* ----------------------------------------------------------- 连接 */
  /**
   * connect(dest[, outputIndex[, inputIndex]])
   *   outputIndex 选"本节点"的第几个输出端口（默认 0；只有多输出节点有意义）
   *   inputIndex  选"目标节点"的第几个输入端口（默认 0；只有多输入节点有意义）
   */
  connect(dest, outputIndex = 0, inputIndex = 0) {
    if (dest instanceof AudioParam) {
      this._outputs.push(dest);
      dest._connections.push(this);
    } else if (dest instanceof AudioNode) {
      this._outputs.push(dest);
      dest._addSource(this, outputIndex >>> 0, inputIndex >>> 0);
    } else {
      throw new TypeError('connect(): 目标必须是 AudioNode 或 AudioParam');
    }
    return dest;
  }

  _addSource(src, out = 0, inp = 0) {
    this._sources.push(src);
    this._srcOut.push(out);
    this._srcIn.push(inp);
    this._clearChannels();
  }

  disconnect(dest, outputIndex, inputIndex) {
    const drop = (d, out, inp) => {
      if (d instanceof AudioParam) {
        const i = d._connections.indexOf(this); if (i >= 0) d._connections.splice(i, 1);
      } else if (d instanceof AudioNode) {
        // 按"原始下标"找匹配的连线；给了 out/in 就一并匹配（多端口才用得上）
        let i = -1;
        for (let k = 0; k < d._sources.length; k++) {
          if (d._sources[k] !== this) continue;
          if (out !== undefined && d._srcOut[k] !== out) continue;
          if (inp !== undefined && d._srcIn[k] !== inp) continue;
          i = k; break;
        }
        if (i >= 0) { d._sources.splice(i, 1); d._srcOut.splice(i, 1); d._srcIn.splice(i, 1); }
        d._clearChannels();
      }
      this.#sched = null; this.#si = 0; this.#active.length = 0;
    };
    if (dest === undefined) { for (const d of this._outputs.slice()) drop(d); this._outputs.length = 0; return; }
    drop(dest, outputIndex, inputIndex);
    const i = this._outputs.indexOf(dest); if (i >= 0) this._outputs.splice(i, 1);
  }

  /* ------------------------------------------------- 出声时间窗（剪枝） */
  /**
   * [t0, t1] = 该节点可能输出非零信号的绝对时间范围。
   * 源节点按 start/stop 给；处理节点 = 上游窗口的并集 + 自身拖尾 _tail。
   * 反馈环（无延时）由 #winBusy 兜底成 (-Inf, +Inf)，只会更保守，不会漏声。
   */
  _window() {
    if (this.#win) return this.#win;
    if (this.#winBusy) return INF_WIN;
    this.#winBusy = true;
    let t0 = Infinity, t1 = -Infinity;
    const srcs = this._sources;
    for (let i = 0; i < srcs.length; i++) {
      const w = srcs[i]._window();
      if (w.t0 < t0) t0 = w.t0;
      if (w.t1 > t1) t1 = w.t1;
    }
    const own = this._windowSelf();
    if (own) { if (own.t0 < t0) t0 = own.t0; if (own.t1 > t1) t1 = own.t1; }
    if (t1 !== -Infinity) t1 += this._tail;
    this.#win = { t0, t1 };
    this.#winBusy = false;
    return this.#win;
  }

  /** 源节点覆盖这个方法返回自己的发声窗口 */
  _windowSelf() { return null; }

  #covers(start, len) {
    const w = this._window();
    const sr = this.context.sampleRate;
    // 关键：窗口和"块"只要有任何重叠就得算。
    // 只看块首会漏掉"音头落在块中间"的那种块（第一个块整个被跳过）。
    return (start + len) / sr >= w.t0 && start / sr <= w.t1;
  }

  /* ----------------------------------------------------------- 渲染 */
  /**
   * outIdx 只在"多输出节点"（目前是 AudioWorkletNode）上有意义：默认 0。
   * 单输出节点走的是 `outIdx===0 ? c.data : ...` 的同一分支，与以前逐比特一致。
   */
  _getBlock(start, len, outIdx = 0) {
    const c = this._cache;
    if (c !== null && c.start === start) return outIdx === 0 ? c.data : this._output(start, outIdx);
    if (this.context._prune && !this.#covers(start, len)) {
      const z = this.channelCount > 1 ? SILENT2 : SILENT;
      this._cache = { start, len, data: z };
      return outIdx === 0 ? z : SILENT;
    }
    if (this.#rendering) {
      // 无延时反馈环：退化成 1 个渲染块的延时（分块引擎的通用做法）
      return this.channelCount > 1 ? SILENT2 : SILENT;
    }
    this.#rendering = true;
    let data;
    try { data = this._renderBlock(start, len); } finally { this.#rendering = false; }
    this._cache = { start, len, data };
    return outIdx === 0 ? data : this._output(start, outIdx);
  }

  /** 多输出节点的第 outIdx 路输出；单输出节点不会被问到 */
  _output(start, outIdx) { return SILENT; }

  /** 默认行为：把上游混起来直接当输出 */
  _renderBlock(start, len) { return this._inputBlock(start, len); }

  #maybeSched() {
    if (this.#sched) return this.#sched;
    const srcs = this._sources, arr = [];
    for (let i = 0; i < srcs.length; i++) {
      const w = srcs[i]._window();
      if (w.t1 < 0 || w.t0 > 1e12) continue;            // 永不出声的上游：直接丢掉
      arr.push({ t0: w.t0, t1: w.t1, idx: i, node: srcs[i], out: this._srcOut[i] });
    }
    arr.sort((a, b) => a.t0 - b.t0);
    this.#active.length = 0;
    this.#si = 0;
    this.#sched = arr;
    return arr;
  }

  /** 输入通道数（1 或 2）= 上游输出通道数的最大值，静态、与剪枝无关 */
  _inChannels() {
    if (this._ich !== undefined) return this._ich;
    let n = 1;
    for (let i = 0; i < this._sources.length; i++) {
      const k = this._sources[i]._outChannels(this._srcOut[i]);
      if (k > n) n = k;
    }
    this._ich = Math.min(2, n);
    return this._ich;
  }

  /**
   * 输出通道数（默认与输入相同；StereoPanner/Convolver/目标节点各自覆盖）。
   * 这一点很关键 —— 如果按"当前块实际取到的缓冲长度"来定通道数，
   * 被剪枝的上游只会返回单声道静音，立体声链会被误判成单声道（能量直接减半）。
   */
  _outChannels() {
    if (this._och !== undefined) return this._och;
    if (this.#ochBusy) return 1;                    // 反馈环兜底
    this.#ochBusy = true;
    this._och = this._inChannels();
    this.#ochBusy = false;
    return this._och;
  }

  _clearChannels() {
    // 图里可能有反馈环，必须带 visited 迭代而不是递归
    const seen = new Set();
    const stack = [this];
    while (stack.length) {
      const n = stack.pop();
      if (seen.has(n)) continue;
      seen.add(n);
      n._och = undefined;
      n._ich = undefined;
      n._convOut = undefined;
      const outs = n._outputs;
      for (let i = 0; i < outs.length; i++) if (outs[i] instanceof AudioNode) stack.push(outs[i]);
    }
  }

  /** 把上游按“当前有声”混成一个块 */
  _inputBlock(start, len) {
    const srcs = this._sources;
    const nch = this._inChannels();
    if (!srcs.length) return nch > 1 ? SILENT2 : SILENT;
    const sr = this.context.sampleRate;
    const t = start / sr, tEnd = (start + len) / sr;
    let list;
    if (this.context._prune && !this.context._noActiveList) {
      const sched = this.#maybeSched();
      // 与当前块重叠的上游才算"在场"：音头落在块中间的那一块也要拉进来
      while (this.#si < sched.length && sched[this.#si].t0 <= tEnd) {
        const e = sched[this.#si++];
        // 按"在 _sources 里的原始顺序"插入，让求和顺序与不剪枝时完全一致
        // （这样开/关剪枝的结果能逐比特相同，验证起来干净）
        const act = this.#active;
        let lo = 0, hi = act.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (act[mid].idx < e.idx) lo = mid + 1; else hi = mid; }
        act.splice(lo, 0, e);
      }
      const act = this.#active;
      let w = 0;
      for (let i = 0; i < act.length; i++) if (act[i].t1 >= t) act[w++] = act[i];
      act.length = w;
      list = act;
    } else {
      list = srcs;
    }
    const tmp = this.#tmp || (this.#tmp = []);
    let nb = 0;
    if (list === srcs) {
      for (let i = 0; i < list.length; i++) tmp[nb++] = list[i]._getBlock(start, len, this._srcOut[i]);
    } else {
      for (let i = 0; i < list.length; i++) tmp[nb++] = list[i].node._getBlock(start, len, list[i].out);
    }
    /* 只有一路上游、通道数又正好相同 → 直接把它的块当输入（零拷贝）。
       上游的块在同一个渲染块里不会再被写，而下游本来就只读输入
       （被剪枝的上游返回的共享静音缓冲也是只读的，惯例一致）。 */
    if (nb === 1 && tmp[0].length === nch) return tmp[0];
    if (nb === 0) return nch > 1 ? SILENT2 : SILENT;
    const out = this.#inFor(nch, len);
    for (let i = 0; i < nb; i++) mixInto(out, tmp[i], len);
    return out;
  }

  /** 复用的输出 / 输入缓冲（避免每个渲染块分配内存） */
  #bufs(arr, nch, len) {
    if (arr.length !== nch) { arr.length = 0; for (let c = 0; c < nch; c++) arr.push(new Float32Array(Q)); }
    for (let c = 0; c < nch; c++) arr[c].fill(0, 0, len);
    return arr;
  }
  _outFor(nch, len) { if (!this.#out) this.#out = []; return this.#bufs(this.#out, nch, len); }
  #inFor(nch, len) { if (!this.#in) this.#in = []; return this.#bufs(this.#in, nch, len); }
}

/** 把一个块的 src（1~2 声道）混合进 dst（nch 声道） */
function mixInto(dst, src, len) {
  const dn = dst.length, sn = src.length;
  if (sn === 1) {
    const s = src[0];
    if (dn === 1) { const d = dst[0]; for (let i = 0; i < len; i++) d[i] += s[i]; }
    else { const d0 = dst[0], d1 = dst[1]; for (let i = 0; i < len; i++) { const v = s[i]; d0[i] += v; d1[i] += v; } }
  } else if (dn === 1) {
    const s0 = src[0], s1 = src[1], d = dst[0];
    for (let i = 0; i < len; i++) d[i] += (s0[i] + s1[i]) * 0.5;
  } else {
    for (let c = 0; c < dn; c++) {
      const s = src[Math.min(c, sn - 1)], d = dst[c];
      for (let i = 0; i < len; i++) d[i] += s[i];
    }
  }
}

/* ---------------------------------------------------------------------------
 * 内置波形：Chromium 风格的带限波表
 *   · 每个八度一张 4096 点表，谐波数按该八度最高基频截断到奈奎斯特（不混叠）
 *   · 读取用线性插值 —— 浏览器也是这么做的，插值带来的高频自然滚降就是参照物的样子
 *   · 表用 IFFT 合成：把 spec 里四个内置波形的正弦级数系数直接填进频谱
 * 之前用 polyBLEP 解析波形：数学上更"干净"，但 2kHz 以上比浏览器亮 2~3dB，
 * 和 晨光_Morning-Light (1).wav 的频段对不上，所以换成和浏览器同一套做法。
 * ------------------------------------------------------------------------- */
const TABLE_N = 4096;
const tableCache = new Map();

/** 四个内置波形的正弦级数系数 b_k：x(φ) = Σ b_k·sin(2πkφ)（φ=0 处为 0，正弦相位） */
function harmonicAmp(type, k) {
  switch (type) {
    case 'sine': return k === 1 ? 1 : 0;
    case 'square': return (k & 1) ? 4 / (Math.PI * k) : 0;
    case 'sawtooth': return (2 / (Math.PI * k)) * ((k & 1) ? 1 : -1);
    case 'triangle': return (k & 1) ? (8 / (Math.PI * Math.PI * k * k)) * ((((k - 1) >> 1) & 1) ? -1 : 1) : 0;
    default: return 0;
  }
}

/** 用 IFFT 合成一张表：只填 k ≤ maxH 的谐波 */
function buildWavetable(amp, maxH) {
  const N = TABLE_N;
  const re = new Float64Array(N), im = new Float64Array(N);
  const kMax = Math.min(maxH, N / 2 - 1);
  for (let k = 1; k <= kMax; k++) {
    const b = amp(k);
    if (b === 0) continue;
    im[k] = -(N / 2) * b;          // 逆变换：x[n] = (1/N)Σ X[k]e^{+i…}
    im[N - k] = (N / 2) * b;
  }
  ifft(re, im);
  const t = new Float32Array(N + 1);
  for (let i = 0; i < N; i++) t[i] = re[i];
  t[N] = t[0];
  return t;
}

/** 按基频选八度表（同八度共表：与浏览器一致，也避免每个音重建表） */
function tableFor(type, f, sr) {
  const band = Math.max(0, Math.min(14, Math.floor(Math.log2(Math.max(f, 1e-3) / 8.1758))));
  const key = `${type}:${band}`;
  let t = tableCache.get(key);
  if (t) return t;
  const fTop = 8.1758 * Math.pow(2, band + 1);           // 该八度的最高基频
  const maxH = Math.max(1, Math.floor(sr / 2 / fTop));   // 该八度统一的谐波上限
  t = buildWavetable((k) => harmonicAmp(type, k), maxH);
  tableCache.set(key, t);
  return t;
}

/** 线性插值读表（表尾补了 t[N]=t[0]，所以不用判环绕） */
function sampleTable(t, p) {
  const x = p * TABLE_N;
  const i = x | 0;
  const f = x - i;
  return t[i] + (t[i + 1] - t[i]) * f;
}

/* ==========================================================================
 *  AudioDestinationNode —— 渲染的终点，把所有上游混成 numberOfChannels 声道
 * ==========================================================================*/
class AudioDestinationNode extends AudioNode {
  constructor(context, numberOfChannels) {
    super(context, numberOfChannels);
    this.numberOfOutputs = 0;
    this.maxChannelCount = numberOfChannels;
  }
  _outChannels() { return this.channelCount; }
  _renderBlock(start, len) {
    const inp = this._inputBlock(start, len);
    const out = this._outFor(this.channelCount, len);
    mixInto(out, inp, len);
    return out;
  }
}

/* ==========================================================================
 *  GainNode
 * ==========================================================================*/
class GainNode extends AudioNode {
  constructor(context) { super(context, 1); this.gain = new AudioParam(context, 1); }

  _renderBlock(start, len) {
    const inp = this._inputBlock(start, len), nch = inp.length;
    const out = this._outFor(nch, len);
    const gb = this.gain._block(start, len);
    const g0 = gb ? 0 : this.gain._intrinsic;
    for (let c = 0; c < nch; c++) {
      const s = inp[c], d = out[c];
      if (gb) for (let i = 0; i < len; i++) d[i] = s[i] * gb[i];
      else for (let i = 0; i < len; i++) d[i] = s[i] * g0;
    }
    return out;
  }
}

/* ==========================================================================
 *  OscillatorNode（含 PeriodicWave）
 * ==========================================================================*/
class OscillatorNode extends AudioNode {
  #imag;
  #phase;
  #real;
  constructor(context) {
    super(context, 1);
    this.type = 'sine';
    this.frequency = new AudioParam(context, 440, -context.sampleRate / 2, context.sampleRate / 2);
    this.detune = new AudioParam(context, 0, -153600, 153600);
    this.#phase = 0;
    this._start = Infinity;
    this._stop = Infinity;
    this.#real = null;
    this.#imag = null;
  }

  setPeriodicWave(w) { this.#real = w.real; this.#imag = w.imag; this.type = 'custom'; }
  start(when = 0) { this._start = Math.max(0, Number(when) || 0); if (!isFinite(this._stop)) this._stop = Infinity; }
  stop(when = 0) { this._stop = Math.max(this._start, Math.max(0, Number(when) || 0)); }

  _windowSelf() { return isFinite(this._start) ? { t0: this._start, t1: this._stop } : null; }

  /** 自定义波形（PeriodicWave）也走同一套带限波表：按八度缓存 */
  #customTable(f, sr) {
    const band = Math.max(0, Math.min(14, Math.floor(Math.log2(Math.max(f, 1e-3) / 8.1758))));
    const key = `custom:${band}:${this.#real.length}:${this.#imag.length}`;
    let t = tableCache.get(key);
    if (t) return t;
    const real = this.#real, imag = this.#imag;
    const amp = (k) => (imag[k] || 0) + (real[k] || 0) * 0;      // 只取正弦分量（够用）
    const fTop = 8.1758 * Math.pow(2, band + 1);
    t = buildWavetable(amp, Math.max(1, Math.floor(sr / 2 / fTop)));
    tableCache.set(key, t);
    return t;
  }


  _renderBlock(start, len) {
    const sr = this.context.sampleRate;
    // 起始/停止采样一律用 ceil：规范里是"第一个 t ≥ startTime 的采样"。
    // 用 round 会让某些音符的第一个出声采样比包络的首个自动化事件早一个采样
    // —— 那一采样被积乘的是参数的固有值（gain 是 1！），就是一次单采样爆音。
    const s0 = Math.ceil(this._start * sr), s1 = Math.ceil(this._stop * sr);
    if (!isFinite(this._start) || start + len <= s0 || start >= s1) return SILENT;
    const out = this._outFor(1, len), o = out[0];
    const fb = this.frequency._block(start, len), db = this.detune._block(start, len);
    const f0 = this.frequency._intrinsic, d0 = this.detune._intrinsic;
    const type = this.type, dt = 1 / sr;
    // 波表按块首的基频选（同一八度共表，跨八度就换表 —— 和浏览器一样按渲染块切换）
    const fPick = fb ? fb[0] : f0;
    const table = type === 'custom' ? this.#customTable(fPick, sr) : tableFor(type, fPick, sr);
    let ph = this.#phase;
    // 本块真正出声的采样区间（原来靠逐采样 continue，区间外相位都不推进，等价）
    const i0 = Math.max(0, s0 - start), i1 = Math.min(len, s1 - start);
    if (fb === null && db === null) {
      /* 频率/失谐都是常量（最常见）→ 整块只有一个相位增量，
         省掉每采样的两次 clamp 和一次 Math.pow。算式与原来逐字相同，只是提到循环外。 */
      const freq = clampNum(clampNum(f0, -sr / 2, sr / 2) * Math.pow(2, d0 / 1200), -sr / 2, sr / 2);
      const inc = freq * dt;
      for (let i = i0; i < i1; i++) {
        o[i] = sampleTable(table, ph);
        ph += inc;
        if (ph >= 1 || ph < 0) ph -= Math.floor(ph);
      }
    } else if (db === null) {
      const p2 = Math.pow(2, d0 / 1200);          // 失谐恒定：把 pow 提到循环外
      for (let i = i0; i < i1; i++) {
        const freq = clampNum(clampNum(fb[i], -sr / 2, sr / 2) * p2, -sr / 2, sr / 2);
        o[i] = sampleTable(table, ph);
        ph += freq * dt;
        if (ph >= 1 || ph < 0) ph -= Math.floor(ph);
      }
    } else {
      for (let i = i0; i < i1; i++) {
        const f = clampNum(fb ? fb[i] : f0, -sr / 2, sr / 2);
        const det = db[i];
        const freq = clampNum(f * Math.pow(2, det / 1200), -sr / 2, sr / 2);
        o[i] = sampleTable(table, ph);
        ph += freq * dt;
        if (ph >= 1 || ph < 0) ph -= Math.floor(ph);
      }
    }
    this.#phase = ph;
    return out;
  }
}

/* ==========================================================================
 *  ConstantSourceNode
 * ==========================================================================*/
class ConstantSourceNode extends AudioNode {
  constructor(context) {
    super(context, 1);
    this.offset = new AudioParam(context, 1);
    this._start = Infinity;
    this._stop = Infinity;
  }
  start(when = 0) { this._start = Math.max(0, Number(when) || 0); }
  stop(when = 0) { this._stop = Math.max(this._start, Math.max(0, Number(when) || 0)); }
  _windowSelf() { return isFinite(this._start) ? { t0: this._start, t1: this._stop } : null; }

  _renderBlock(start, len) {
    const sr = this.context.sampleRate;
    const s0 = Math.ceil(this._start * sr), s1 = Math.ceil(this._stop * sr);
    if (!isFinite(this._start) || start + len <= s0 || start >= s1) return SILENT;
    const out = this._outFor(1, len), o = out[0];
    const ob = this.offset._block(start, len), v0 = this.offset._intrinsic;
    for (let i = 0; i < len; i++) {
      const idx = start + i;
      if (idx < s0 || idx >= s1) continue;
      o[i] = ob ? ob[i] : v0;
    }
    return out;
  }
}

/* ==========================================================================
 *  AudioBufferSourceNode —— 支持 loop / playbackRate / detune
 * ==========================================================================*/
class AudioBufferSourceNode extends AudioNode {
  #ended;
  #started;
  constructor(context) {
    super(context, 1);
    this.buffer = null;
    this.loop = false;
    this.loopStart = 0;
    this.loopEnd = 0;
    this.playbackRate = new AudioParam(context, 1);
    this.detune = new AudioParam(context, 0, -153600, 153600);
    this._start = Infinity;
    this._stop = Infinity;
    this._pos = 0;
    this.#started = false;
    this.#ended = false;
  }
  _outChannels() { return this.buffer ? Math.min(2, this.buffer.numberOfChannels) : 1; }
  start(when = 0, offset = 0, duration) {
    this._start = Math.max(0, Number(when) || 0);
    this._pos = Math.max(0, Number(offset) || 0) * this.context.sampleRate;
    if (duration !== undefined) this._stop = this._start + Number(duration);
    this.#started = true;
  }
  stop(when = 0) { this._stop = Math.max(this._start, Math.max(0, Number(when) || 0)); }
  _windowSelf() { return this.#started && this.buffer ? { t0: this._start, t1: this._stop } : null; }

  _renderBlock(start, len) {
    const buf = this.buffer;
    const sr = this.context.sampleRate;
    const s0 = Math.ceil(this._start * sr), s1 = Math.ceil(this._stop * sr);
    if (!buf || start + len <= s0 || start >= s1) return SILENT;
    const nch = Math.min(2, buf.numberOfChannels);
    const out = this._outFor(nch, len);
    const L = buf.length;
    const d0 = buf.getChannelData(0);
    const d1 = nch > 1 ? buf.getChannelData(1) : d0;
    const rb = this.playbackRate._block(start, len), db = this.detune._block(start, len);
    const r0 = this.playbackRate._intrinsic, t0v = this.detune._intrinsic;
    const loop = this.loop;
    const ls = Math.max(0, this.loopStart) * sr;
    const le = (this.loopEnd > 0 ? this.loopEnd : buf.duration) * sr;
    let pos = this._pos;
    // 失谐恒定时把 Math.pow(2, x/1200) 提到循环外
    const p2 = db === null ? Math.pow(2, t0v / 1200) : 0;
    for (let i = 0; i < len; i++) {
      const idx = start + i;
      if (idx < s0 || idx >= s1) continue;      // 起音前不推进读指针
      const rate = db === null
        ? (rb ? rb[i] : r0) * p2
        : (rb ? rb[i] : r0) * Math.pow(2, db[i] / 1200);
      let p = pos;
      if (loop && le > ls + 1) {
        const span = le - ls;
        if (p >= le || p < ls) p = ls + ((p - ls) % span + span) % span;
      }
      if (p >= 0 && p < L) {
        const i0 = p | 0;
        const i1 = i0 + 1 < L ? i0 + 1 : L - 1;
        const fr = p - i0;
        out[0][i] = d0[i0] * (1 - fr) + d0[i1] * fr;
        if (nch > 1) out[1][i] = d1[i0] * (1 - fr) + d1[i1] * fr;
      } else if (!loop) {
        this.#ended = true;
        break;                                        // 非循环且放完了
      }
      pos += rate;
    }
    this._pos = pos;
    return out;
  }
}

/* ==========================================================================
 *  BiquadFilterNode —— RBJ Audio EQ Cookbook 系数
 *  a-rate 参数按渲染块取块首值更新系数（128 采样 = 2.9ms 一步，
 *  比浏览器内核的差别在听感上不可辨）。
 * ==========================================================================*/
const BIQUAD_TYPES = new Set(['lowpass', 'highpass', 'bandpass', 'lowshelf', 'highshelf',
  'peaking', 'notch', 'allpass']);

class BiquadFilterNode extends AudioNode {
  #cf;
  #coef;
  #cs;
  #z;
  constructor(context) {
    super(context, 1);
    this.type = 'lowpass';
    this.frequency = new AudioParam(context, 350, 0, context.sampleRate / 2);
    this.detune = new AudioParam(context, 0, -153600, 153600);
    this.Q = new AudioParam(context, 1);
    this.gain = new AudioParam(context, 0);
    this.#z = [];                      // 每通道 [z1, z2]
    this._tail = 0.5;                  // 输出停后滤波器还能振一会儿
    this.#coef = null;
  }

  /** 把一组系数写进 dst[off..off+4]（避免每次分配对象） */
  #coefsInto(dst, off, f, Q, gainDb) {
    const sr = this.context.sampleRate;
    const w0 = 2 * Math.PI * clampNum(f, 1e-3, sr * 0.49) / sr;
    const cw = Math.cos(w0), sw = Math.sin(w0);
    const alpha = sw / (2 * Math.max(1e-4, Q));
    const A = Math.pow(10, gainDb / 40);
    let b0, b1, b2, a0, a1, a2;
    switch (this.type) {
      case 'lowpass': b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
      case 'highpass': b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
      case 'bandpass': b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
      case 'notch': b0 = 1; b1 = -2 * cw; b2 = 1; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
      case 'allpass': b0 = 1 - alpha; b1 = -2 * cw; b2 = 1 + alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
      case 'peaking': b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
        a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; break;
      case 'lowshelf': {
        const sa = sw / 2 * Math.SQRT2, sA = Math.sqrt(A);
        b0 = A * ((A + 1) - (A - 1) * cw + 2 * sA * sa);
        b1 = 2 * A * ((A - 1) - (A + 1) * cw);
        b2 = A * ((A + 1) - (A - 1) * cw - 2 * sA * sa);
        a0 = (A + 1) + (A - 1) * cw + 2 * sA * sa;
        a1 = -2 * ((A - 1) + (A + 1) * cw);
        a2 = (A + 1) + (A - 1) * cw - 2 * sA * sa;
        break;
      }
      case 'highshelf': {
        const sa = sw / 2 * Math.SQRT2, sA = Math.sqrt(A);
        b0 = A * ((A + 1) + (A - 1) * cw + 2 * sA * sa);
        b1 = -2 * A * ((A - 1) + (A + 1) * cw);
        b2 = A * ((A + 1) + (A - 1) * cw - 2 * sA * sa);
        a0 = (A + 1) - (A - 1) * cw + 2 * sA * sa;
        a1 = 2 * ((A - 1) - (A + 1) * cw);
        a2 = (A + 1) - (A - 1) * cw - 2 * sA * sa;
        break;
      }
      default: b0 = 1; b1 = 0; b2 = 0; a0 = 1; a1 = 0; a2 = 0;
    }
    if (!Number.isFinite(a0) || Math.abs(a0) < 1e-20) { dst[off] = 1; dst[off + 1] = 0; dst[off + 2] = 0; dst[off + 3] = 0; dst[off + 4] = 0; return; }
    dst[off] = b0 / a0; dst[off + 1] = b1 / a0; dst[off + 2] = b2 / a0; dst[off + 3] = a1 / a0; dst[off + 4] = a2 / a0;
  }

  _renderBlock(start, len) {
    const inp = this._inputBlock(start, len), nch = inp.length;
    const out = this._outFor(nch, len);
    if (!BIQUAD_TYPES.has(this.type)) this.type = 'lowpass';
    const fA = this.frequency._block(start, len), qA = this.Q._block(start, len);
    const gA = this.gain._block(start, len), dA = this.detune._block(start, len);
    // 参数被自动化/调制时每 16 采样重算一次系数（Chromium 是逐采样；这里换个折中：
    // 够准，又不必每个采样做三角函数）。纯常量参数整块只算一次 —— 绝大多数滤波器是这种。
    const step = (fA || qA || gA || dA) ? 16 : len;
    const nSeg = Math.ceil(len / step);
    if (!this.#cf) { this.#cf = new Float64Array(8 * 5); this.#cs = new Int32Array(9); }
    const cf = this.#cf, cs = this.#cs;
    for (let s = 0, i = 0; s < nSeg; s++, i += step) {
      cs[s] = i;
      const f = (fA ? fA[i] : this.frequency._intrinsic) *
        Math.pow(2, (dA ? dA[i] : this.detune._intrinsic) / 1200);
      this.#coefsInto(cf, s * 5, f, qA ? qA[i] : this.Q._intrinsic, gA ? gA[i] : this.gain._intrinsic);
    }
    if (nSeg === 1) {
      /* 常量参数（绝大多数滤波器）→ 整块一套系数，内层不用逐采样查分段 */
      const b0 = cf[0], b1 = cf[1], b2 = cf[2], a1 = cf[3], a2 = cf[4];
      for (let c = 0; c < nch; c++) {
        let st = this.#z[c];
        if (!st) st = this.#z[c] = [0, 0];
        let z1 = st[0], z2 = st[1];
        const s = inp[c], d = out[c];
        for (let i = 0; i < len; i++) {
          const x = s[i];
          const y = b0 * x + z1;
          z1 = b1 * x - a1 * y + z2;
          z2 = b2 * x - a2 * y;
          d[i] = y;
        }
        st[0] = z1; st[1] = z2;
      }
      return out;
    }
    for (let c = 0; c < nch; c++) {
      let st = this.#z[c];
      if (!st) st = this.#z[c] = [0, 0];
      let z1 = st[0], z2 = st[1];
      const s = inp[c], d = out[c];
      let seg = 0;
      for (let i = 0; i < len; i++) {
        if (seg + 1 < nSeg && i >= cs[seg + 1]) seg++;
        const o = seg * 5;
        const x = s[i];
        const y = cf[o] * x + z1;
        z1 = cf[o + 1] * x - cf[o + 3] * y + z2;
        z2 = cf[o + 2] * x - cf[o + 4] * y;
        d[i] = y;
      }
      st[0] = z1; st[1] = z2;
    }
    return out;
  }
}

/* ==========================================================================
 *  DelayNode
 *  常数延时且 D ≥ 一个渲染块时走“先出后进”路径：本块输出完全来自历史，
 *  反馈环（delay → gain → delay）因此精确成立；D < 128 或延时被调制时
 *  退回“先拉输入、再逐采样读写”，环上会多一个 128 采样的隐式延时。
 * ==========================================================================*/
class DelayNode extends AudioNode {
  #cap;
  #first;
  #maxDelay;
  #nch;
  #ringBuf;
  constructor(context, maxDelayTime = 1) {
    super(context, 1);
    this.#maxDelay = Math.max(0, Number(maxDelayTime) || 0);
    this.delayTime = new AudioParam(context, 0, 0, this.#maxDelay);
    this.#cap = Math.ceil(this.#maxDelay * context.sampleRate) + 2 * Q + 4;
    this.#ringBuf = [];
    this.#nch = 0;
    this.#first = true;
    this._tail = this.#maxDelay;
  }

  #ringFor(c) {
    let r = this.#ringBuf[c];
    if (!r) r = this.#ringBuf[c] = new Float32Array(this.#cap);
    return r;
  }

  _renderBlock(start, len) {
    const db = this.delayTime._block(start, len);
    const constD = db === null ? clampNum(this.delayTime._intrinsic, 0, this.#maxDelay) * this.context.sampleRate : -1;
    const nch = this._outChannels();          // 静态通道数，不受剪枝影响

    if (constD >= len - 1) {
      // ── 先出后进：本块输出只来自延时线历史，因此环上的下游读到的就是本块输出
      const out = this._outFor(nch, len);
      const iD = Math.floor(constD), frac = constD - iD;
      const cap = this.#cap;
      for (let c = 0; c < nch; c++) {
        const ring = this.#ringFor(c), d = out[c];
        let ia = ((start - iD) % cap + cap) % cap;
        let ib = (ia - 1 + cap) % cap;
        for (let i = 0; i < len; i++) {
          d[i] = ring[ia] * (1 - frac) + ring[ib] * frac;
          if (++ia === cap) ia = 0;
          if (++ib === cap) ib = 0;
        }
      }
      this._cache = { start, len, data: out };          // 反馈环需要在拉输入前就能读到
      const inp = this._inputBlock(start, len);
      this.#write(inp, start, len);
      return out;
    }

    // ── 交错路径：先拉输入，再逐采样"写当前样本 → 读 (t - D)"
    //    这样 D < 一个块（甚至 D < 1）也完全正确
    return this.#interleaved(start, len, db, this._inputBlock(start, len), nch);
  }

  #interleaved(start, len, db, inp, nch) {
    const sr = this.context.sampleRate;
    const out = this._outFor(nch, len);
    const cap = this.#cap;
    const v0 = this.delayTime._intrinsic;
    for (let i = 0; i < len; i++) {
      const at = start + i;
      const D = clampNum(db ? db[i] : v0, 0, this.#maxDelay) * sr;
      const iD = Math.floor(D), frac = D - iD;
      const ia = (((at - iD) % cap) + cap) % cap;
      const ib = ((ia - 1) % cap + cap) % cap;
      for (let c = 0; c < nch; c++) {
        const ring = this.#ringFor(c);
        ring[((at % cap) + cap) % cap] = inp[Math.min(c, inp.length - 1)][i];   // 先写本采样
        out[c][i] = ring[ia] * (1 - frac) + ring[ib] * frac;                   // 再读 (t - D)
      }
    }
    return out;
  }

  #write(inp, start, len) {
    const cap = this.#cap;
    for (let c = 0; c < inp.length; c++) {
      const ring = this.#ringFor(c), s = inp[c];
      let w = ((start % cap) + cap) % cap;
      for (let i = 0; i < len; i++) { ring[w] = s[i]; if (++w === cap) w = 0; }
    }
  }
}

/* ==========================================================================
 *  StereoPannerNode（等功率声像；单声道输入用 cos/sin 曲线，
 *  立体声输入用线性平衡曲线，与规范一致）
 * ==========================================================================*/
class StereoPannerNode extends AudioNode {
  constructor(context) { super(context, 2); this.pan = new AudioParam(context, 0, -1, 1); }

  _outChannels() { return 2; }

  _renderBlock(start, len) {
    const inp = this._inputBlock(start, len);
    const nch = inp.length < 2 ? 1 : 2;
    const out = this._outFor(2, len);
    const L = out[0], R = out[1];
    const pb = this.pan._block(start, len);
    const p0 = clampNum(this.pan._intrinsic, -1, 1);
    if (pb === null) {
      /* 声像恒定（最常见）→ 把每采样的两次三角函数 / 分支提到循环外 */
      if (nch === 1) {
        const s = inp[0];
        const p = clampNum(p0, -1, 1), x = (p + 1) * 0.5;
        const cg = Math.cos(x * Math.PI / 2), sg = Math.sin(x * Math.PI / 2);
        for (let i = 0; i < len; i++) { const v = s[i]; L[i] = v * cg; R[i] = v * sg; }
      } else {
        const l = inp[0], r = inp[1];
        const p = clampNum(p0, -1, 1);
        if (p <= 0) { const x = p + 1, o = 1 - x; for (let i = 0; i < len; i++) { L[i] = l[i] + r[i] * o; R[i] = r[i] * x; } }
        else { const x = 1 - p, o = 1 - x; for (let i = 0; i < len; i++) { L[i] = l[i] * x; R[i] = r[i] + l[i] * o; } }
      }
      return out;
    }
    if (nch === 1) {
      const s = inp[0];
      for (let i = 0; i < len; i++) {
        const p = clampNum(pb ? pb[i] : p0, -1, 1);
        const x = (p + 1) * 0.5;
        const v = s[i];
        L[i] = v * Math.cos(x * Math.PI / 2);
        R[i] = v * Math.sin(x * Math.PI / 2);
      }
    } else {
      const l = inp[0], r = inp[1];
      for (let i = 0; i < len; i++) {
        const p = clampNum(pb ? pb[i] : p0, -1, 1);
        if (p <= 0) { const x = p + 1; L[i] = l[i] + r[i] * (1 - x); R[i] = r[i] * x; }
        else { const x = 1 - p; L[i] = l[i] * x; R[i] = r[i] + l[i] * (1 - x); }
      }
    }
    return out;
  }
}

/* ==========================================================================
 *  WaveShaperNode（曲线查表 + 线性插值；oversample 参数接受但不做上采样）
 * ==========================================================================*/
class WaveShaperNode extends AudioNode {
  constructor(context) {
    super(context, 1);
    this.curve = null;
    this.oversample = 'none';
  }
  _renderBlock(start, len) {
    const inp = this._inputBlock(start, len), nch = inp.length;
    const out = this._outFor(nch, len);
    const curve = this.curve;
    if (!curve || curve.length < 2) {
      for (let c = 0; c < nch; c++) out[c].set(inp[c].subarray(0, len));
      return out;
    }
    const n = curve.length - 1;
    for (let c = 0; c < nch; c++) {
      const s = inp[c], d = out[c];
      for (let i = 0; i < len; i++) {
        const x = clampNum(s[i], -1, 1) * 0.5 + 0.5;
        const p = x * n, i0 = Math.floor(p), fr = p - i0;
        d[i] = curve[i0] + (curve[Math.min(i0 + 1, n)] - curve[i0]) * fr;
      }
    }
    return out;
  }
}

/* ==========================================================================
 *  DynamicsCompressorNode —— 前馈式、立体声联动、软拐点
 *  （母线胶合压缩 + 安全限幅用；不追求与某个具体内核实测一致）
 * ==========================================================================*/
class DynamicsCompressorNode extends AudioNode {
  #gr;
  constructor(context) {
    super(context, 2);
    this.threshold = new AudioParam(context, -24, -100, 0);
    this.knee = new AudioParam(context, 30, 0, 40);
    this.ratio = new AudioParam(context, 12, 1, 20);
    this.attack = new AudioParam(context, 0.003, 0, 1);
    this.release = new AudioParam(context, 0.25, 0, 1);
    this.reduction = 0;
    this.#gr = 0;                                     // 当前增益衰减（dB，≤ 0）
  }

  _renderBlock(start, len) {
    const inp = this._inputBlock(start, len), nch = inp.length;
    const out = this._outFor(nch, len);
    const sr = this.context.sampleRate;
    const th = this.threshold._intrinsic, knee = Math.max(0, this.knee._intrinsic);
    const ratio = Math.max(1, this.ratio._intrinsic);
    const atkC = Math.exp(-1 / (sr * Math.max(1e-4, this.attack._intrinsic)));
    const relC = Math.exp(-1 / (sr * Math.max(1e-4, this.release._intrinsic)));
    let gr = this.#gr;
    for (let i = 0; i < len; i++) {
      let peak = 0;
      for (let c = 0; c < nch; c++) { const a = Math.abs(inp[c][i]); if (a > peak) peak = a; }
      const db = 20 * Math.log10(peak + 1e-12);
      const over = db - th;
      let target = 0;
      if (over > knee / 2) target = over * (1 / ratio - 1);
      else if (over > -knee / 2 && knee > 0) { const x = over + knee / 2; target = (1 / ratio - 1) * x * x / (2 * knee); }
      gr = target + (gr - target) * (target < gr ? atkC : relC);
      const g = dB2lin(gr);
      for (let c = 0; c < nch; c++) out[c][i] = inp[c][i] * g;
    }
    this.#gr = gr;
    this.reduction = gr;
    return out;
  }
}

/* ==========================================================================
 *  ConvSlice —— 一段 IR 的分块快速卷积（UPOLS：均匀分块 overlap-save）
 *
 *  数学：把 IR 切成 J 块（每块 B 点），第 j 块只与"当前输出块往前数 j 块"的输入
 *  做卷积。因为 h 的每一块只有 B 点，取 2B 长度的循环卷积的后 B 点，正好等于线性
 *  卷积里跟当前输出块对齐的那一段（overlap-save 的经典结论）。于是
 *
 *      y_k = IFFT( Σ_{j=0..J-1} X_{k-j} · H_j ) 的后 B 点
 *
 *  每个输出块只需要：1 次正向 FFT（输入窗 2B 点）+ J 次"频域复数乘加"+ 1 次 IFFT。
 *  每分块的频域乘法是 2B 次复数乘 = 每采样 2 次复数乘，与 B 无关；所以分块越少越快。
 *  B 越大，"输入块必须完整到手"造成的固有延时越大，因此第一段用 B = 128（零延时），
 *  后面的尾巴用大块（见 ConvolverNode.#prepare）。
 * ==========================================================================*/
class ConvSlice {
  /**
   * @param {Float32Array} ir       本段 IR（会被读成 J*B 点，尾部补零）
   * @param {number} B              分块大小（128 的整数倍）
   * @param {number} delayBlk       本段 IR 起点 / B（即输出需要延后的块数）
   */
  constructor(ir, B, delayBlk) {
    this.B = B;
    this.N2 = B * 2;
    this.delayBlk = delayBlk | 0;
    this.J = Math.max(1, Math.ceil(ir.length / B));
    this.Hre = [];
    this.Him = [];
    const buf = new Float64Array(this.N2);
    for (let j = 0; j < this.J; j++) {
      buf.fill(0);
      const off = j * B;
      const n = Math.max(0, Math.min(B, ir.length - off));
      for (let i = 0; i < n; i++) buf[i] = ir[off + i];
      const re = Float64Array.from(buf), im = new Float64Array(this.N2);
      fft(re, im);                                   // 前 B 点为 IR 分块，后 B 点补零
      this.Hre.push(re);
      this.Him.push(im);
    }
    this.pipe = [];
  }

  /** 每条（输入）通道一条独立流水线 */
  #pipeFor(ch) {
    let p = this.pipe[ch];
    if (p) return p;
    const J = this.J, N2 = this.N2, B = this.B;
    p = this.pipe[ch] = {
      xr: new Float64Array(J * N2),          // 最近 J 个输入块的频谱（环形）
      xi: new Float64Array(J * N2),
      yr: new Float64Array(N2),              // 频域累加器
      yi: new Float64Array(N2),
      win: new Float32Array(N2),             // 时域输入窗
      nextZ: 0,                              // 下一个要算的 z 块号
      buf: new Float32Array(2 * B),          // 输出滑动窗
      ostart: this.delayBlk * B,             // 输出流起点（绝对采样位置）
      olen: 0,
    };
    return p;
  }

  /**
   * 把 [start, start+len) 的输出叠加到 dest
   * @param {InputHist} hist 输入历史（hist.end = 已写入的绝对位置上界）
   */
  stream(ch, start, len, dest, hist, availUpTo) {
    const p = this.#pipeFor(ch);
    const B = this.B, N2 = this.N2, J = this.J;

    while (p.ostart + p.olen < start + len) {
      if (p.olen + B > p.buf.length) {               // 滑窗：丢掉最旧的一块
        p.buf.copyWithin(0, B, p.buf.length);
        p.ostart += B;
        p.olen -= B;
      }
      const k = p.nextZ;
      if ((k + 1) * B > availUpTo) break;            // 输入还没到手（正常不会发生）
      // ① 输入窗 [kB - B, (k+1)B) → X_k 存进环形槽
      hist.read(k * B - B, (k + 1) * B, p.win, 0);
      const slot = (k % J) * N2;
      const xr = p.xr, xi = p.xi;
      for (let i = 0; i < N2; i++) { xr[slot + i] = p.win[i]; xi[slot + i] = 0; }
      fft(xr.subarray(slot, slot + N2), xi.subarray(slot, slot + N2));
      // ② Y = Σ_j X_{k-j} · H_j
      const yr = p.yr, yi = p.yi;
      yr.fill(0); yi.fill(0);
      for (let j = 0; j < J; j++) {
        const s = (((k - j) % J) + J) % J * N2;
        const hr = this.Hre[j], hi = this.Him[j];
        for (let i = 0; i < N2; i++) {
          const ar = xr[s + i], ai = xi[s + i], br = hr[i], bi = hi[i];
          yr[i] += ar * br - ai * bi;
          yi[i] += ar * bi + ai * br;
        }
      }
      // ③ 逆变换，取后 B 点写进输出窗
      ifft(yr, yi);
      const o = p.olen;
      p.buf.set(yr.subarray(B, N2), o);
      p.olen += B;
      p.nextZ++;
    }

    const a = Math.max(start, p.ostart);
    const b = Math.min(start + len, p.ostart + p.olen);
    if (b > a) {
      const off = a - start;
      for (let i = a; i < b; i++) dest[off + (i - a)] += p.buf[i - p.ostart];
    }
  }
}

/* ==========================================================================
 *  ConvolverNode —— 真正的 FFT 卷积混响
 *  通道矩阵（与规范表一致）：
 *    1 入 1 IR → 1 出               1 入 2 IR → L = in⊛ir0, R = in⊛ir1
 *    2 入 1 IR → L = L⊛ir0, R = R⊛ir0（对角）
 *    2 入 2 IR → L = L⊛ir0, R = R⊛ir1（对角）
 * ==========================================================================*/
class ConvolverNode extends AudioNode {
  #buffer;
  #end;
  #hist;
  #histLen;
  #prepared;
  constructor(context) {
    super(context, 2);
    this.normalize = true;
    this.#buffer = null;
    this.#prepared = null;
    this.#hist = [];
    this.#histLen = 0;
    this.#end = 0;
  }

  get buffer() { return this.#buffer; }
  set buffer(b) {
    this.#buffer = b;
    this._clearChannels();          // 输出通道数会随 IR 通道数变化
    this.#prepare();
  }

  /** 上游（输入）通道数，1 或 2 */
  #srcChannels() { return this._inChannels(); }

  /** 输出通道数 = max(输入, IR 通道数) */
  _outChannels() {
    if (this._convOut !== undefined) return this._convOut;
    const ir = this.#buffer ? Math.min(2, this.#buffer.numberOfChannels) : 1;
    this._convOut = Math.max(this._inChannels(), ir);
    return this._convOut;
  }

  #prepare() {
    const b = this.#buffer;
    this.#prepared = null;
    this.#hist = [];
    this.#end = 0;
    this._tail = 0;
    if (!b || !b.length || !b.numberOfChannels) { this.#histLen = 4 * Q; return; }

    const nchIR = Math.min(2, b.numberOfChannels);
    const irs = [];
    let ms = 0, cnt = 0;
    for (let c = 0; c < nchIR; c++) {
      const d = Float32Array.from(b.getChannelData(c));   // 拷一份，之后与 AudioBuffer 脱钩
      irs.push(d);
      for (let i = 0; i < d.length; i++) { ms += d[i] * d[i]; cnt++; }
    }
    if (this.normalize) {
      // normalize = true（默认）时按 RMS 归一化，并除以 √sampleRate：
      // 卷积输出的增益正比于 √(采样率 × 拖尾时长)，除掉 √sr 后同一段 IR 在任何
      // 采样率下电平一致 —— 规范里 normalize 的作用就是这个量级修正。
      // 想完全自己控制电平（例如按能量归一化到"与干声等响"）就设 normalize = false。
      const rms = Math.sqrt(ms / Math.max(1, cnt));
      if (rms > 1e-6) {
        const s = 1 / (rms * Math.sqrt(this.context.sampleRate));
        for (const d of irs) for (let i = 0; i < d.length; i++) d[i] *= s;
      }
    }

    const B1 = Q, SPAN1 = 32 * B1;          // 前 32 块 = 4096 采样 ≈ 93ms：零延时段
    const B2 = 4096;                        // 剩余尾巴：大分块（延时用分块对齐补回来）
    const slices = [];
    let maxB = B1;
    for (const d of irs) {
      const list = [new ConvSlice(d.length <= SPAN1 ? d : d.subarray(0, SPAN1), B1, 0)];
      if (d.length > SPAN1) {
        list.push(new ConvSlice(d.subarray(SPAN1), B2, SPAN1 / B2));
        maxB = B2;
      }
      slices.push(list);
    }
    this.#histLen = Math.max(4 * maxB, 4 * Q);
    this.#prepared = { slices, nchIR };
    this._tail = b.duration;
  }

  #histFor(c, len) {
    let h = this.#hist[c];
    if (!h || h.n !== len) h = this.#hist[c] = new InputHist(len);
    return h;
  }

  _renderBlock(start, len) {
    const prep = this.#prepared;
    if (!prep) return this._outFor(this._outChannels(), len);   // 没设 IR → 静音
    const inp = this._inputBlock(start, len);
    const nin = this.#srcChannels();
    const nout = Math.max(nin, prep.nchIR);
    const hl = this.#histLen;
    for (let c = 0; c < nin; c++) this.#histFor(c, hl).push(inp[Math.min(c, inp.length - 1)], start, len);
    this.#end = start + len;
    const out = this._outFor(nout, len);
    for (let c = 0; c < nout; c++) {
      const ic = Math.min(c, nin - 1);
      const ir = Math.min(c, prep.nchIR - 1);
      const h = this.#histFor(ic, hl);
      const list = prep.slices[ir];
      for (let s = 0; s < list.length; s++) list[s].stream(ic, start, len, out[c], h, this.#end);
    }
    return out;
  }
}

/* ==========================================================================
 *  AnalyserNode —— 直通 + 时域环形缓冲 + FFT 频谱分析
 *
 *  离线引擎里它就是一个"带记忆的直通"：每个渲染块把混好的输入原样输出，
 *  同时写进长度 fftSize 的环形缓冲（保留最近 fftSize 个采样）。读取时对
 *  最近 fftSize 个采样加 Blackman 窗做一次 FFT：
 *    · 取线性幅度 (k>0 单边谱 ×2)/fftSize；满幅正弦 → 0 dB 附近
 *    · 按 smoothingTimeConstant 在"线性幅度域"做时间平滑
 *      （规范/Chromium 都是平滑幅度、不是平滑 dB）
 *    · getFloat* 输出 dB，夹在 [minDecibels, maxDecibels]
 *    · getByte*  线性映射到 0..255
 *
 *  一个离线场景下的便利：createAnalyser() 出来的节点会被渲染循环当成
 *  "旁路根"每块拉取一次，所以不连到 destination 也能拿到数据（见 startRendering）。
 *  FFT 与平滑都是"读取时按需算"，所以平滑是随读取次数推进的 —— 想拿稳态谱，
 *  要么多读几次，要么把 smoothingTimeConstant 设 0。
 * ==========================================================================*/
const ANALYSER_SIZES = new Set([32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768]);

class AnalyserNode extends AudioNode {
  #fftSize;
  #im;
  #magAt;
  #re;
  #ring;
  #smooth;
  #snap;
  #snapAt;
  constructor(context) {
    super(context, 2);
    this.minDecibels = -100;
    this.maxDecibels = -30;
    this.smoothingTimeConstant = 0.8;
    this.#fftSize = 2048;
    this.#ring = new Float64Array(this.#fftSize);
    this.#smooth = new Float64Array(this.#fftSize >> 1);
    this._pos = 0;
    this.#re = null;
    this.#im = null;
    this.#snap = null;
    this.#snapAt = -1;
    this.#magAt = -1;
  }

  get fftSize() { return this.#fftSize; }
  set fftSize(v) {
    const n = Number(v) | 0;
    if (!ANALYSER_SIZES.has(n)) throw new Error('AnalyserNode.fftSize 必须是 32..32768 的 2 的幂');
    this.#fftSize = n;
    this.#ring = new Float64Array(n);
    this.#smooth = new Float64Array(n >> 1);
    this.#re = null; this.#im = null;
    this.#snap = null; this.#snapAt = -1; this.#magAt = -1;
  }
  get frequencyBinCount() { return this.#fftSize >> 1; }

  _renderBlock(start, len) {
    const inp = this._inputBlock(start, len), nch = inp.length;
    const out = this._outFor(nch, len);
    for (let c = 0; c < nch; c++) out[c].set(inp[c].subarray(0, len));
    const N = this.#fftSize, r = this.#ring;
    let w = ((start % N) + N) % N;
    if (nch < 2) {
      const s = inp[0];
      for (let i = 0; i < len; i++) { r[w] = s[i]; if (++w === N) w = 0; }
    } else {
      const a = inp[0], b = inp[1];
      for (let i = 0; i < len; i++) { r[w] = (a[i] + b[i]) * 0.5; if (++w === N) w = 0; }
    }
    this._pos = start + len;
    return out;
  }

  /** 最近 fftSize 个采样（下混成单声道），早于 0 的位置补 0 */
  #snapshot() {
    if (this.#snapAt === this._pos && this.#snap) return this.#snap;
    const N = this.#fftSize, r = this.#ring, out = new Float32Array(N);
    const s0 = this._pos - N;
    for (let i = 0; i < N; i++) {
      const idx = s0 + i;
      if (idx >= 0) out[i] = r[((idx % N) + N) % N];
    }
    this.#snap = out; this.#snapAt = this._pos;
    return out;
  }

  getFloatTimeDomainData(dest) {
    const t = this.#snapshot(), N = t.length, n = Math.min(dest.length, N);
    dest.set(t.subarray(N - n), 0);
  }
  getByteTimeDomainData(dest) {
    const t = this.#snapshot(), N = t.length, n = Math.min(dest.length, N);
    for (let i = 0; i < n; i++) {
      const v = Math.round(t[N - n + i] * 128 + 128);
      dest[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }

  /** 平滑后的线性幅度（同一采样位置只算一次 FFT） */
  #magnitudes() {
    if (this.#magAt === this._pos) return this.#smooth;
    const N = this.#fftSize, bins = N >> 1, t = this.#snapshot();
    if (!this.#re || this.#re.length !== N) { this.#re = new Float64Array(N); this.#im = new Float64Array(N); }
    const re = this.#re, im = this.#im;
    for (let i = 0; i < N; i++) {
      const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / N) + 0.08 * Math.cos(4 * Math.PI * i / N);
      re[i] = t[i] * w; im[i] = 0;
    }
    fft(re, im);
    const sm = this.#smooth, tau = clampNum(this.smoothingTimeConstant, 0, 1), k1 = 1 - tau;
    for (let k = 0; k < bins; k++) {
      const m = (k === 0 ? 1 : 2) * Math.hypot(re[k], im[k]) / N;
      sm[k] = tau * sm[k] + k1 * m;
    }
    this.#magAt = this._pos;
    return sm;
  }

  getFloatFrequencyData(dest) {
    const m = this.#magnitudes(), bins = this.#fftSize >> 1;
    const lo = this.minDecibels, hi = this.maxDecibels;
    for (let k = 0, n = Math.min(dest.length, bins); k < n; k++) {
      dest[k] = clampNum(20 * Math.log10(m[k] + 1e-20), lo, hi);
    }
  }
  getByteFrequencyData(dest) {
    const m = this.#magnitudes(), bins = this.#fftSize >> 1;
    const lo = this.minDecibels, hi = this.maxDecibels, span = Math.max(1e-6, hi - lo);
    for (let k = 0, n = Math.min(dest.length, bins); k < n; k++) {
      const b = Math.round(255 / span * (20 * Math.log10(m[k] + 1e-20) - lo));
      dest[k] = b < 0 ? 0 : b > 255 ? 255 : b;
    }
  }
}

/* ==========================================================================
 *  ScriptProcessorNode —— 已废弃、但老代码里仍然常见的"JS 回调处理块"
 *
 *  规范里它每 bufferSize 个采样回调一次 onaudioprocess。真实引擎跑在独立音频
 *  线程，离线引擎没有第二个线程，这里同样做成"逐渲染块调用、结果可复现"：
 *    · 输入先攒进一个 bufferSize 长的缓冲；攒满的**那一块**同步派发事件
 *      （inputBuffer / outputBuffer 都是 AudioBuffer，跟规范同名同形）；
 *    · 处理器写进 outputBuffer 的内容从**下一块**开始播出 —— 正好是真实
 *      Web Audio 的一个 bufferSize 延时，离线渲染里逐采样确定。
 *    · bufferSize ∈ {256…16384}（都是 128 的整数倍），所以事件永远落在渲染块
 *      边界上；bufferSize 传 0 时自动取 SP_DEFAULT_SIZE。
 *
 *  剪枝：处理器可以凭空造声，窗口按 AudioWorklet 同样的保守策略处理 ——
 *  没有（连上）输入时整条时间线都可能出声；有输入时进入后拖尾到无穷。
 * ==========================================================================*/
const SP_SIZES = new Set([256, 512, 1024, 2048, 4096, 8192, 16384]);
const SP_DEFAULT_SIZE = 2048;
const SP_MAX_CH = 2;                       // 本引擎每路最多立体声

function spError(name, msg) { const e = new Error(msg); e.name = name; return e; }

/** 事件对象：与规范同名，带 playbackTime / inputBuffer / outputBuffer */
class AudioProcessingEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.playbackTime = init.playbackTime ?? 0;
    this.inputBuffer = init.inputBuffer ?? null;
    this.outputBuffer = init.outputBuffer ?? null;
    this.target = init.target ?? null;
    this.currentTarget = this.target;
  }
}

class ScriptProcessorNode extends AudioNode {
  #acc;
  #fill;
  #listeners;
  #nIn;
  #nOut;
  #outQueue;
  #size;
  constructor(context, bufferSize, numberOfInputChannels, numberOfOutputChannels) {
    const nIn = numberOfInputChannels === undefined ? 2 : Math.trunc(numberOfInputChannels);
    const nOut = numberOfOutputChannels === undefined ? 2 : Math.trunc(numberOfOutputChannels);
    if (!(nIn >= 0) || !(nOut >= 0)) throw spError('IndexSizeError', 'ScriptProcessorNode: 声道数必须是 >= 0 的整数');
    if (nIn === 0 && nOut === 0) throw spError('IndexSizeError', 'ScriptProcessorNode: 输入/输出声道数不能同时为 0');
    if (nIn > SP_MAX_CH || nOut > SP_MAX_CH) {
      throw spError('NotSupportedError', `ScriptProcessorNode: 本引擎每路最多 ${SP_MAX_CH} 声道（立体声），收到 ${nIn}/${nOut}`);
    }
    const size = (bufferSize === undefined || bufferSize === 0) ? SP_DEFAULT_SIZE : Math.trunc(bufferSize);
    if (!SP_SIZES.has(size)) {
      throw spError('IndexSizeError', `createScriptProcessor: bufferSize 必须是 0 或 ${[...SP_SIZES].join('/')}，收到 ${bufferSize}`);
    }
    super(context, Math.max(1, nOut || nIn));
    this.numberOfInputs = nIn > 0 ? 1 : 0;
    this.numberOfOutputs = nOut > 0 ? 1 : 0;
    this.onaudioprocess = null;
    this._lastError = null;
    this._tail = Infinity;                 // 处理器可能自造拖尾，剪枝不敢跳
    this.#nIn = nIn;
    this.#nOut = nOut;
    this.#size = size;
    this.#fill = 0;
    this.#acc = [];
    for (let c = 0; c < nIn; c++) this.#acc.push(new Float32Array(size));
    this.#outQueue = [];
    this.#listeners = [];
  }

  /** 只读（与规范一致） */
  get bufferSize() { return this.#size; }

  addEventListener(type, fn) {
    if (type === 'audioprocess' && typeof fn === 'function' && !this.#listeners.includes(fn)) this.#listeners.push(fn);
  }
  removeEventListener(type, fn) {
    if (type !== 'audioprocess') return;
    const i = this.#listeners.indexOf(fn); if (i >= 0) this.#listeners.splice(i, 1);
  }

  _outChannels() { return Math.max(1, this.#nOut); }

  /** 处理器可能凭空出声（跟输入是否在场无关）→ 整条时间线都不能剪，保守但不会漏声 */
  _windowSelf() { return { t0: 0, t1: Infinity }; }

  /** 把已产出、还没播出的 outputBuffer 数据按块拷进 out（不足补 0，保持"先出后进"） */
  #drain(out, len) {
    let need = len, o = 0;
    const q = this.#outQueue, nOut = this.#nOut;
    while (need > 0 && q.length) {
      const head = q[0];
      const take = Math.min(need, head.data[0].length - head.pos);
      for (let c = 0; c < nOut; c++) {
        const src = head.data[Math.min(c, head.data.length - 1)];
        out[c].set(src.subarray(head.pos, head.pos + take), o);
      }
      head.pos += take; o += take; need -= take;
      if (head.pos >= head.data[0].length) q.shift();
    }
  }

  #fire(start, len) {
    const size = this.#size, nIn = this.#nIn, nOut = this.#nOut, sr = this.context.sampleRate;
    let inputBuffer = null;
    if (nIn > 0) {
      inputBuffer = new AudioBuffer(nIn, size, sr);
      for (let c = 0; c < nIn; c++) inputBuffer.getChannelData(c).set(this.#acc[c]);
    }
    const outputBuffer = nOut > 0 ? new AudioBuffer(nOut, size, sr) : null;
    const ev = new AudioProcessingEvent('audioprocess', {
      playbackTime: (start + len) / sr,      // 这一块处理完、输出开始播的时刻
      inputBuffer, outputBuffer, target: this,
    });
    try {
      if (typeof this.onaudioprocess === 'function') this.onaudioprocess(ev);
      for (let i = 0; i < this.#listeners.length; i++) this.#listeners[i](ev);
    } catch (err) {
      this._lastError = err;                 // 不因用户回调抛错而中断整段渲染
      if (typeof console !== 'undefined') console.error('ScriptProcessorNode 的 onaudioprocess 抛错：', err);
    }
    if (outputBuffer && this.#outQueue.length < 8) {
      const data = [];
      for (let c = 0; c < nOut; c++) data.push(outputBuffer.getChannelData(c));
      this.#outQueue.push({ data, pos: 0 });
    }
    if (nIn > 0) for (let c = 0; c < nIn; c++) this.#acc[c].fill(0);
  }

  _renderBlock(start, len) {
    const out = this._outFor(Math.max(1, this.#nOut), len);
    if (this.#nOut > 0) this.#drain(out, len);            // ① 先播出上一块产出的输出
    if (this.#nIn > 0) {                                  // ② 再攒这一块的输入
      const inp = this._inputBlock(start, len), nch = inp.length;
      for (let c = 0; c < this.#nIn; c++) {
        const src = inp[Math.min(c, nch - 1)], dst = this.#acc[c];
        for (let i = 0; i < len; i++) dst[this.#fill + i] = src[i];
      }
    }
    this.#fill += len;
    if (this.#fill >= this.#size) {                       // ③ 攒满 → 同步派发 onaudioprocess
      this.#fire(start, len);
      this.#fill = 0;
    }
    return out;
  }
}

/* ==========================================================================
 *  AudioWorklet —— 进程内实现的 AudioWorkletNode / AudioWorkletProcessor
 *
 *  真实浏览器里处理器跑在独立音频线程、靠 MessagePort 通信。离线引擎没有第二个
 *  线程，这里是"同一线程、逐渲染块调用 process()"的确定性模拟：
 *    · ctx.audioWorklet.addModule(...) 接受 代码字符串 / 注册回调 / {name: 类} /
 *      URL（先 fetch，不行再 import）。走代码路径需要 eval 权限
 *      （RunJS 沙箱里给 permissions: ["eval"]）。
 *    · 每个渲染块把 inputs / outputs / parameters 交给 processor.process()，
 *      返回值 false 表示处理器结束（之后输出静音）。
 *    · 处理器模块里用 class X extends AudioWorkletProcessor + registerProcessor()。
 *    · MessagePort 只实现 onmessage / postMessage / close；消息在每个渲染块边界
 *      按固定顺序派发（处理器 → 主线程在本块 process() 之后，主线程 → 处理器在
 *      下一块 process() 之前），顺序确定、结果可复现。
 *
 *  取舍：
 *   · **端口**：numberOfInputs / numberOfOutputs 任意（≤32）。`connect(dest, outIdx, inIdx)`
 *     把连线接到指定端口，端口之间各自混音、互不影响；没连线的输入端口是空数组 []。
 *     多输出节点下游用 `worklet.connect(dest, outIdx)` 选中要读哪一路。
 *   · **通道数**：每路仍是 1/2（单声道/立体声）。inputs[p] 就是 [L, R]，输出用
 *     outputChannelCount: [2, ...] 即可；explicit 模式按 channelCount 上混/下混
 *     （引擎同一套矩阵）。>2 声道需要重写下混矩阵，未支持，会抛说明。
 *   · 处理器默认 tail = ∞（可能自生成拖尾，剪枝不敢跳），传 { tail: 秒 } 可恢复剪枝。
 * ==========================================================================*/
class AudioParamMap extends Map {}

/** 极简 MessagePort：onmessage / postMessage / close，消息按块边界派发 */
class MiniMessagePort {
  constructor() { this.onmessage = null; this._inbox = []; this._peer = null; }
  postMessage(data) { if (this._peer) this._peer._inbox.push({ data }); }
  start() {}
  close() { if (this._peer) { this._peer._peer = null; this._peer = null; } }
  _flush() {
    while (this._inbox.length && typeof this.onmessage === 'function') {
      const ev = this._inbox.shift();
      this.onmessage(ev);
    }
  }
}

class AudioWorkletProcessor {
  constructor() {
    this.port = AudioWorkletProcessor._pendingPort || new MiniMessagePort();
  }
}
AudioWorkletProcessor._pendingPort = null;

class AudioWorklet {
  #ctx;
  constructor(context) { this.#ctx = context; this._processors = new Map(); }

  #register(name, ctor) {
    if (typeof name !== 'string' || !name) throw new TypeError('registerProcessor: 名字必须是非空字符串');
    if (typeof ctor !== 'function') throw new TypeError(`registerProcessor("${name}"): 第二个参数必须是类`);
    if (this._processors.has(name)) throw new Error(`registerProcessor: "${name}" 已经注册过`);
    this._processors.set(name, ctor);
  }

  /** 在"注册作用域"里求值一段 worklet 源码（registerProcessor 同时挂到 globalThis） */
  #evalSource(src) {
    const ctx = this.#ctx, reg = (n, c) => this.#register(n, c);
    const g = globalThis;
    const savedReg = g.registerProcessor, savedAWP = g.AudioWorkletProcessor;
    g.registerProcessor = reg;
    if (savedAWP === undefined) g.AudioWorkletProcessor = AudioWorkletProcessor;
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function('registerProcessor', 'AudioWorkletProcessor', 'sampleRate',
        'currentTime', 'currentFrame', 'globalThis', src);
      fn(reg, AudioWorkletProcessor, ctx.sampleRate, ctx.currentTime, 0, g);
    } finally {
      if (savedReg === undefined) delete g.registerProcessor; else g.registerProcessor = savedReg;
      if (savedAWP === undefined) delete g.AudioWorkletProcessor; else g.AudioWorkletProcessor = savedAWP;
    }
  }

  async addModule(input) {
    if (typeof input === 'function') {
      if (input.prototype && typeof input.prototype.process === 'function') {
        this.#register(input.processorName || input.name, input);       // 直接给处理器类
      } else {
        input({ registerProcessor: (n, c) => this.#register(n, c), AudioWorkletProcessor,
          sampleRate: this.#ctx.sampleRate, currentTime: this.#ctx.currentTime, currentFrame: 0 });
      }
      return;
    }
    if (input && typeof input === 'object' && !(input instanceof ArrayBuffer)) {
      for (const [n, c] of Object.entries(input)) this.#register(n, c);
      return;
    }
    const src = String(input);
    if (/[\n;{}]|=>|\bclass\b|\bfunction\b|\bregisterProcessor\b/.test(src)) { this.#evalSource(src); return; }

    // 当作 URL / 路径：先 fetch，失败再动态 import（用 globalThis 上的临时 shim）
    let text = null;
    if (typeof fetch === 'function') {
      try { const r = await fetch(src); if (r.ok) text = await r.text(); } catch { /* 落到 import */ }
    }
    if (text !== null) { this.#evalSource(text); return; }

    const g = globalThis;
    const savedReg = g.registerProcessor, savedAWP = g.AudioWorkletProcessor;
    g.registerProcessor = (n, c) => this.#register(n, c);
    if (savedAWP === undefined) g.AudioWorkletProcessor = AudioWorkletProcessor;
    try { await import(/* @vite-ignore */ src); }
    finally {
      if (savedReg === undefined) delete g.registerProcessor; else g.registerProcessor = savedReg;
      if (savedAWP === undefined) delete g.AudioWorkletProcessor; else g.AudioWorkletProcessor = savedAWP;
    }
  }
}

class AudioWorkletNode extends AudioNode {
  #constParams;
  #done;
  #inPorts;
  #nodePort;
  #occ;
  #outsData;
  #outsStart;
  #procPort;
  constructor(context, name, options = {}) {
    const wl = context && context.audioWorklet;
    const Ctor = wl && wl._processors.get(name);
    if (typeof Ctor !== 'function') {
      throw new Error(`AudioWorkletNode: 处理器 "${name}" 未注册（先 await ctx.audioWorklet.addModule(...)）`);
    }
    const nIn = options.numberOfInputs === undefined ? 1 : (options.numberOfInputs | 0);
    const nOut = options.numberOfOutputs === undefined ? 1 : (options.numberOfOutputs | 0);
    if (nIn < 0 || nOut < 0) throw new Error('AudioWorkletNode: numberOfInputs/Outputs 不能为负');
    if (nIn > 32 || nOut > 32) throw new Error('AudioWorkletNode: numberOfInputs/Outputs 上限 32');
    const cc = options.channelCount === undefined ? 2 : (options.channelCount | 0);
    if (cc > 2) throw new Error('AudioWorkletNode: channelCount 上限 2（本引擎每路最多立体声）');
    super(context, cc);
    this.name = name;
    this.numberOfInputs = nIn;
    this.numberOfOutputs = nOut;
    this.channelCountMode = options.channelCountMode || 'max';
    this.channelInterpretation = options.channelInterpretation || 'speakers';
    this.onprocessorerror = null;

    // 每个输出端口各自 1/2 声道：outputChannelCount[o] 给定，否则跟随输入
    const occ = options.outputChannelCount;
    if (occ !== undefined && !Array.isArray(occ)) throw new TypeError('AudioWorkletNode: outputChannelCount 必须是数组');
    this.#occ = null;
    if (Array.isArray(occ) && occ.length) {
      if (occ.length !== nOut) {
        throw new Error(`AudioWorkletNode: outputChannelCount 长度(${occ.length})必须等于 numberOfOutputs(${nOut})`);
      }
      const a = new Array(Math.max(1, nOut));
      for (let o = 0; o < a.length; o++) {
        const k = Math.max(1, occ[o] | 0);
        if (k > 2) throw new Error('AudioWorkletNode: 本引擎每路最多 2 声道（立体声）');
        a[o] = k;
      }
      this.#occ = a;
    }

    this.#procPort = new MiniMessagePort();
    this.#nodePort = new MiniMessagePort();
    this.#procPort._peer = this.#nodePort;
    this.#nodePort._peer = this.#procPort;
    this.port = this.#nodePort;

    this.parameters = new AudioParamMap();
    for (const d of Ctor.parameterDescriptors || []) {
      const p = new AudioParam(context,
        d.defaultValue === undefined ? 0 : d.defaultValue,
        d.minValue === undefined ? -3.4028235e38 : d.minValue,
        d.maxValue === undefined ? 3.4028235e38 : d.maxValue);
      p.automationRate = d.automationRate === 'k-rate' ? 'k-rate' : 'a-rate';
      this.parameters.set(d.name, p);
    }

    AudioWorkletProcessor._pendingPort = this.#procPort;
    let proc;
    try { proc = new Ctor(options); }
    finally { AudioWorkletProcessor._pendingPort = null; }
    if (!proc || typeof proc.process !== 'function') {
      throw new Error(`AudioWorkletNode: 处理器 "${name}" 没有 process() 方法`);
    }
    this._proc = proc;
    this.#done = false;
    this.#inPorts = [];          // 每个输入端口的复用缓冲
    this.#outsData = null;       // [输出端口][通道] 的复用缓冲
    this.#outsStart = -1;
    this.#constParams = {};
    this._tail = typeof options.tail === 'number' ? Math.max(0, options.tail) : Infinity;
    context._nodes.push(this);
  }

  /** 第 o 个输出端口的通道数（1/2；静态，供下游推导输入通道数） */
  _outChannels(o = 0) {
    if (this.numberOfOutputs === 0) return 1;
    if (this.#occ) return this.#occ[Math.min(o, this.#occ.length - 1)] || 1;
    if (this.numberOfInputs > 0) return this._inChannels();
    return 1;
  }

  /** 无输入（自生成）的处理器时间窗无从推断，保守地取 [0, ∞) */
  _windowSelf() { return this.numberOfInputs === 0 ? { t0: 0, t1: Infinity } : null; }

  /** 混出第 p 个输入端口的这一个块（没连线 → 空数组，与规范一致） */
  #mixPort(p, start, len) {
    const srcs = this._sources, srcOut = this._srcOut, srcIn = this._srcIn;
    let any = false, nch = 1;
    for (let i = 0; i < srcs.length; i++) {
      if (srcIn[i] !== p) continue;
      any = true;
      const k = srcs[i]._outChannels(srcOut[i]);
      if (k > nch) nch = k;
    }
    if (!any) return EMPTY_IN;
    nch = Math.min(2, nch);
    if (this.channelCountMode === 'explicit') nch = clampNum(this.channelCount | 0 || 1, 1, 2);
    let slot = this.#inPorts[p];
    if (!slot || slot.length !== nch || slot[0].length !== len) {
      slot = this.#inPorts[p] = [];
      for (let c = 0; c < nch; c++) slot.push(new Float32Array(len));
    }
    for (let c = 0; c < nch; c++) slot[c].fill(0);
    for (let i = 0; i < srcs.length; i++) {
      if (srcIn[i] !== p) continue;
      mixInto(slot, srcs[i]._getBlock(start, len, srcOut[i]), len);
    }
    return slot;
  }

  _renderBlock(start, len) {
    this.#outsStart = start;
    if (this.#done) { this.#outsData = null; return SILENT; }

    const nIn = this.numberOfInputs, nOut = this.numberOfOutputs;
    const inputs = new Array(nIn);
    for (let p = 0; p < nIn; p++) inputs[p] = this.#mixPort(p, start, len);

    const nAlloc = Math.max(1, nOut);
    let outsAll = this.#outsData;
    if (!outsAll || outsAll.length !== nAlloc || outsAll[0][0].length !== len) {
      outsAll = this.#outsData = [];
      for (let o = 0; o < nAlloc; o++) {
        const oc = this._outChannels(o), arr = [];
        for (let c = 0; c < oc; c++) arr.push(new Float32Array(len));
        outsAll.push(arr);
      }
    }
    for (let o = 0; o < nAlloc; o++) {
      const arr = outsAll[o];
      for (let c = 0; c < arr.length; c++) arr[c].fill(0);
    }

    const params = {};
    for (const [nm, p] of this.parameters) {
      const b = p._block(start, len);
      if (p.automationRate === 'k-rate') params[nm] = new Float32Array([b ? b[0] : p._intrinsic]);
      else if (b) params[nm] = b;
      else {
        const a = this.#constParams[nm] || (this.#constParams[nm] = new Float32Array(len));
        a.fill(p._intrinsic);
        params[nm] = a;
      }
    }

    this.#procPort._flush();                       // 主线程 → 处理器
    let keep = true;
    try { keep = this._proc.process(inputs, nOut === 0 ? EMPTY_OUT : outsAll, params); }
    catch (err) {
      this.#done = true;
      this.#outsData = null;
      const ev = { type: 'processorerror', error: err };
      if (typeof this.onprocessorerror === 'function') { try { this.onprocessorerror(ev); } catch { /* 忽略用户回调异常 */ } }
      else if (typeof console !== 'undefined') console.error(`AudioWorkletProcessor "${this.name}" 的 process() 抛错：`, err);
      return SILENT;
    }
    this.#nodePort._flush();                       // 处理器 → 主线程
    if (keep === false) this.#done = true;         // 当块输出仍有效，只是之后不再处理
    return outsAll[0];
  }

  /** 第 outIdx 路输出（多输出节点；单输出节点不会被问到） */
  _output(start, outIdx) {
    const d = this.#outsData;
    if (this.#outsStart === start && d && d[outIdx]) return d[outIdx];
    return SILENT;
  }
}

/* ==========================================================================
 *  AudioBuffer
 * ==========================================================================*/
class AudioBuffer {
  #data;
  constructor(numberOfChannels = 1, length = 0, sampleRate = 44100) {
    this.numberOfChannels = Math.max(1, numberOfChannels | 0);
    this.length = Math.max(0, length | 0);
    this.sampleRate = sampleRate;
    this.#data = [];
    for (let c = 0; c < this.numberOfChannels; c++) this.#data.push(new Float32Array(this.length));
  }
  get duration() { return this.length / this.sampleRate; }
  getChannelData(channel) {
    const d = this.#data[channel];
    if (!d) throw new Error(`getChannelData: 通道 ${channel} 不存在`);
    return d;
  }
  copyFromChannel(dest, channel, start = 0) {
    const src = this.getChannelData(channel);
    dest.set(src.subarray(start, start + dest.length));
  }
  copyToChannel(src, channel, start = 0) {
    this.getChannelData(channel).set(src, start);
  }
}

/* ==========================================================================
 *  decodeAudioData —— 内置 WAV + 懒加载通用解码器（audio-decode）
 *
 *  · 内置 WAV（零依赖、离线可用）：PCM 8/16/24/32bit、IEEE float 32/64bit、
 *    WAVE_FORMAT_EXTENSIBLE；按规范线性重采样到 context.sampleRate。
 *  · 其它格式（mp3 / ogg / opus / flac / aiff / caf / m4a…）：第一次遇到非 WAV
 *    数据时**动态 import** npm 包 `audio-decode`（WASM 封装 mpg123 / ogg-vorbis /
 *    opus / flac…），之后缓存复用。import 是 defer 的 —— 只用 WAV 就永远不联网；
 *    导入失败直接抛异常（沙箱里需要 permissions:["eval"]，联网再加 "network"）。
 *
 *  之所以不内置 MP3：lame / lamejs 只做 MP3 编码，不含解码器（解码在 mpg123 /
 *  mpglib 那边，lamejs 没有暴露），而 audio-decode 是现成的 WASM 封装。
 *
 *  解码结果接受两种形状：
 *    · { sampleRate, channelData: Float32Array[] }         length 取 channelData[0].length
 *    · 一个与 AudioBuffer 同形的对象（sampleRate / numberOfChannels / getChannelData）
 * ==========================================================================*/

/** WAV 特征：RIFF....WAVE */
const sniffWav = (u8) => u8.length >= 12 &&
  u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 &&    // "RIFF"
  u8[8] === 0x57 && u8[9] === 0x41 && u8[10] === 0x56 && u8[11] === 0x45;    // "WAVE"

let audioDecodePromise = null;               // audio-decode 的 import 缓存

/** 懒加载 audio-decode 的解码函数（失败不缓存，下次可重试） */
function loadAudioDecode() {
  if (!audioDecodePromise) {
    audioDecodePromise = import(/* @vite-ignore */ 'audio-decode').then((m) => {
      return m.default ?? m.decode ?? m.decodeAudio;
    }).catch((err) => { audioDecodePromise = null; throw err; });
  }
  return audioDecodePromise;
}

/** 内置 WAV 优先；其余交给懒加载的 audio-decode */
async function decodeAny(bytes) {
  if (sniffWav(bytes)) {
    try { return decodeWav(bytes); }
    catch { /* WAV 的不常见变体（ADPCM / A-law 等）落到通用解码器 */ }
  }
  let decode = await loadAudioDecode();
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return decode(ab);
}

/** 按 (format, bits) 选出该帧的取数函数；不支持返回 null */
function wavSampleReader(format, bits) {
  if (format === 3) {                          // IEEE float
    if (bits === 32) return (dv, o) => dv.getFloat32(o, true);
    if (bits === 64) return (dv, o) => dv.getFloat64(o, true);
  } else if (format === 1) {                   // PCM（整数）
    if (bits === 8) return (dv, o) => dv.getUint8(o) / 128 - 1;            // 8bit 是无符号
    if (bits === 16) return (dv, o) => dv.getInt16(o, true) / 32768;
    if (bits === 24) return (dv, o) => {
      let x = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16);
      if (x & 0x800000) x -= 0x1000000;
      return x / 8388608;
    };
    if (bits === 32) return (dv, o) => dv.getInt32(o, true) / 2147483648;
  }
  return null;
}

/** RIFF/WAVE → { sampleRate, numberOfChannels, channelData, length } */
function decodeWav(u8) {
  if (!sniffWav(u8)) throw new Error('WAV: 缺少 RIFF/WAVE 头');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let fmt = null, dataOff = -1, dataLen = 0;
  for (let p = 12; p + 8 <= u8.byteLength;) {
    const id = String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
    const size = dv.getUint32(p + 4, true);
    const body = p + 8;
    if (id === 'fmt ') {
      fmt = {
        format: dv.getUint16(body, true),
        channels: dv.getUint16(body + 2, true),
        sampleRate: dv.getUint32(body + 4, true),
        blockAlign: dv.getUint16(body + 12, true),
        bits: dv.getUint16(body + 14, true),
      };
      // WAVE_FORMAT_EXTENSIBLE：真正的格式码在 SubFormat GUID 的前 2 字节
      if (fmt.format === 0xFFFE && size >= 40) fmt.format = dv.getUint16(body + 24, true);
    } else if (id === 'data') {
      dataOff = body;
      dataLen = (size === 0 || size === 0xFFFFFFFF) ? u8.byteLength - body
        : Math.min(size, u8.byteLength - body);
    }
    if (fmt && dataOff >= 0) break;
    if (size === 0xFFFFFFFF) break;
    p = body + size + (size & 1);              // 块是偶数字节对齐
  }
  if (!fmt) throw new Error('WAV: 缺 fmt 块');
  if (dataOff < 0) throw new Error('WAV: 缺 data 块');
  const nch = fmt.channels;
  if (!(nch >= 1)) throw new Error('WAV: 声道数非法');
  if (!(fmt.sampleRate > 0)) throw new Error('WAV: 采样率非法');
  const read = wavSampleReader(fmt.format, fmt.bits);
  if (!read) throw new Error(`WAV: 不支持的格式 ${fmt.format} / ${fmt.bits}bit（只支持 PCM 与 IEEE float）`);
  const bps = Math.max(1, Math.ceil(fmt.bits / 8));
  const frameBytes = fmt.blockAlign || nch * bps;
  const frames = Math.max(0, Math.floor(dataLen / frameBytes));
  const channelData = [];
  for (let c = 0; c < nch; c++) channelData.push(new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    const base = dataOff + i * frameBytes;
    for (let c = 0; c < nch; c++) {
      const v = read(dv, base + c * bps);
      channelData[c][i] = v < -1 ? -1 : v > 1 ? 1 : v;
    }
  }
  return { sampleRate: fmt.sampleRate, numberOfChannels: nch, channelData, length: frames };
}

/** 把 audioData 参数统一成 Uint8Array（规范允许 ArrayBuffer / TypedArray） */
function audioDataToBytes(d) {
  if (d instanceof Uint8Array) return d;
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  if (typeof SharedArrayBuffer !== 'undefined' && d instanceof SharedArrayBuffer) return new Uint8Array(d);
  throw new TypeError('decodeAudioData: audioData 必须是 ArrayBuffer 或 TypedArray');
}

/** 线性插值重采样（离线引擎不追求最贵的 sinc，够用且逐采样确定） */
function resampleChannels(channelData, srcRate, dstRate) {
  if (!(srcRate > 0) || srcRate === dstRate) return channelData;
  const n = channelData[0] ? channelData[0].length : 0;
  const outLen = Math.max(0, Math.round(n * dstRate / srcRate));
  const step = srcRate / dstRate;
  const out = [];
  for (let c = 0; c < channelData.length; c++) {
    const s = channelData[c], d = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const x = i * step, i0 = x | 0, f = x - i0;
      const a = i0 < s.length ? s[i0] : 0;
      const b = i0 + 1 < s.length ? s[i0 + 1] : a;
      d[i] = a + (b - a) * f;
    }
    out.push(d);
  }
  return out;
}

/** 任意解码结果 → AudioBuffer（重采样到 targetRate） */
function decodedToAudioBuffer(res, targetRate) {
  let rate, channelData;
  if (res instanceof AudioBuffer || (res && typeof res.getChannelData === 'function' && res.numberOfChannels > 0)) {
    rate = res.sampleRate;
    channelData = [];
    for (let c = 0; c < res.numberOfChannels; c++) channelData.push(res.getChannelData(c));
  } else {
    if (!res || typeof res !== 'object') throw new Error('解码器必须返回 AudioBuffer 或 { sampleRate, channelData }');
    rate = res.sampleRate;
    channelData = res.channelData ?? res.channels;
    if (!Array.isArray(channelData) || !channelData.length) throw new Error('解码器返回值缺少 channelData');
    channelData = channelData.map((a) => a instanceof Float32Array ? a : Float32Array.from(a));
  }
  if (!(rate > 0)) rate = targetRate;
  const chans = resampleChannels(channelData, rate, targetRate);
  const len = chans[0] ? chans[0].length : 0;
  const buf = new AudioBuffer(chans.length, len, targetRate);
  for (let c = 0; c < chans.length; c++) {
    buf.getChannelData(c).set(chans[c].subarray(0, Math.min(chans[c].length, len)), 0);
  }
  return buf;
}

/* ==========================================================================
 *  OfflineAudioContext
 * ==========================================================================*/
class OfflineAudioContext {
  #analysers;
  #channels;
  #curBlock;
  #rendered;
  #resumeWait;
  #running;
  #suspends;
  constructor(a, b, c) {
    let numberOfChannels, length, sampleRate, opts = {};
    if (a !== null && typeof a === 'object') {
      opts = a;
      numberOfChannels = a.numberOfChannels;
      length = a.length;
      sampleRate = a.sampleRate;
    } else {
      numberOfChannels = a;
      length = b;
      sampleRate = c;
    }
    this.sampleRate = Number(sampleRate) > 0 ? Number(sampleRate) : 44100;
    this.length = Math.max(1, Math.floor(Number(length) || 1));
    this.#channels = Math.min(32, Math.max(1, Math.floor(Number(numberOfChannels) || 1)));
    this.destination = new AudioDestinationNode(this, this.#channels);
    this.currentTime = 0;
    this.state = 'suspended';
    this.oncomplete = null;
    this.baseLatency = 0;
    this.audioWorklet = new AudioWorklet(this);
    // 调试开关：关掉"按时间窗剪枝"，用来验证剪枝没有改变任何采样
    this._prune = opts.prune !== false;
    this.#rendered = null;
    this._nodes = [];
    this.#analysers = [];        // 作为"旁路根"每块拉一次（不连 destination 也能取数据）
    this.#suspends = [];         // 按 q（采样位置）排序的挂起点
    this.#resumeWait = null;     // 挂起时等 resume() 的 resolver
    this.#running = false;
    this.#curBlock = -1;
  }

  /* ------------------------------------------------------------- 节点工厂 */
  #mk(node) { this._nodes.push(node); return node; }
  createGain() { return this.#mk(new GainNode(this)); }
  createOscillator() { return this.#mk(new OscillatorNode(this)); }
  createBufferSource() { return this.#mk(new AudioBufferSourceNode(this)); }
  createConstantSource() { return this.#mk(new ConstantSourceNode(this)); }
  createBiquadFilter() { return this.#mk(new BiquadFilterNode(this)); }
  createDelay(maxDelayTime = 1) { return this.#mk(new DelayNode(this, maxDelayTime)); }
  createStereoPanner() { return this.#mk(new StereoPannerNode(this)); }
  createWaveShaper() { return this.#mk(new WaveShaperNode(this)); }
  createDynamicsCompressor() { return this.#mk(new DynamicsCompressorNode(this)); }
  createConvolver() { return this.#mk(new ConvolverNode(this)); }
  createBuffer(numberOfChannels, length, sampleRate) {
    return new AudioBuffer(numberOfChannels, length, sampleRate || this.sampleRate);
  }
  createPeriodicWave(real, imag) {
    return { real: Float32Array.from(real ?? [0, 0]), imag: Float32Array.from(imag ?? [0, 1]) };
  }
  createAnalyser() {
    const a = this.#mk(new AnalyserNode(this));
    this.#analysers.push(a);
    return a;
  }
  createChannelSplitter() { throw new Error('未实现 ChannelSplitterNode'); }
  createChannelMerger() { throw new Error('未实现 ChannelMergerNode'); }
  createPanner() { throw new Error('未实现 PannerNode；请用 createStereoPanner()'); }
  createScriptProcessor(bufferSize = 0, numberOfInputChannels = 2, numberOfOutputChannels = 2) {
    return this.#mk(new ScriptProcessorNode(this, bufferSize, numberOfInputChannels, numberOfOutputChannels));
  }
  /**
   * decodeAudioData(audioData[, successCallback[, errorCallback]])
   *   audioData 是 ArrayBuffer / TypedArray。
   *   内置 WAV（零依赖）；其它格式首次调用时懒加载 audio-decode（见文件后段说明）。
   *   按 context.sampleRate 线性重采样，成功回调 + Promise 两种用法都行。
   */
  decodeAudioData(audioData, successCallback, errorCallback) {
    const sr = this.sampleRate;
    const p = Promise.resolve().then(async () => {
      const bytes = audioDataToBytes(audioData);
      const res = await decodeAny(bytes);
      return decodedToAudioBuffer(res, sr);
    });
    p.then(
      (buf) => { if (typeof successCallback === 'function') successCallback(buf); },
      (err) => { if (typeof errorCallback === 'function') errorCallback(err); },
    );
    return p;
  }
  /**
   * 在指定时间挂起渲染（时间按 128 采样渲染块量化，与规范一致）。
   * 渲染跑到那一刻时 state 变 'suspended'、本 Promise 兑现；调 resume() 继续。
   * 注意：排了挂起就必须对应一次 resume()，否则 startRendering() 的 Promise
   * 永远不会兑现（离线引擎没有超时兜底）。
   */
  suspend(when = 0) {
    return new Promise((resolve, reject) => {
      if (this.#rendered || this.state === 'closed') { reject(new Error('suspend(): 上下文已关闭')); return; }
      const sr = this.sampleRate;
      let q = Math.round((Number(when) || 0) * sr / Q) * Q;
      if (!(q >= 0)) q = 0;
      if (q >= this.length) { reject(new Error('suspend(): 时间不能大于等于总时长')); return; }
      if (this.#running && q <= this.#curBlock) { reject(new Error('suspend(): 该时刻已经渲染过了')); return; }
      for (const s of this.#suspends) if (s.q === q) { reject(new Error('suspend(): 该时刻已排了一个挂起')); return; }
      let i = this.#suspends.length;
      while (i > 0 && this.#suspends[i - 1].q > q) i--;
      this.#suspends.splice(i, 0, { q, resolve, reject });
    });
  }

  resume() {
    return new Promise((resolve, reject) => {
      if (this.state !== 'suspended' || !this.#resumeWait) { reject(new Error('resume(): 当前没有挂起的渲染')); return; }
      const r = this.#resumeWait;
      this.#resumeWait = null;
      this.state = 'running';
      r();
      resolve();
    });
  }

  /* ------------------------------------------------------------- 渲染 */
  /**
   * 一次跑完整条时间线。整除不了 128 的尾巴也按整块算，再截到 length，
   * 这样卷积/延时这些按块对齐的状态不会错位。
   *
   * 有 suspend() 排下的挂起点时，会在对应渲染块的块首停住（state = 'suspended'，
   * currentTime 停在那一刻），等 resume() 再继续；没有挂起点就是纯同步的紧循环。
   * 另外每个块都会把所有 AnalyserNode 当作"旁路根"拉一次，让没接 destination 的
   * 分析器也能拿到数据（已在下游拉过的会命中缓存，不重复计算）。
   */
  async startRendering() {
    if (this.#rendered || this.#running) throw new Error('startRendering() 只能调用一次');
    this.#running = true;
    const ch = this.#channels, len = this.length, sr = this.sampleRate;
    const buf = new AudioBuffer(ch, len, sr);
    const data = [];
    for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
    this.state = 'running';
    const blocks = Math.ceil(len / Q);
    for (let bi = 0; bi < blocks; bi++) {
      const start = bi * Q;
      this.currentTime = start / sr;
      this.#curBlock = start;
      if (this.#suspends.length && this.#suspends[0].q <= start) {
        const at = this.#suspends[0].q;
        while (this.#suspends.length && this.#suspends[0].q <= start) this.#suspends.shift().resolve(this);
        this.currentTime = at / sr;
        this.state = 'suspended';
        await new Promise((resolve) => { this.#resumeWait = resolve; });
      }
      const out = this.destination._getBlock(start, Q);
      for (let i = 0; i < this.#analysers.length; i++) this.#analysers[i]._getBlock(start, Q);
      const n = Math.min(Q, len - start);
      for (let c = 0; c < ch; c++) {
        const src = out[Math.min(c, out.length - 1)];
        data[c].set(n === Q ? src : src.subarray(0, n), start);
      }
    }
    this.currentTime = len / sr;
    this.state = 'closed';
    this.#rendered = buf;
    if (typeof this.oncomplete === 'function') {
      const f = this.oncomplete;
      this.oncomplete = null;
      f({ renderedBuffer: buf, target: this });
    }
    return buf;
  }

  /** 供调试/统计：当前渲染用了多少节点 */
  get nodeCount() { return this._nodes.length; }
}

export { AudioBuffer, AudioParam, OfflineAudioContext, AudioNode, GainNode, OscillatorNode,
  BiquadFilterNode, DelayNode, ConvolverNode, StereoPannerNode, DynamicsCompressorNode,
  AnalyserNode, AudioWorkletNode, AudioWorkletProcessor, ScriptProcessorNode, AudioProcessingEvent };
export default OfflineAudioContext;

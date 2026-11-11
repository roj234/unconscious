## 性能基准

环境：Node 24.16.0，包是 2026/8/1 从 npm 上面下载的 CJS bundle，单位 ops/s。

> 值得注意的是 msgpack-lite 十年没更新了

### 普通编解码（未使用 schema）

| 数据形态 | 库 | encode | decode |
|---|---|---|---|
| 小对象 | **msgpack.js** | **1.67M** | **2.41M** |
| | msgpack-lite | 620k | 1.86M |
| | @msgpack/msgpack | 971k | 2.28M |
| 1000 字段对象 | **msgpack.js** | **16.1k** | **15.6k** |
| | msgpack-lite | 11.0k | 10.5k |
| | @msgpack/msgpack | 16.1k | 3.6k |
| 100 个对象数组 | **msgpack.js** | **79.3k** | **67.4k** |
| | msgpack-lite | 26.8k | 43.0k |
| | @msgpack/msgpack | 77.8k | 64.1k |
| 1000 个数字数组 | **msgpack.js** | **140.6k** | 202.6k |
| | msgpack-lite | 53.4k | 161.0k |
| | @msgpack/msgpack | 118.5k | **203.3k** |
| 10k 字符串 | **msgpack.js** | 39.2k | **1.23M** |
| | msgpack-lite | 20.2k | 31.8k |
| | @msgpack/msgpack | **39.8k** | 1.08M |
| 1KB 二进制 | **msgpack.js** | **2.40M** | **9.63M** |
| | msgpack-lite | 585.8k | 2.25M |
| | @msgpack/msgpack | 1.90M | 7.86M |
| 50 层嵌套 | **msgpack.js** | **253.2k** | **254.1k** |
| | msgpack-lite | 76.0k | 154.9k |
| | @msgpack/msgpack | 230.5k | 226.0k |

> 注：解码只有小对象、1000字段对象两项是完全吊打，剩下的可能随机浮动  
> 编码除字符串和嵌套外都是吊打

### schema 加速（msgpack.js 独有）

| 数据形态 | bytes | encode | decode |
|---|---|---|---|
| 小对象 | -48.5% | +70.6% | +63.5% |
| 20 字段对象 | -46.4% | +10.7% | +44.4% |
| 1000 字段对象 | -44.9% | -3.5% | +117.4% |

### 兼容性

- 与 msgpack-lite、@msgpack/msgpack 交叉解码：**48/48 通过**
- 输出严格符合 MsgPack 标准（二进制使用 bin 格式；msgpack-lite 使用非标准 ext 0x12）
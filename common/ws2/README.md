# ws2 — roj.http.WebSocket / WebSocketResponse 的 Node ESM 翻译 + ws 风格 API

性能不低于 ws，代码更少，以及*是我写的*。  
性能关键模块，例如接收缓冲区，mask/unmask函数，ContinuousFrame类均经过实际Benchmark，确保比 ws 有可观测的快。  
~~（在不使用native的情况下……） 然而并非如此~~

## 额外 API

- **`bufferreleased` 事件**：`send()/ping()/sendFragment()` 等函数传入的 Buffer 不再持有时触发，分片消息在所有分片释放后统一触发，传入字符串也会触发该事件。可用于池化缓冲区的安全复用。
- **`partialmessage` 事件**：监听后延续帧以流式逐分片交付（不再聚合为 `message`），用于超大消息流式处理。
- **`sendFragment(frameType, data, isLast)`**：手动分片发送。
- **`startHeartbeat(intervalMs, timeoutMs)`**：服务端空闲心跳，超时自动关闭。
- **`WebSocketServer` 选项和 `WebSocket` 实例字段**：`fragmentSize`（自动分片大小，默认 0）、`packetLimit`（延续帧聚合后的上限，默认同 maxPayload）。

## 与 ws 的差异（大概有更多）

- `close()` 立即断开（不等对端 echo）
- 收到 close 帧 echo 空载荷（ws 回显原代码）
- 总体性能根据实际负载好 5 - 20%
   - 别看不多，ws每周几千万下载呢，【比它快】本身就足够炫耀了
   - 而且还比他小，我只有40KB代码，它的一半
   - 不过我一直如此。比如我的msgpack也比@msgpack快，哈哈
   - 你说这是为啥？又是“通用性是有代价的”的一部分吗？但是我的API基本兼容啊

## 微基准

我写的mask使用了32/64位整数，比ws快了十倍！
- 但没有意义，你没必要安装任何natives，如bufferutil
- 它根本不是热点，对实际耗时的贡献不如误差，在0.1%-1%量级
- 但微优化是有意义的，因为你可以*到处*做微优化，每个提升0.1%，一百个就提升10%了
- 当然，不如优化架构，优化架构随便就能提升几个百分点
- 更不如优化算法，优化算法随便就能提升几十个甚至几百个百分点
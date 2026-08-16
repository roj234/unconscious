/**
 * ws2 — roj.http.WebSocket / WebSocketResponse 的 Node ESM 翻译 + ws 风格 API。
 *
 * 已知差异:
 *   - close() 立即断开 (不等对端 close 回显)
 *   - 收到 close 帧回显空载荷 close (ws 回显原代码)
 *   - 保留 opcode 抛错断连无 close 帧 (ws 回 1002), 等
 */

import {EventEmitter} from 'node:events';
import http, {createServer} from 'node:http';
import {createHash, randomBytes} from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import {constants as zlibConstants, createDeflateRaw, createInflateRaw} from 'node:zlib';
import {ContinuousFrame} from './_continuous.mjs';
import {mask} from './_mask.mjs';

// 帧类型
const
	FRAME_CONTINUE = 0x0, FRAME_TEXT = 0x1, FRAME_BINARY = 0x2,
	FRAME_CLOSE = 0x8, FRAME_PING = 0x9, FRAME_PONG = 0xa;
const FIN = 0x80;

// region 关闭握手异常代号
/** 正常关闭: 会话正常完成时 */
export const ERR_OK = 1000;
/** 离开: 应用离开且不期望后续连接的尝试而关闭连接时 */
export const ERR_CLOSED = 1001;
/** 协议错误: 因协议错误而关闭连接时 */
export const ERR_PROTOCOL = 1002;
/** 不可接受的数据类型: 非二进制或文本类型时 */
export const ERR_INVALID_FORMAT = 1003;
/** 无效数据: 文本格式错误, 如编码错误 */
export const ERR_INVALID_DATA = 1007;
/** 消息违反政策 */
export const ERR_POLICY = 1008;
/** 消息过大: 当接收的消息太大, 应用程序无法处理时 */
export const ERR_TOO_LARGE = 1009;
/** 需要拓展 */
export const ERR_EXTENSION_REQUIRED = 1010;
/** 意外情况 */
export const ERR_UNEXPECTED = 1011;
// endregion

/** RSV1: 帧携带压缩数据 (permessage-deflate) */
export const RSV_COMPRESS = 0x40;

// region flag 可选位
/** 对等端压缩无上下文 (不跨消息复用字典) */
export const REMOTE_NO_CTX = 0x01;
/** 本地压缩无上下文 */
export const LOCAL_NO_CTX = 0x02;
/** 作为客户端时, 跳过 mask 步骤 (mask 写 0) */
export const CLIENT_SKIP_MASK = 0x04;
/** 对等端允许压缩 (permessage-deflate, 与 RSV_COMPRESS 同位) */
export const COMPRESS_AVAILABLE = 0x40;
/** 服务端 */
const MASK_RECEIVER = 0x80;
// endregion

// 内部 flag 位 (对应 Java __SEND_COMPRESS / __CONTINUOUS_SENDING)
const SEND_COMPRESSING = 0x10;
const CONTINUOUS_SENDING = 0x20;

// 解析状态机
const STATE_HEADER = 0, STATE_LENGTH = 1, STATE_DATA = 2;

const FastBuffer = Buffer[Symbol.species];
const EMPTY_BUFFER = Buffer.alloc(0);
const TRAILER = Buffer.from([0,0,0xff,0xff]);

class RecvBuffer {
	/**
	 * @param {number} factor 扩容倍率 (新容量至多 剩余*factor, 至少 min)
	 * @param {number} min 最小容量
	 */
	constructor(factor = 4, min = 4096) {
		this.factor = factor;
		this.min = min;

		/** @type {Buffer|null} */
		this.buffer = EMPTY_BUFFER;
		this.readIndex = 0;
		this.writeIndex = 0;
	}

	/** @returns {number} 未消费的残留字节数 */
	get remaining() {
		return this.writeIndex - this.readIndex;
	}

	/**
	 * 将残留内容存入内部缓冲 (零拷贝直解路径的兜底)。
	 * @param {Buffer} slice 残留字节视图
	 */
	stash(slice) {
		const capacity = Math.max(this.min, slice.length * this.factor);
		this.buffer = Buffer.allocUnsafe(capacity);
		slice.copy(this.buffer, 0);
		this.readIndex = 0;
		this.writeIndex = slice.length;
	}

	/**
	 * @param {Buffer} chunk 新收到的数据
	 */
	append(chunk) {
		const remaining = this.remaining;

		if (this.buffer.length - this.writeIndex < chunk.length) {
			if (remaining + chunk.length <= this.buffer.length) {
				this.buffer.copyWithin(0, this.readIndex, this.writeIndex);
				this.readIndex = 0;
				this.writeIndex = remaining;
			} else {
				const capacity = Math.max(this.min, remaining * this.factor, remaining + chunk.length);
				const next = Buffer.allocUnsafe(capacity);
				this.buffer.copy(next, 0, this.readIndex, this.writeIndex);
				this.buffer = next;
				this.readIndex = 0;
				this.writeIndex = remaining;
			}
		}

		chunk.copy(this.buffer, this.writeIndex);
		this.writeIndex += chunk.length;
	}

	/**
	 * 记录已消费位置; 全部消费完时归零指针 (下次 onData 回到零拷贝快路径)。
	 * @param {number} consumed 消费到的绝对偏移
	 */
	consume(consumed) {
		this.readIndex = consumed === this.writeIndex ? (this.writeIndex = 0) : consumed;
	}
}

export const CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;

const DEFAULT_MAX_PAYLOAD = 100 * 1024 * 1024;
const DEFAULT_DEFLATE_THRESHOLD = 1024; // ws 的默认压缩阈值

function toBuffer(data) {
	if (Buffer.isBuffer(data)) return data;
	if (typeof data === 'string' || data instanceof ArrayBuffer) return Buffer.from(data);
	if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	throw new TypeError('Unsupported data type: ' + typeof data);
}

/**
 * WS 兼容层的一部分 计划删除
 * @deprecated
 * @param pmd
 * @return {number}
 */
function resolveDeflateThreshold(pmd) {
	if (!pmd) return 0;
	if (pmd === true) return DEFAULT_DEFLATE_THRESHOLD;
	if (typeof pmd === 'object') {
		if (pmd.threshold === false) return 0;
		if (pmd.threshold === 0) return 1;
		return typeof pmd.threshold === 'number' ? pmd.threshold : DEFAULT_DEFLATE_THRESHOLD;
	}
	return DEFAULT_DEFLATE_THRESHOLD;
}

class WS2 extends EventEmitter {
	// region 配置
	/** @type {number} 单条消息最大字节 */
	payloadLimit;
	/** @type {number} 单帧最大字节 */
	packetLimit;
	/** @type {number} 压缩阈值: 非 0 且载荷超过时自动压缩 */
	compressThreshold;
	/** @type {Number} */
	flags;
	/** @type {number} (自动)发送分片大小 */
	fragmentSize ;
	// endregion

	/** @type {number} */
	errCode = 0;
	/** @type {undefined | string} */
	errMsg;

	/** 连接状态: CONNECTING / OPEN / CLOSING / CLOSED */
	readyState = CONNECTING;
	/** 协商的子协议 */
	protocol = '';
	/** 协商的扩展 (permessage-deflate) */
	extensions = '';
	/** 心跳存活标记 (ws 兼容) */
	isAlive = true;

	/** @type {import("node:net").Socket} */
	#socket = null;
	#closeEmitted = false;

	#rb = new RecvBuffer();

	/** 解析状态机: STATE_HEADER / STATE_LENGTH / STATE_DATA */
	#readState = STATE_HEADER;
	/** 当前帧首字节 (含 FIN/RSV/opcode) */
	#frameType = 0;
	/** 当前解析阶段还需的字节数 (LENGTH 阶段为扩展长度字节数, DATA 阶段为载荷+mask钥) */
	#pendingBytes = 0;
	/** 载荷长度 (不含 mask 钥) */
	#payloadLength = 0;

	/** @type {ContinuousFrame} */
	#continuousFrame;

	/** sendClose 调用过 未来大概会删 */
	#terminated = false;

	/** @type {import("node:zlib").DeflateRaw} */
	#deflater;
	#sendQueue = [];
	bufferedAmount = 0;
	deflateWindowBits;

	/** @type {import("node:zlib").InflateRaw} */
	#inflater;
	#recvQueue = [];
	#inflating = false;
	inflateWindowBits;

	/** @type {number} */
	#heartbeatTimer;
	/** @type {number} */
	#lastActivity = Date.now();
	/** @type {boolean} */
	#heartbeatPingSent = false;

	// region 生命周期
	/**
	 * 启动心跳定时器。
	 * @param {number} intervalMs 检查间隔
	 * @param {number} timeoutMs 超时
	 */
	startHeartbeat(intervalMs = 60000, timeoutMs = 10000) {
		this.stopHeartbeat();

		this.#lastActivity = Date.now();
		this.#heartbeatTimer = setInterval(() => {
			const idleMs = Date.now() - this.#lastActivity;

			if (idleMs >= intervalMs) {
				if (!this.#heartbeatPingSent) {
					this.#heartbeatPingSent = true;
					this.#sendFrame(FRAME_PING, EMPTY_BUFFER);
				} else if (idleMs >= (intervalMs + timeoutMs)) {
					this.close(ERR_UNEXPECTED, 'timeout');
					this.isAlive = false;
				}
			}
		}, timeoutMs / 2);
	}

	/** 停止心跳定时器 */
	stopHeartbeat() {
		clearInterval(this.#heartbeatTimer);
	}

	/** @private 绑定 socket 并挂接事件 (服务端/客户端共用) */
	_attach(socket, head) {
		this.readyState = OPEN;
		this.#socket = socket;

		socket.on('data', (chunk) => {
			try {
				this.#onData(chunk);
			} catch (e) {
				this.emit('error', e);
			}
		});

		socket.on('error', (e) => this.emit('error', e));
		socket.on('close', () => this._onClosed());

		if (head?.length) this.#onData(head);
	}

	#endSocket() {
		// Java 侧的语义是 closeOutput
		const socket = this.#socket;
		if (!socket) return;

		socket.end();
		socket.once('finish', socket.destroy);
	}

	_onClosed() {
		this.stopHeartbeat();

		this.#deflater?.close();
		this.#deflater = null;
		this.#inflater?.close();
		this.#inflater = null;

		this.readyState = CLOSED;

		if (!this.#closeEmitted) {
			this.#closeEmitted = true;
			this.emit('close', this.errCode || 1006, this.errMsg ?? '');
		}
	}
	// endregion

	// region 接收路径
	/**
	 * 喂入收到的字节 (对应 Java channelRead)。解压为同步 writeSync, 解析不会中断。
	 * @param {Buffer} chunk 新收到的字节
	 * @throws {Error} 不支持的 opcode 等致命协议错误 (对应 Java 抛 IOException, 适配器应销毁连接)
	 */
	#onData(chunk) {
		this.#lastActivity = Date.now();
		this.#heartbeatPingSent = false;

		const available = this.#rb.remaining;
		if (!available) {
			const consumed = this.#parse(chunk, 0, chunk.length);
			if (consumed < chunk.length) this.#rb.stash(chunk.subarray(consumed));
		} else {
			if (this.#readState === STATE_DATA && available + chunk.length > this.#pendingBytes) {
				const end = this.#pendingBytes - available;

				this.#rb.append(chunk.subarray(0, end));
				this.#rb.consume(this.#parse(this.#rb.buffer, this.#rb.readIndex, this.#rb.writeIndex));

				const consumed = this.#parse(chunk, end, chunk.length);
				if (consumed < chunk.length) this.#rb.stash(chunk.subarray(consumed));
			} else {
				this.#rb.append(chunk);
				this.#rb.consume(this.#parse(this.#rb.buffer, this.#rb.readIndex, this.#rb.writeIndex));
			}
		}
	}

	/**
	 * @param {Buffer} buffer 数据缓冲
	 * @param {number} offset 起始偏移
	 * @param {number} end 结束偏移
	 * @returns {number} 消费到的偏移
	 */
	#parse(buffer, offset, end) {
		while(!this.#terminated) {
		// noinspection FallThroughInSwitchStatementJS
		switch (this.#readState) {
			case STATE_HEADER: {
				if (end - offset < 2) return offset;

				const first = buffer[offset];
				const second = buffer[offset + 1];

				if (((second & 0x80) !== 0) !== ((this.flags & MASK_RECEIVER) !== 0)) {
					return this.close(ERR_PROTOCOL, 'not masked properly'), end;
				}

				const lengthCode = second & 0x7f;
				const extraLengthBytes = lengthCode === 126 ? 2 : lengthCode === 127 ? 8 : 0;
				const opcode = first & 0x0f;

				const isContinue = opcode === 0;
				const isControl = opcode >= 0x8;
				const isCompressed = (first & RSV_COMPRESS) !== 0;
				const isFragmented = (first & FIN) === 0;

				if ((this.flags & COMPRESS_AVAILABLE) === 0 && isCompressed) {
					return this.close(ERR_PROTOCOL, 'illegal RSV1'), end;
				}

				if (isControl) {
					// 控制帧: 不允许扩展长度, 不允许分片
					if (extraLengthBytes !== 0) {
						return this.close(ERR_TOO_LARGE, 'control frame size'), end;
					}

					if (isFragmented) {
						return this.close(ERR_PROTOCOL, 'control frame fragmented'), end;
					}

					if (isCompressed) {
						return this.close(ERR_PROTOCOL, 'control frame compressed'), end;
					}
				}

				let continuousFrame = this.#continuousFrame;
				if (continuousFrame == null) {
					if (isContinue) {
						return this.close(ERR_PROTOCOL, 'Unexpected continuous frame'), end;
					}

					if (isFragmented) {
						continuousFrame = new ContinuousFrame(first);
						this.#continuousFrame = continuousFrame;
					}
				} else if (!isContinue) {
					if (!isControl) {
						return this.close(ERR_PROTOCOL, 'Receive new message in continuous frame'), end;
					}
				}

				this.#frameType = first;
				this.#pendingBytes = extraLengthBytes;
				this.#payloadLength = lengthCode;
				this.#readState = STATE_LENGTH;
				offset += 2;
			}
			case STATE_LENGTH: {
				if (end - offset < this.#pendingBytes) return offset;

				let payloadLength = this.#payloadLength;

				if (payloadLength === 126) {
					payloadLength = buffer.readUint16BE(offset);
					offset += 2;
				} else if (payloadLength === 127) {
					const longLength = buffer.readBigInt64BE(offset);
					offset += 8;

					// Java 原版对 MSB 置位的负数长度会永久挂起, 此处修正为直接拒绝
					if (longLength > BigInt(0x7fffffff - 127)) {
						return this.close(ERR_TOO_LARGE, '>2G'), end;
					}

					payloadLength = Number(longLength);
				}

				let dataSize = payloadLength;
				if ((this.flags & MASK_RECEIVER) !== 0) dataSize += 4;

				if (dataSize > this.packetLimit) {
					return this.close(ERR_TOO_LARGE, null), end;
				}

				this.#payloadLength = payloadLength;
				this.#pendingBytes = dataSize;
				this.#readState = STATE_DATA;
			}
			case STATE_DATA: {
				if (end - offset < this.#pendingBytes) return offset;

				if ((this.flags & MASK_RECEIVER) !== 0) {
					const maskKey = buffer.readUint32BE(offset);
					offset += 4;
					mask(buffer, offset, this.#payloadLength, maskKey);
				}

				const payload = buffer.subarray(offset, offset += this.#payloadLength);

				this.#readState = STATE_HEADER;
				this.#pendingBytes = 0;

				let first = this.#frameType;
				const isControl = (first & 0x0F) >= 0x8;
				const isLast = (first & FIN) !== 0;
				const partial = this.#continuousFrame;

				if (!isControl && partial) {
					first = partial.first;
					if (this.#inflating) {
						this.#recvQueue.push([first, payload, isLast]);
					} else if ((first & RSV_COMPRESS) !== 0) {
						this.#inflate(first, payload, isLast);
					} else {
						this.#emitPartial(first & 0xF, payload, isLast);
					}
				} else {
					if (this.#inflating) {
						this.#recvQueue.push([first, payload, isLast]);
					} else if ((first & RSV_COMPRESS) !== 0) {
						this.#inflate(first, payload, true);
					} else {
						this.#emitFull(first & 0xF, payload);
					}
				}
			}
		}
		}

		return end;
	}

	#emitPartial(frameType, payload, isLast) {
		const partial = this.#continuousFrame;

		if (this.emit('partialmessage', payload, frameType === FRAME_BINARY, isLast)) {
			// partial 模式下不检查 payloadLimit
			if (isLast) this.#continuousFrame = null;
			return;
		}

		if (partial.length + payload.length > this.payloadLimit) {
			partial.clear();
			this.#continuousFrame = null;

			this.close(ERR_TOO_LARGE, null);
			return;
		}

		partial.append(payload);

		if (isLast) {
			try {
				this.emit('message', partial.payload(), frameType === FRAME_BINARY);
			} finally {
				partial.clear();
				this.#continuousFrame = null;
			}
		}
	}
	#emitFull(frameType, payload) {
		switch (frameType) {
			default: this.close(ERR_PROTOCOL, 'Unsupported 0x'+frameType.toString(16)+' frame'); break

			case FRAME_TEXT: this.emit('message', payload, false); break;
			case FRAME_BINARY: this.emit('message', payload, true); break;
			case FRAME_PING:
				if (!this.emit('ping', payload) && payload.length < 125) {
					this.#enqueueFrame(FRAME_PONG | FIN, Buffer.from(payload), false);
				}
				break;
			case FRAME_PONG: this.emit('pong', Buffer.from(payload)); break;

			case FRAME_CLOSE: {
				if (payload.length < 2) { this.close(ERR_CLOSED, 'closed'); return; }

				if (!this.errCode) {
					this.errCode = payload.readUInt16BE(0);
					this.errMsg = payload.toString('utf8', 2);
				}

				try {
					this.close(FRAME_CLOSE, EMPTY_BUFFER);
				} catch {}
				break;
			}
		}
	}

	/**
	 * @param {number} first
	 * @param {Buffer} payload
	 * @param {boolean} isLast 是否为消息的末帧 (FIN)
	 */
	#inflate(first, payload, isLast) {
		this.#inflating = true;
		this.#socket.pause(); // 立即停止，不会再有任何 data 事件发出

		const frameType = first & 0xF;
		let inflate = this.#inflater;

		const partial = this.#continuousFrame;

		const chunks = [];
		let totalLength = 0;

		const onData = chunk => {
			if (partial) {
				this.#emitPartial(frameType, chunk, false);
			} else {
				chunks.push(chunk);
				totalLength += chunk.length;
				if (totalLength > this.packetLimit) {
					inflate.reset();
					this.close(ERR_TOO_LARGE, 'decompressed data exceeds limit');
				}
			}
		};
		const onFlush = () => {
			inflate.off('data', onData);
			if (!this.#inflater) return;

			if (partial && isLast) {
				this.#emitPartial(frameType, EMPTY_BUFFER, true);
			} else {
				this.#emitFull(frameType, chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, totalLength));
			}

			if (isLast && (this.flags & REMOTE_NO_CTX) !== 0) inflate.reset();

			const task = this.#recvQueue.shift();
			if (task) {
				this.#inflate(task[0], task[1], task[2]);
			} else {
				this.#inflating = false;
				this.#socket.resume();
			}
		};

		if (!(first & RSV_COMPRESS)) {
			onData(payload);
			onFlush();
			return;
		}

		if (!inflate) {
			inflate = this.#inflater = createInflateRaw({ windowBits: this.inflateWindowBits });
			inflate.on('error', (e) => {
				this.#socket.resume();
				this.emit('error', e);
				this.close(ERR_INVALID_DATA, 'inflate failed');
			})
		}

		inflate.on('data', onData);

		inflate.write(payload);
		if (isLast) inflate.write(TRAILER);

		inflate.flush(onFlush);
	}
	// endregion
	// region 发送
	/**
	 * 发起关闭握手。
	 * @param {number} code 关闭代号
	 * @param {string|null} [message] 关闭原因 (超过 125 字符截断; 载荷总长按 Java 原版硬截 125 字节)
	 */
	sendClose(code, message) {
		if (message == null) message = '';
		else if (message.length > 125) message = message.substring(0, 125);

		const reason = Buffer.from(message, 'utf8');
		const payload = Buffer.allocUnsafe(2 + reason.length);
		payload.writeUInt16BE(code, 0);
		reason.copy(payload, 2);

		// Java 原版: 载荷超过 125 字节硬截断 (可能截断在 UTF-8 序列中间, 有意保留)
		const truncated = payload.length > 125 ? payload.subarray(0, 125) : payload;

		this.#sendFrame(FRAME_CLOSE, truncated);
		this.#terminated = true;
		this.#endSocket();
	}

	/**
	 * 手动分片发送数据。
	 * TODO 使用Node的流
	 * @param {number} frameType FRAME_TEXT / FRAME_BINARY, 首帧可选配 RSV_COMPRESS
	 * @param {Buffer} data 本分片的数据内容
	 * @param {boolean} isLast 这是最后一个分片
	 */
	sendFragment(frameType, data, isLast) {
		const isFirst = (this.flags & CONTINUOUS_SENDING) === 0;

		if (isFirst) {
			if (isLast) { this.#sendFrame(frameType, data); return; }

			if ((frameType & RSV_COMPRESS) !== 0) {
				if ((this.flags & RSV_COMPRESS) === 0) throw new Error('Invalid compress state');
				this.flags |= SEND_COMPRESSING;
			}

			this.flags |= CONTINUOUS_SENDING;
		} else {
			frameType = isLast ? FIN : FRAME_CONTINUE;
		}

		this.#enqueueFrame(frameType, data, (this.flags & SEND_COMPRESSING) !== 0);

		if (isLast) this.flags &= ~(CONTINUOUS_SENDING | SEND_COMPRESSING);
	}

	/**
	 * 发送一个帧, 自动分片。
	 * 它会持有 data 的只读引用，你不应该修改 data 内的数据
	 * @param {number} frameType FRAME_XXX, 可选配 RSV_COMPRESS
	 * @param {Buffer} data 数据内容
	 */
	#sendFrame(frameType, data) {
		if (frameType >= 0x08) {
			// 控制帧: 不压缩, 不分片
			if ((frameType & RSV_COMPRESS) !== 0) throw new Error('Control frame cannot compress');
			this.#enqueueFrame(frameType | FIN, data, false);
			return;
		}

		if ((this.flags & CONTINUOUS_SENDING) !== 0) throw new Error('sendFragment() not reach EOF');

		const allowCompression = this.flags & RSV_COMPRESS;
		if ((frameType & RSV_COMPRESS) > allowCompression) throw new Error('Invalid compress state');
		if (allowCompression && this.compressThreshold && data.length > this.compressThreshold) {
			frameType |= RSV_COMPRESS;
		}

		const compress = data.length > 0 && (frameType & RSV_COMPRESS) !== 0;

		if (this.fragmentSize && data.length > this.fragmentSize) {
			this.#enqueueFrame(frameType, data.subarray(0, this.fragmentSize), compress, 0);

			let offset = this.fragmentSize;

			// 中间帧: 延续帧
			while (data.length - offset > this.fragmentSize) {
				this.#enqueueFrame(FRAME_CONTINUE, data.subarray(offset, offset + this.fragmentSize), compress, 0);
				offset += this.fragmentSize;
			}

			this.#enqueueFrame(FIN, data.subarray(offset), compress, data);
		} else {
			this.#enqueueFrame(frameType | FIN, data, compress);
		}
	}

	/**
	 * @param {number} frameType 帧首字节
	 * @param {Buffer} data 载荷
	 * @param {boolean} compress 是否压缩
	 * @param {Buffer | any} [_ref]
	 */
	#enqueueFrame(frameType, data, compress, _ref) {
		const ref = _ref ?? data;

		if (!compress && !this.#sendQueue.length) {
			this.#writeFrame(frameType, data, 0, ref);
			return;
		}

		const idx = this.#sendQueue.push([frameType, data, compress, ref]);
		this.bufferedAmount += data.length;
		if (idx === 1) this.#pumpQueue();
	}

	#pumpQueue() {
		const tick = () => {
			let item = this.#sendQueue[0];
			if (!item) return;

			const frameType = item[0], data = item[1], compress = item[2], ref = item[3];
			const submit = (_data, _prefix) => {
				this.#sendQueue.shift();
				this.bufferedAmount -= data.length;

				this.#writeFrame(frameType, _data, _prefix, ref);
				if (_prefix) tick();
				else queueMicrotask(tick);
			}

			if (compress) {
				this.#deflate(data, (frameType & FIN) !== 0, submit, ref);
			} else {
				submit(data);
			}
		};
		tick();
	}

	/**
	 * @param {Buffer} data
	 * @param {boolean} isFinalFrame
	 * @param {function(Buffer): void} callback
	 * @param {Buffer} [ref]
	 */
	#deflate(data, isFinalFrame, callback, ref) {
		const deflate = this.#deflater ??= createDeflateRaw({ windowBits: this.deflateWindowBits });

		const chunks = [];
		let totalLength = 0;

		const onData = (chunk) => {
			chunks.push(chunk);
			totalLength += chunk.length;
		};
		deflate.on('data', onData);

		deflate.write(data);
		deflate.flush(zlibConstants.Z_SYNC_FLUSH, () => {
			deflate.off('data', onData);
			this.#bufferReleased(ref);
			if (!this.#deflater) return;

			// worst case: stored block, 5 bytes
			const prefix = data.length > 65530 ? 16 : 8;
			const target = Buffer.allocUnsafe(totalLength + prefix);
			let offset = prefix;

			for (let i = 0; i < chunks.length; i++) {
				const buf = chunks[i];
				target.set(buf, offset);
				offset += buf.length;
			}

			if (isFinalFrame) {
				offset -= 4;
				if ((this.flags & LOCAL_NO_CTX) !== 0) deflate.reset();
			}

			callback(target.subarray(0, offset), prefix);
		});
	}

	#headBuf = Buffer.allocUnsafe(14);

	/**
	 * @param {number} frameType 帧首字节
	 * @param {Buffer} payload 载荷
	 * @param {number} [sharedPrefix] 共享缓冲区及其前缀
	 * @param {Buffer} [ref]
	 */
	#writeFrame(frameType, payload, sharedPrefix, ref) {
		let payloadLength = payload.length;
		const needMask = (this.flags & MASK_RECEIVER) === 0;
		const maskBit = needMask ? MASK_RECEIVER : 0;

		let buf, realPayload;
		let prefix;
		if (!sharedPrefix) {
			if (needMask) {
				prefix = payloadLength > 0xFFFF ? 16 : 8;
				buf = Buffer.allocUnsafe(payload.length + prefix);
				buf.set(payload, prefix);
				this.#bufferReleased(ref);
			} else {
				prefix = 14;
				buf = this.#headBuf;
				realPayload = payload;
			}
		} else {
			payloadLength -= sharedPrefix;
			prefix = sharedPrefix;
			buf = payload;
		}

		if (needMask) {
			const maskKey = (this.flags & CLIENT_SKIP_MASK) !== 0 ? 0 : this.generateMask();
			if (maskKey) mask(buf, prefix, payloadLength, maskKey);

			buf.writeInt32BE(maskKey, prefix -= 4);
		}

		if (payloadLength <= 125) {
			buf[--prefix] = payloadLength | maskBit;
		} else if (payloadLength <= 65535) {
			buf.writeUInt16BE(payloadLength, prefix -= 2);
			buf[--prefix] = 126 | maskBit;
		} else {
			buf.writeBigUInt64BE(BigInt(payloadLength), prefix -= 8);
			buf[--prefix] = 127 | maskBit;
		}
		buf[--prefix] = frameType;

		const socket = this.#socket;
		if (realPayload) {
			socket.cork();
			socket.write(Buffer.from(buf.subarray(prefix)));
			socket.write(realPayload, () => this.#bufferReleased(ref));
			socket.uncork();
		} else {
			socket.write(buf.subarray(prefix));
		}
	}

	#bufferReleased(buf) {
		if (Buffer.isBuffer(buf)) this.emit("bufferreleased", buf);
	}

	/**
	 * 生成发送 mask 如果有必要可以 override 为更高性能的实现
	 * @returns {number} 32 位 mask
	 */
	generateMask() {
		return (Math.random() * 4294967295) | 0;
	}
	// endregion

	/**
	 * @param {string|Buffer|ArrayBuffer|ArrayBufferView} data
	 * @param {{binary?: boolean}} [options]
	 * @returns {boolean} 是否已入队发送
	 */
	send(data, options = {}) {
		if (this.readyState !== OPEN) return false;
		const binary = typeof options.binary === 'boolean' ? options.binary : typeof data !== 'string';
		this.#sendFrame(binary ? FRAME_BINARY : FRAME_TEXT, toBuffer(data));
		return true;
	}

	ping(data = EMPTY_BUFFER) {
		if (this.readyState === OPEN) this.#sendFrame(FRAME_PING, toBuffer(data));
	}

	pong(data = EMPTY_BUFFER) {
		if (this.readyState === OPEN) this.#sendFrame(FRAME_PONG, toBuffer(data));
	}

	/**
	 * @param {number} [code=ERR_CLOSED]
	 * @param {string} [reason='']
	 */
	close(code = ERR_CLOSED, reason = '') {
		if (this.readyState >= CLOSING) return;
		this.readyState = CLOSING;
		this.errCode = code;
		this.errMsg = reason;
		if (this.#socket) this.sendClose(code, reason);
	}

	terminate() {
		if (this.readyState === CLOSED) return;
		this.readyState = CLOSED;
		this.#endSocket();
	}
}

// ---------------------------------------------------------------- WebSocketServer

const HANDSHAKE_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 默认允许的子协议集合: 仅无子协议 (对应 Java EMPTY_PROTOCOL) */
const EMPTY_PROTOCOL = new Set(['']);

/**
 * 解析 Sec-WebSocket-Extensions 头为 { 元素名: Map<参数名, 参数值|null> }。
 * @param {string|undefined} header 扩展头
 * @returns {Map<string, Map<string, string|null>>} 解析结果
 */
function parseExtensions(header) {
	/** @type {Map<string, Map<string, string|null>>} */
	const elements = new Map();

	if (header == null) return elements;

	for (const element of header.split(',')) {
		const tokens = element.split(';');
		const name = tokens[0].trim().toLowerCase();
		if (name === '') continue;

		const params = elements.get(name) ?? new Map();

		for (let index = 1; index < tokens.length; index++) {
			const param = tokens[index].trim().toLowerCase();
			if (param === '') continue;

			const eq = param.indexOf('=');
			const key = eq < 0 ? param : param.slice(0, eq).trim();
			const value = eq < 0 ? null : param.slice(eq + 1).trim();
			params.set(key, value);
		}

		elements.set(name, params);
	}

	return elements;
}

/** @returns {number} 将窗口位数限制在 DEFLATE 允许范围 (8..15) */
function clampWindowBits(bits) {
	return Number.isFinite(bits) ? Math.min(15, Math.max(8, bits)) : 15;
}

/**
 * Close the connection when preconditions are not fulfilled.
 *
 * @param {Duplex} socket The socket of the upgrade request
 * @param {Number} code The HTTP response status code
 * @param {String} [message] The HTTP response body
 * @param {Object} [headers] Additional HTTP response headers
 * @private
 */
function abortHandshake(socket, code, message, headers) {
	message = message || http.STATUS_CODES[code];
	headers = {
		Connection: 'close',
		'Content-Type': 'text/html',
		'Content-Length': Buffer.byteLength(message),
		...headers
	};

	socket.once('finish', socket.destroy);

	socket.end(
		`HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r\n` +
		Object.keys(headers)
			.map((h) => `${h}: ${headers[h]}`)
			.join('\r\n') +
		'\r\n\r\n' +
		message
	);
}

/**
 * @typedef WSServerOptions
 *
 * @property {number} [port] 监听端口 (与 server 互斥场景同 ws)
 * @property {string} [host]
 * @property {string} [path] 仅接受该路径的升级请求
 * @property {number} [maxPayload=100MB]
 * @property {boolean|object} [perMessageDeflate=false] true/{threshold}/false
 * @property {string[]|Set<string>} [protocols] 允许的子协议
 * @property {number} [fragmentSize=0] 服务端自动发送分片大小, 0 禁用
 * @property {number} [packetLimit] 单帧最大字节 (默认同 maxPayload)
 * @property {function(info: { req: import("node:http").IncomingMessage, secure: boolean, origin: string }, cb: (allowed: boolean, code?: number, message?: string, headers?: Headers) => void)} [verifyClient]
 * @property {import('node:http').Server} [server] 复用 http server
 * @property {boolean} [noServer] 不接管 upgrade, 由调用方调 handleUpgrade
 */

export class WebSocketServer extends EventEmitter {
	#server = null;
	#closed = false;
	/** @type {Set<WebSocket>} 活跃连接 (ws 兼容) */
	clients = new Set();
	/** @type {WSServerOptions} */
	options;
	/**
	 * @param {WSServerOptions} [options]
	 * @param {(ws: WebSocket, req) => void} [callback] 等价于 on('connection')
	 */
	constructor(options = {}, callback) {
		super();

		this.options = {
			...options,
			protocols: options.protocols ? new Set(options.protocols) : EMPTY_PROTOCOL
		};

		if (typeof callback === 'function') this.on('connection', callback);

		this.#server = options.server ?? createServer();

		if (!options.noServer) {
			this.#server.on('upgrade', this.handleUpgrade.bind(this));

			if (options.port != null) {
				this.#server.listen(options.port, options.host);
			}
		}
	}

	/**
	 * @param {import('node:http').IncomingMessage} req
	 * @param {import('node:net').Socket} socket
	 * @param {Buffer} head
	 * @param {(ws: WebSocket, req) => void} [cb]
	 */
	handleUpgrade(req, socket, head, cb) {
		const path = this.options.path;

		if (path != null && (req.url).split('?')[0] !== path) {
			return abortHandshake(socket, 404);
		}

		const version = parseInt(req.headers['sec-websocket-version'], 10);
		const protocols = req.headers['sec-websocket-protocol'] ?? '';
		const allowed = this.options.protocols;
		const protocol = allowed.has(protocols) ? protocols : protocols.split(',').find(p => allowed.has(p.trim()));

		if (!Number.isFinite(version) || version > 13 || null == protocol) {
			return abortHandshake(socket, 503, `Unsupported protocol "${protocols}"`);
		}

		const verify = this.options.verifyClient;

		if (verify) {
			const info = {
				origin: req.headers[`${version === 8 ? 'sec-websocket-origin' : 'origin'}`],
				secure: !!(req.socket.authorized || req.socket.encrypted),
				req
			};
			if (verify.length === 2) {
				verify(info, (verified, code, message, headers) => {
					if (!verified) return abortHandshake(socket, code || 401, message, headers);

					this.#completeUpgrade(protocol, req, socket, head, cb);
				});
				return;
			}

			if (!verify(info)) return abortHandshake(socket, 401);
		} else {
			this.#completeUpgrade(protocol, req, socket, head, cb);
		}
	}
	#completeUpgrade(protocol, req, socket, head, cb) {
		const key = req.headers['sec-websocket-key'];

		let responseLines = `HTTP/1.1 101 Switching Protocols\r
Upgrade: websocket\r
Connection: Upgrade\r
Sec-WebSocket-Version: 13\r
Sec-WebSocket-Accept: ${createHash('sha1').update(key + HANDSHAKE_GUID).digest('base64')}`;

		if (protocol) responseLines += '\r\nSec-WebSocket-Protocol: '+protocol;

		let flags = MASK_RECEIVER;
		const clientExtensions = parseExtensions(req.headers['sec-websocket-extensions']);

		const deflateExt = this.options.perMessageDeflate && clientExtensions.get('permessage-deflate');
		let inflateWindowBits = 15, deflateWindowBits = 15;
		if (deflateExt) {
			const serverParams = ['permessage-deflate'];

			flags |= COMPRESS_AVAILABLE;

			if (deflateExt.has('client_no_context_takeover')) {
				serverParams.push('client_no_context_takeover');
				flags |= REMOTE_NO_CTX;
			}

			const clientWindow = deflateExt.get('client_max_window_bits');
			if (clientWindow !== undefined && clientWindow !== null) {
				inflateWindowBits = clampWindowBits(parseInt(clientWindow, 10));
				serverParams.push('client_max_window_bits=' + inflateWindowBits);
			}

			const serverWindow = deflateExt.get('server_max_window_bits');
			if (serverWindow !== undefined && serverWindow !== null) {
				deflateWindowBits = clampWindowBits(parseInt(serverWindow, 10));
				serverParams.push('server_max_window_bits=' + deflateWindowBits);
			}

			responseLines += '\r\nSec-WebSocket-Extensions: ' + serverParams.join('; ');
		}

		socket.write(responseLines + '\r\n\r\n');

		const ws = new WS2();

		const maxPayload = this.options.maxPayload ?? DEFAULT_MAX_PAYLOAD;
		const compressThreshold =  resolveDeflateThreshold(this.options.perMessageDeflate);

		ws.protocol = protocol;
		ws.payloadLimit = maxPayload;
		ws.packetLimit = this.options.packetLimit ?? maxPayload;
		ws.fragmentSize = this.options.fragmentSize ?? 0;
		ws.compressThreshold = compressThreshold;
		ws.extensions = compressThreshold ? 'permessage-deflate' : '';
		ws.deflateWindowBits = deflateWindowBits;
		ws.inflateWindowBits = inflateWindowBits;
		ws.flags = flags;
		ws._attach(socket, head);

		this.clients.add(ws);
		ws.on('close', () => this.clients.delete(ws));

		if (cb) cb(ws, req);
		this.emit('connection', ws, req);
	}

	/** 关闭服务器 (停止接受新连接; 不主动断开已连接客户端, 同 ws) */
	close(cb) {
		if (this.#closed) {
			if (cb) process.nextTick(cb);
			return;
		}
		this.#closed = true;
		this.#server.close(() => {
			this.emit('close');
			if (cb) cb();
		});
	}

	address() {
		return this.#server.address();
	}

	/** 底层 http server */
	get _server() {
		return this.#server;
	}
}

/**
 * @param {string} [url]
 * @param {object} [options]
 * @param {string[]} [options.protocols]
 * @param {boolean} [options.perMessageDeflate]
 * @param {number} [options.maxPayload=100MB]
 * @param {number} [options.fragmentSize]
 */
export function WebSocket(url, options = {}) {
	const target = new URL(url);
	const isSecure = target.protocol === 'wss:';
	const port = target.port === '' ? (isSecure ? 443 : 80) : Number(target.port);
	const host = target.hostname;

	if (target.protocol !== 'ws:' && !isSecure)
		throw new Error("The URL's scheme "+target.protocol+" is not allowed");

	let socket = isSecure
		? tls.connect({host, port, servername: host})
		: net.connect({host, port});

	const ws = new WS2();

	const {protocols = [], perMessageDeflate = false} = options;

	const onError = (err) => {
		socket?.destroy();
		ws.emit('error', err);
		ws._onClosed();
	};
	const onPreClose = () => {
		if (ws.readyState === CONNECTING) {
			ws.emit('error', new Error('WebSocket was closed before the connection was established'));
			ws._onClosed();
		}
	};

	socket.once('error', onError);
	socket.once('close', onPreClose);

	socket.once(isSecure ? 'secureConnect' : 'connect', () => {
		const key = randomBytes(16).toString('base64');

		const requestLines = [
			`GET ${target.pathname === '' ? '/' : target.pathname}${target.search} HTTP/1.1`,
			`Host: ${host}:${port}`,
			'Upgrade: websocket',
			'Connection: Upgrade',
			`Sec-WebSocket-Key: ${key}`,
			'Sec-WebSocket-Version: 13',
		];

		if (protocols.length > 0) requestLines.push('Sec-WebSocket-Protocol: ' + protocols.join(', '));
		if (perMessageDeflate) requestLines.push('Sec-WebSocket-Extensions: permessage-deflate');

		socket.write(requestLines.join('\r\n') + '\r\n\r\n');

		let recv = new RecvBuffer();

		const onData = (chunk) => {
			recv.append(chunk);

			const responseBuffer = recv.buffer;
			const headerEnd = responseBuffer.indexOf('\r\n\r\n');
			if (headerEnd < 0) {
				if (recv.writeIndex > 8192)
					onError(new Error("Response header too large"));
				return;
			}

			socket.off('data', onData);
			socket.off('error', onError);
			socket.off('close', onPreClose);

			const headText = responseBuffer.toString('latin1', 0, headerEnd);
			const lines = headText.split('\r\n');
			const statusCode = Number(lines[0].split(' ')[1]);

			const headers = {};
			for (let index = 1; index < lines.length; index++) {
				const colon = lines[index].indexOf(':');
				headers[lines[index].slice(0, colon).trim().toLowerCase()] = lines[index].slice(colon + 1).trim();
			}

			const expectedAccept = createHash('sha1').update(key + HANDSHAKE_GUID).digest('base64');

			if (statusCode !== 101 || headers['sec-websocket-accept'] !== expectedAccept) {
				onError(new Error('WebSocket handshake failure: '+lines[0]));
				return;
			}

			if (ws.readyState !== CONNECTING) {
				ws._attach(socket);
				ws.sendClose(ws.errCode, ws.errMsg);
				return;
			}

			let flags = 0;

			const serverExtensions = parseExtensions(headers['sec-websocket-extensions']);
			const deflateExt = serverExtensions.get('permessage-deflate');
			if (deflateExt) {
				flags |= COMPRESS_AVAILABLE;
				if (deflateExt.has('server_no_context_takeover')) flags |= REMOTE_NO_CTX;
				if (deflateExt.has('client_no_context_takeover')) flags |= LOCAL_NO_CTX;
				const cwb = deflateExt.get('client_max_window_bits');
				if (cwb != null) ws.deflateWindowBits = clampWindowBits(parseInt(cwb, 10));
				const swb = deflateExt.get('server_max_window_bits');
				if (swb != null) ws.inflateWindowBits = clampWindowBits(parseInt(swb, 10));
			}

			ws.flags = flags;

			const maxPayload = options.maxPayload ?? DEFAULT_MAX_PAYLOAD;
			ws.payloadLimit = maxPayload;
			ws.packetLimit = options.packetLimit ?? maxPayload;
			ws.fragmentSize = options.fragmentSize ?? 0;
			const threshold = resolveDeflateThreshold(options.perMessageDeflate);
			if (threshold !== 0) ws.compressThreshold = threshold;
			ws.extensions = ws.compressThreshold !== 0 ? 'permessage-deflate' : '';

			ws._attach(socket, responseBuffer.subarray(headerEnd + 4, recv.writeIndex));
			ws.emit('open');
		};

		socket.on('data', onData);
	});

	return ws;
}

/** 等价于 ws 的 WebSocket 常量命名空间 */
WebSocket.CONNECTING = CONNECTING;
WebSocket.OPEN = OPEN;
WebSocket.CLOSING = CLOSING;
WebSocket.CLOSED = CLOSED;

export default WebSocket;

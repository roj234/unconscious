/**
 * @file MsgPack encode & decode.
 * @author Roj234 @ 2025-2026, All rights reserved
 * @module
 *
 * Usage:
 *   MsgPack.encodeMsg(object)
 *   MsgPack.decodeMsg(array | TypedArray | Buffer | DataView, {
 *       bigint: false,
 *       multiple: false,
 *       decodeExt: (dataView, type: number, offset: number, length: number) => any | exception,
 *       schema: ["fieldName" | ["fieldName", schema]]
 *   })
 */

"use strict";

import {AS_IS, UTF8_TEXT_DECODER, UTF8_TEXT_ENCODER} from "../shared.js";

/**
 * Prepares a schema for fast index lookup by adding a `locate` method.
 * Recursively processes nested schemas.
 *
 * @param {Array<string|Array>} schema - The schema to preprocess. Will be mutated in place.
 * @returns {void}
 */
export const bakeSchema = schema => {
	if ("locate" in schema) return;
	Object.defineProperty(schema, "locate", {
		value: (str) => indexOf.get(str) ?? -1,
		configurable: true
	});

	const indexOf = new Map;
	for (let i = 0; i < schema.length; i++) {
		const item = schema[i];
		const isArray = Array.isArray(item);
		indexOf.set(isArray ? item[0] : item, i);
		if (isArray) {
			const [_, child, valueSchema] = item;
			if (child) bakeSchema(child);
			if (valueSchema) bakeSchema(valueSchema);
		}
	}
};

/**
 * A MsgPack schema defines an ordered list of field names.
 * Each element can be either a simple string (a field name) or a tuple `[fieldName, subSchema]`
 * that defines a nested object's structure.
 *
 * @typedef {Array<string|MsgpackSchema>} MsgpackSchema
 */

/**
 * Options for decoding a MsgPack message.
 *
 * @typedef {Object} MsgpackDecodeOptions
 * @property {boolean} [bigint=false] - If true, use BigInt for integers exceeding MAX_SAFE_INTEGER;
 *           otherwise convert them to Number.
 * @property {MsgpackSchema} [schema=null] - Schema to provide field names as integers,
 *           reducing output size.
 * @property {function(dataView: DataView,type: number,offset: number,length: number): any} [decodeExt] -
 *           Custom extension type decoder. Receives (dataView, extType, offset, length) and
 *           must return the decoded value. If not provided, unknown extension types throw an Error.
 * @property {boolean} [multiple=false] - If true, attempt to decode multiple consecutive objects
 *           until the end of the input.
 */

/**
 * Decode a MsgPack‑encoded message from an Array, TypedArray, Buffer, or DataView.
 *
 * @param {Array<number>|Uint8Array|Buffer|DataView} input - The input data.
 * @param {MsgpackDecodeOptions} [options] - Decoding options.
 * @returns {any|any[]} The decoded value, or an array of values if `multiple` is true.
 * @throws {Error} If the input type is not supported.
 */
export const decodeMsg = (input, options) => {
	if (Array.isArray(input)) input = new Uint8Array(input);
	if (ArrayBuffer.isView(input) || (typeof Buffer !== "undefined" && Buffer.isBuffer(input))) input = new DataView(input.buffer, input.byteOffset, input.byteLength);
	else if (!(input instanceof DataView)) throw new Error("不支持的输入: "+input);

	if (options?.multiple) {
		const arr = [];
		let offset = 0, result;
		while (offset < input.byteLength) {
			[result, offset] = decodeRawMsg(input, offset, options);
			arr.push(result);
		}
		return arr;
	} else {
		return decodeRawMsg(input, 0, options)[0];
	}
};

const basicToStringAble = Object.create(null);
basicToStringAble.toString = Object.prototype.toString;
basicToStringAble.valueOf = Object.prototype.valueOf;
Object.freeze(basicToStringAble);

const LOOKUP = /*#__PURE__*/ new Uint8Array(256);
for (let i = 0; i <= 0x7F; i++) LOOKUP[i] = i;
for (let i = 0x80; i <= 0x8F; i++) LOOKUP[i] = 0xBD;
for (let i = 0x90; i <= 0x9F; i++) LOOKUP[i] = 0xBE;
for (let i = 0xA0; i <= 0xBF; i++) LOOKUP[i] = 0xBF;
for (let i = 0xC0; i <= 0xFF; i++) LOOKUP[i] = i;

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

/**
 * @param {Uint8Array} bytes
 * @returns {number}
 */
const djb2Hash = (bytes) => {
	let hash = 5381;
	for (let i = 0; i < bytes.length; i++) {
		hash = Math.imul(hash, 33) ^ bytes[i];
	}
	return hash >>> 0;
};

/**
 * @param {Map<number, [Uint8Array, string, boolean?]>} buckets
 * @param {Uint8Array} bytes
 * @returns {string}
 */
const stringDecodeCache = (buckets, bytes) => {
	const length = bytes.length;
	if (length > 64) return UTF8_TEXT_DECODER.decode(bytes);

	const slot = djb2Hash(bytes);
	const cached = buckets.get(slot);

	if (cached) {
		const [key, str] = cached;
		notFound:
		if (key.length === length) {
			for (let i = 0; i < length; i++)
				if (bytes[i] !== key[i]) break notFound;
			return str;
		}
	}

	const str = UTF8_TEXT_DECODER.decode(bytes);
	const isAscii = bytes.length === str.length;

	if (buckets.size >= 10000) buckets.delete(buckets.keys().next().value);
	buckets.set(slot, [bytes.slice(), str]);

	return str;
}

/**
 * @type {Map<number, [Uint8Array, string, boolean]>}
 */
const keyCache = new Map();

/**
 * Low‑level MsgPack decoder that decodes a single value starting at a given offset.
 *
 * @param {DataView} buf - The buffer view.
 * @param {number} offset - The offset (in bytes) at which to start decoding.
 * @param {MsgpackDecodeOptions} [options={}] - Decoding options.
 * @returns {[any, number]} A tuple containing the decoded value and the new offset
 *          after the consumed bytes.
 * @throws {Error} For invalid tag bytes (0xC1) or unsupported extension types when
 *         no custom `decodeExt` is provided.
 */
export const decodeRawMsg = (buf, offset, options = {}) => {
	let {
		bigint,
		schema,
		decodeExt: decodeExtUser = ((dataView, type, offset, length) => {
			throw new Error("自定义类型: 0x"+type.toString(16));
		})
	} = options;

	const decode = () => {
		const tagByte = buf.getInt8(offset++);

		switch (LOOKUP[tagByte&0xFF]) {
			case 0xC0: return null;
			case 0xC1: throw new Error(`0xC1`);
			case 0xC2: return false;
			case 0xC3: return true;
			case 0xC4: {
				const len = buf.getUint8(offset);
				offset++;
				const value = new Uint8Array(buf.buffer, offset, len);
				offset += len;
				return value;
			}
			case 0xC5: {
				const len = buf.getUint16(offset);
				offset += 2;
				const value = new Uint8Array(buf.buffer, offset, len);
				offset += len;
				return value;
			}
			case 0xC6: {
				const len = buf.getUint32(offset);
				offset += 4;
				const value = new Uint8Array(buf.buffer, offset, len);
				offset += len;
				return value;
			}
			case 0xCA: {
				const value = buf.getFloat32(offset);
				offset += 4;
				return value;
			}
			case 0xCB: {
				const value = buf.getFloat64(offset);
				offset += 8;
				return value;
			}
			case 0xCC: {
				const value = buf.getUint8(offset);
				offset++;
				return value;
			}
			case 0xCD: {
				const value = buf.getUint16(offset);
				offset += 2;
				return value;
			}
			case 0xCE: {
				const value = buf.getUint32(offset);
				offset += 4;
				return value;
			}
			case 0xCF: {
				const value = buf.getBigUint64(offset);
				offset += 8;
				return bigint && value > MAX_SAFE_INTEGER ? value : Number(value);
			}
			case 0xD0: {
				const value = buf.getInt8(offset);
				offset++;
				return value;
			}
			case 0xD1: {
				const value = buf.getInt16(offset);
				offset += 2;
				return value;
			}
			case 0xD2: {
				const value = buf.getInt32(offset);
				offset += 4;
				return value;
			}
			case 0xD3: {
				const value = buf.getBigInt64(offset);
				offset += 8;
				return bigint && value > MAX_SAFE_INTEGER ? value : Number(value);
			}
			case 0xBF: {
				const len = tagByte & 0x1F;
				return readUTF(len);
			}
			case 0xD9: {
				const len = buf.getUint8(offset);
				offset++;
				return readUTF(len);
			}
			case 0xDA: {
				const len = buf.getUint16(offset);
				offset += 2;
				return readUTF(len);
			}
			case 0xDB: {
				const len = buf.getUint32(offset);
				offset += 4;
				return readUTF(len);
			}
			case 0xBE: {
				const size = tagByte & 0x0F;
				return decodeArray(size);
			}
			case 0xDC: {
				const size = buf.getUint16(offset);
				offset += 2;
				return decodeArray(size);
			}
			case 0xDD: {
				const size = buf.getUint32(offset);
				offset += 4;
				return decodeArray(size);
			}
			case 0xBD: {
				const size = tagByte & 0x0F;
				return decodeMap(size);
			}
			case 0xDE: {
				const size = buf.getUint16(offset);
				offset += 2;
				return decodeMap(size);
			}
			case 0xDF: {
				const size =buf.getUint32(offset);
				offset += 4;
				return decodeMap(size);
			}

			case 0xD4: case 0xD5: case 0xD6: case 0xD7: case 0xD8: {
				return decodeExt(1 << (tagByte - 0xD4));
			}
			case 0xC7: {
				const len = buf.getUint8(offset);
				offset++;
				return decodeExt(len);
			}
			case 0xC8: {
				const len = buf.getUint16(offset);
				offset += 2;
				return decodeExt(len);
			}
			case 0xC9: {
				const len = buf.getUint32(offset);
				offset += 4;
				return decodeExt(len);
			}

			default: return tagByte;
		}
	};
	const decodeArray = size => {
		const arr = Array(size);
		for (let i = 0; i < size; i++) {
			arr[i] = decode();
		}
		return arr;
	};
	const decodeMap = schema ? size => {
		const obj = Object.create(basicToStringAble);
		const currSchema = schema;

		for (let i = 0; i < size; i++) {
			let key = decodeMapKey();
			let value;

			ok: {
				if (typeof key === "number") {
					key = currSchema[key];
					if (Array.isArray(key)) {
						let valueSchema;
						[key, schema, valueSchema] = key;
						value = decode();
						value = valueSchema?.[value] ?? value;
						break ok;
					}
				}
				value = decode();
			}

			obj[key] = value;
			schema = currSchema;
		}

		return obj;
	} : size => {
		const obj = Object.create(basicToStringAble);

		for (let i = 0; i < size; i++) {
			const key = decodeMapKey();
			obj[key] = decode();
		}
		return obj;
	};
	const decodeMapKey = () => {
		const tagByte = buf.getInt8(offset++);
		let len;
		switch (LOOKUP[tagByte&0xFF]) {
			case 0xCC:
				len = buf.getUint8(offset);
				offset++;
				return len;
			case 0xCD:
				len = buf.getUint16(offset);
				offset += 2;
				return len;
			case 0xD0:
				len = buf.getInt8(offset);
				offset ++;
				return len;
			case 0xD1:
				len = buf.getInt16(offset);
				offset += 2;
				return len;
			case 0xD2:
				len = buf.getInt32(offset);
				offset += 4;
				return len;

			case 0xBF: len = tagByte & 0x1F; break;
			case 0xD9:
				len = buf.getUint8(offset);
				offset++;
				break;
			case 0xDA:
				len = buf.getUint16(offset);
				offset += 2;
				break;
			case 0xDB:
				len = buf.getUint32(offset);
				offset += 4;
				break;
			default:
				if (tagByte > 0x7F && tagByte <= 0xDF) throw new Error('键必须是字符串或整数: 0x'+tagByte.toString(16));
				return tagByte;
		}

		return readUTF(len);
	};
	const decodeExt = length => {
		const extType = buf.getInt8(offset++);
		let result;
		if (extType === -1) {
			result = decodeTimestamp(offset, length);
		} else {
			result = decodeExtUser(buf, extType, offset, length);
		}

		offset += length;
		return result;
	};
	const decodeTimestamp = (offset, dataLen) => {
		switch (dataLen) {
			case 4: {
				const seconds = buf.getUint32(offset);
				return new Date(seconds * 1000);
			}
			case 8: {
				const data = buf.getBigUint64(offset);
				const nanoseconds = Number(data >> 34n);
				const seconds = Number(data & 0x3FFFFFFFFn);
				return new Date(seconds * 1000 + Math.floor(nanoseconds / 1e6));
			}
			case 12: {
				const nanoseconds = buf.getUint32(offset);
				offset += 4;
				const seconds = buf.getBigInt64(offset);
				return new Date(Number(seconds) * 1000 + Math.floor(nanoseconds / 1e6));
			}
			default:
				throw new Error(`时间戳长度无效: ${dataLen}`);
		}
	};

	const readUTF = length => {
		const utf = stringDecodeCache(keyCache, new Uint8Array(buf.buffer, buf.byteOffset + offset, length));
		offset += length;
		return utf;
	};

	return [decode(), offset];
};

const pow32 = 0x100000000;	 // 2^32
const STATIC_BUFFER = 256;

class MsgpackEncoder {
	#buf = new Uint8Array(STATIC_BUFFER);
	#view = new DataView(this.#buf.buffer);
	/** @type {number} */
	#off;

	/** @type {(chunk: Uint8Array, shared?: boolean) => void} */
	#onChunk;

	/** @type {MsgpackSchema|null} */
	#schema;
	/** @type {(obj: Object) => Object} */
	#replacer;
	/** @type {boolean} */
	#sortKeys;
	/** @type {boolean} */
	#ignoreUndefined;
	/** @type {boolean} */
	#useFloat32;

	/**
	 * @param {any} data
	 * @param {(chunk: Uint8Array, shared?: boolean) => void} onChunk
	 * @param {Object} [options]
	 * @param {MsgpackSchema} [options.schema] 可选 schema，用整数键编码对象字段。
	 * @param {Function} [options.replacer] 编码前转换对象的钩子。
	 * @param {boolean} [options.sortKeys=false] 是否对对象键排序。
	 * @param {boolean} [options.ignoreUndefined=true] 忽略值为 undefined 的字段。
	 * @param {boolean} [options.useFloat32=false] 浮点用 float32 而不是 float64。
	 */
	encode(data, onChunk, options = {}) {
		if (data === undefined) return;

		this.#off = 0;
		this.#onChunk = onChunk;

		this.#schema = options.schema;
		this.#replacer = options.replacer ?? AS_IS;
		this.#sortKeys = options.sortKeys;
		this.#ignoreUndefined = options.ignoreUndefined ?? true;
		this.#useFloat32 = options.useFloat32;

		this.#encode(data);
		this.#flush(1/0);

		this.#onChunk =
		this.#schema =
		this.#replacer = null;
	}

	/**
	 * @param {number} capacity
	 */
	#flush(capacity) {
		if (STATIC_BUFFER < this.#off + capacity && this.#off) {
			this.#onChunk(this.#buf.subarray(0, this.#off), true);
			this.#off = 0;
		}
	}

	/**
	 * 写入一整块字节。
	 * 若内部缓冲区为空，则直接把 bytes 交给回调（零拷贝）。
	 * @param {Uint8Array} bytes
	 */
	#writeBytes(bytes) {
		const length = bytes.length;
		this.#flush(length + 16);
		if (!this.#off) { this.#onChunk(bytes); return; }
		this.#buf.set(bytes, this.#off);
		this.#off += length;
	}

	#encode(val) {
		this.#flush(16);
		switch (typeof val) {
			case "boolean": this.#buf[this.#off++] = val ? 0xc3 : 0xc2; break;
			case "number": this.#encodeNumber(val); break;
			case "bigint": this.#encodeBigint(val); break;
			case "string": this.#encodeString(val); break;
			case "object":
				if (val != null) {
					val = this.#replacer(val);
					const cr = val.constructor;
					if (!cr || cr === Object) {
						this.#encodeObject(val);
					} else if (val instanceof Uint8Array || val instanceof Uint8ClampedArray) {
						this.#encodeBinArray(val);
					} else if (Array.isArray(val) || ArrayBuffer.isView(val)) {
						this.#encodeArray(val);
					} else if (val instanceof Date) {
						this.#encodeDate(val);
					} else {
						throw new TypeError("Not know "+Object.prototype.toString.call(val));
					}
					break;
				}
			// fallthrough: null / undefined
			default: this.#buf[this.#off++] = 0xc0;
		}
	}

	/** @param {number} val */
	#encodeNumber(val) {
		if (Number.isSafeInteger(val)) {
			// 整数
			if (val >= -0x20 && val <= 0x7f) {
				this.#buf[this.#off++] = val;
			} else if (val >= -128 && val <= 255) {
				this.#buf[this.#off++] = val < 0 ? 0xD0 : 0xCC;
				this.#buf[this.#off++] = val;
			} else if (val >= -32768 && val <= 65535) {
				this.#buf[this.#off++] = val < 0 ? 0xD1 : 0xCD;
				this.#view.setUint16(this.#off, val);
				this.#off += 2;
			} else if (val >= -2147483648 && val <= 4294967295) {
				this.#buf[this.#off++] = val < 0 ? 0xD2 : 0xCE;
				this.#view.setUint32(this.#off, val);
				this.#off += 4;
			} else {
				this.#buf[this.#off++] = 0xd3;
				this.#view.setBigInt64(this.#off, BigInt(val));
				this.#off += 8;
			}
		} else {
			if (this.#useFloat32) {
				this.#buf[this.#off++] = 0xca;
				this.#view.setFloat32(this.#off, val);
				this.#off += 4;
			} else {
				this.#buf[this.#off++] = 0xcb;
				this.#view.setFloat64(this.#off, val);
				this.#off += 8;
			}
		}
	}

	/** @param {bigint} val */
	#encodeBigint(val) {
		this.#buf[this.#off++] = 0xD3;
		this.#view.setBigInt64(this.#off, val);
		this.#off += 8;
	}

	/** @param {number} length */
	#encodeStringLength(length) {
		if (length <= 0x1f) {
			this.#buf[this.#off++] = 0xa0 | length;
		} else if (length <= 0xff) {
			this.#buf[this.#off++] = 0xD9;
			this.#buf[this.#off++] = length;
		} else if (length <= 0xffff) {
			this.#buf[this.#off++] = 0xDA;
			this.#view.setUint16(this.#off, length);
			this.#off += 2;
		} else {
			this.#buf[this.#off++] = 0xDB;
			this.#view.setUint32(this.#off, length);
			this.#off += 4;
		}
	}

	/** @param {string} str */
	#encodeString(str) {
		const length = str.length;
		let i = 0;

		const bufferSpace = STATIC_BUFFER - this.#off - 5;
		noPureAscii:
		if (length <= bufferSpace) {
			const initialOffset = this.#off;
			this.#encodeStringLength(length);

			while (i < length) {
				let c = str.charCodeAt(i);
				if (c > 0x7F) { this.#off = initialOffset; break noPureAscii; }
				i++;
				this.#buf[this.#off++] = c;
			}

			return;
		}

		let utfLength = length;
		while (i < length) {
			let c = str.charCodeAt(i++);

			if (c >= 0xd800 && c <= 0xdbff) {
				c = (((c << 10) + str.charCodeAt(i++)) - 0x35fdc00) | 0;
				utfLength--;
			}

			if (c <= 0x7FF) {
				if (c > 0x7F) utfLength++;
			} else {
				if (c > 0xFFFF) utfLength += 3;
				else utfLength += 2;
			}
		}

		this.#encodeStringLength(utfLength);
		this.#flush(utfLength);
		if (utfLength < STATIC_BUFFER) {
			UTF8_TEXT_ENCODER.encodeInto(str, this.#buf.subarray(this.#off));
			this.#off += utfLength;
			this.#flush(16);
		} else {
			this.#writeBytes(UTF8_TEXT_ENCODER.encode(str));
		}
	}

	/** @param {ArrayLike} arr */
	#encodeArray(arr) {
		const length = arr.length;

		if (length <= 0xf) {
			this.#buf[this.#off++] = 0x90 | length;
		} else if (length <= 0xffff) {
			this.#buf[this.#off++] = 0xDC;
			this.#view.setUint16(this.#off, length);
			this.#off += 2;
		} else {
			this.#buf[this.#off++] = 0xDD;
			this.#view.setUint32(this.#off, length);
			this.#off += 4;
		}

		for (let i = 0; i < length; i++) this.#encode(arr[i]);
	}

	/** @param {Uint8Array} arr */
	#encodeBinArray(arr) {
		const length = arr.length;

		if (length <= 0xff) {
			this.#buf[this.#off++] = 0xC4;
			this.#buf[this.#off++] = length;
		} else if (length <= 0xffff) {
			this.#buf[this.#off++] = 0xC5;
			this.#view.setUint16(this.#off, length);
			this.#off += 2;
		} else {
			this.#buf[this.#off++] = 0xC6;
			this.#view.setUint32(this.#off, length);
			this.#off += 4;
		}

		this.#writeBytes(arr);
	}

	/** @param {Object} obj */
	#encodeObject(obj) {
		let keys = Object.keys(obj);
		if (this.#ignoreUndefined) keys = keys.filter(key => obj[key] !== undefined);
		if (this.#sortKeys) keys.sort();
		const length = keys.length;

		if (length <= 0xf) {
			this.#buf[this.#off++] = 0x80 | length;
		} else if (length <= 0xffff) {
			this.#buf[this.#off++] = 0xDE;
			this.#view.setUint16(this.#off, length);
			this.#off += 2;
		} else {
			this.#buf[this.#off++] = 0xDF;
			this.#view.setUint32(this.#off, length);
			this.#off += 4;
		}

		const currSchema = this.#schema;
		if (currSchema) {
			for (let key of keys) {
				let index = currSchema.locate(key);
				let value = obj[key];

				let nextSchema = currSchema;
				if (index >= 0) {
					this.#encodeNumber(index);

					const subSchema = currSchema[index];
					if (Array.isArray(subSchema)) {
						nextSchema = subSchema[1];
						const valueSchema = subSchema[2];
						if (valueSchema) {
							index = valueSchema.locate(value);
							if (index >= 0) value = index;
						}
					}
				} else {
					this.#encodeString(key);
				}

				this.#schema = nextSchema;
				this.#encode(value);
				this.#schema = currSchema;
			}
		} else {
			for (let key of keys) {
				this.#encodeString(key);
				this.#encode(obj[key]);
			}
		}
	}

	/**
	 * @param {Date} date
	 */
	#encodeDate(date) {
		let sec = date.getTime() / 1000;
		if (date.getMilliseconds() === 0 && sec >= 0 && sec < pow32) {
			// 32 位秒 timestamp（timestamp 32）
			this.#view.setUint16(this.#off, 0xD6FF);
			this.#off += 2;
			this.#view.setUint32(this.#off, sec);
			this.#off += 4;
		} else if (sec >= 0 && sec < 0x400000000) {
			// 30 位纳秒 + 34 位秒 timestamp（timestamp 64）
			const ns = date.getMilliseconds() * 1000000;
			this.#writeBytes([
				0xd7, 0xff,
				ns >>> 22, ns >>> 14, ns >>> 6,
				((ns << 2) >>> 0) | (sec / pow32),
				sec >>> 24, sec >>> 16, sec >>> 8, sec,
			]);
		} else {
			// 32 位纳秒 + 64 位秒 timestamp（timestamp 96，允许负数）
			this.#buf[this.#off++] = 0xC7;
			this.#buf[this.#off++] = 12;
			this.#buf[this.#off++] = 0xFF;
			this.#view.setUint32(this.#off, date.getMilliseconds() * 1000000);
			this.#off += 4;
			this.#view.setBigInt64(this.#off, BigInt(Math.floor(sec)));
			this.#off += 8;
		}
	}
}

const sharedEncoder = /*#__PURE__*/ new MsgpackEncoder();
const sharedBuffer = new Uint8Array(4096);

/**
 * Low‑level streaming encoder that writes MsgPack bytes via a callback.
 *
 * @param {any} data - The value to encode.
 * @param {function(Uint8Array, boolean=): void} onChunk - Callback invoked with encoded chunks.
 *        The second argument is `true` for the final chunk (allows the caller to flush buffers).
 *        Receives the object and must return the (possibly modified) object.
 * @param {MsgpackEncodeOptions} [options]
 */
export const encodeRawMsg = (data, onChunk, options) => sharedEncoder.encode(data, onChunk, options);

/**
 * Encode a value into a single MsgPack Uint8Array.
 *
 * @param {any} data - The value to encode.
 * @param {MsgpackSchema} [schema_or_options] - Optional schema for integer‑key encoding of objects.
 * @param {function(Object): Object} [replacer=AS_IS] - Hook to transform objects before encoding.
 *        Receives the object and must return the (possibly modified) object.
 * @returns {Uint8Array} The encoded bytes.
 */
export const encodeMsg = (data, schema_or_options, replacer) => {
	let globalOffset = 0;
	let bufferIsShared = true;
	let buffer = sharedBuffer;
	encodeRawMsg(data, (array) => {
		const length = array.length;
		if (globalOffset + length > buffer.length) {
			const newBuffer = new Uint8Array(Math.max(globalOffset + length + 1024, buffer.length * 1.5));
			newBuffer.set(buffer.subarray(0, globalOffset));
			buffer = newBuffer;
			bufferIsShared = false;
		}
		buffer.set(array, globalOffset);
		globalOffset += length;
	},  schema_or_options?.locate ? {schema: schema_or_options, replacer} : schema_or_options);
	return buffer[bufferIsShared?'slice':'subarray'](0, globalOffset);
}
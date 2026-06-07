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

import {AS_IS, UTF8_TEXT_DECODER, UTF8_TEXT_ENCODER} from "../runtime_shared.js";

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
 * @param {Array<number>|TypedArray|Buffer|DataView} input - The input data.
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

const basicToStringAble = {
	toString: Object.prototype.toString
};

const LOOKUP = /*#__PURE__*/ new Uint8Array(256);
for (let i = 0; i <= 0x7F; i++) LOOKUP[i] = i;
for (let i = 0x80; i <= 0x8F; i++) LOOKUP[i] = 0xBD;
for (let i = 0x90; i <= 0x9F; i++) LOOKUP[i] = 0xBE;
for (let i = 0xA0; i <= 0xBF; i++) LOOKUP[i] = 0xBF;
for (let i = 0xC0; i <= 0xFF; i++) LOOKUP[i] = i;

const {MAX_SAFE_INTEGER} = Number;

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
				schema = null;
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
		const utf = UTF8_TEXT_DECODER.decode(new Uint8Array(buf.buffer, buf.byteOffset + offset, length));
		offset += length;
		return utf;
	};

	return [decode(), offset];
};

const pow32 = 0x100000000;	 // 2^32
const ob = /*#__PURE__*/ new Uint8Array(256);
const buf = /*#__PURE__*/ new DataView(ob.buffer);

/**
 * Low‑level streaming encoder that writes MsgPack bytes via a callback.
 *
 * @param {any} data - The value to encode.
 * @param {function(Uint8Array, boolean=): void} onChunk - Callback invoked with encoded chunks.
 *        The second argument is `true` for the final chunk (allows the caller to flush buffers).
 *        Receives the object and must return the (possibly modified) object.
 * @param {MsgpackSchema} [schema] - Optional schema for integer‑key encoding of objects.
 * @param {function(Object): Object} [replacer=AS_IS] - Hook to transform objects before encoding.
 *        Receives the object and must return the (possibly modified) object.
 */
export const encodeRawMsg = (data, onChunk, schema, replacer) => {
	if (data === undefined) return;

	if (!replacer) replacer = AS_IS;

	let offset = 0;

	//region Encoder
	const ensureCapacity = capacity => {
		if (ob.length < capacity && offset) {
			onChunk(ob.subarray(0, offset), true);
			offset = 0;
		}
	};
	const writeByte = byte => {ob[offset++] = byte;};
	const writeBytes = bytes => {
		const length = bytes.length;
		ensureCapacity(offset+length + 64);
		if (offset === 0) { onChunk(bytes); return; }
		ob.set(bytes, offset);
		offset += length;
	};

	const encode = val => {
		ensureCapacity(offset + 9);
		switch (typeof val) {
			case "boolean": writeByte(val ? 0xc3 : 0xc2); break;
			case "number": encodeNumber(val); break;
			case "bigint": encodeBigint(val); break;
			case "string": encodeString(val); break;
			case "object":
				if (val != null) {
					if (val instanceof Date) encodeDate(val);
					else if (Array.isArray(val)) encodeArray(val);
					else if (ArrayBuffer.isView(val)) {
						if (val instanceof Uint8Array || val instanceof Uint8ClampedArray) encodeBinArray(val);
						else encodeArray(val);
					} else {
						encodeObject(replacer(val));
					}
					break;
				}
			// undefined
			// noinspection FallThroughInSwitchStatementJS
			default: writeByte(0xc0);
		}
	};

	/** @param {Number} val */
	const encodeNumber = val => {
		if (isFinite(val) && Number.isSafeInteger(val)) {
			// Integer
			if (val >= -0x20 && val <= 0x7f) { // Tiny
				writeByte(val);
			}
			else if (val >= -128 && val <= 255) { // int8
				writeByte(val < 0 ? 0xD0 : 0xCC);
				writeByte(val);
			}
			else if (val >= -32768 && val <= 65535) {	 // int16
				writeByte(val < 0 ? 0xD1 : 0xCD);
				buf.setUint16(offset, val);
				offset += 2;
			}
			else if (val >= -2147483648 && val <= 4294967295) { // int32
				writeByte(val < 0 ? 0xD2 : 0xCE);
				buf.setUint32(offset, val);
				offset += 4;
			}
			else { // int64
				writeByte(0xd3);
				buf.setBigInt64(offset, BigInt(val));
				offset += 8;
			}
		}
		else {
			// Float
			writeByte(0xcb);
			buf.setFloat64(offset, val);
			offset += 8;
		}
	};

	/** @param {BigInt} val */
	const encodeBigint = val => {
		writeByte(0xD3);
		buf.setBigInt64(offset, val);
		offset += 8;
	};

	/** @param {string} str */
	const encodeString = str => {
		let bytes = UTF8_TEXT_ENCODER.encode(str);
		let length = bytes.length;

		if (length <= 0x1f) {
			writeByte(0xa0 | length);
		} else if (length <= 0xff) {
			writeByte(0xD9);
			writeByte(length);
		} else if (length <= 0xffff) {
			writeByte(0xDA);
			buf.setUint16(offset, length);
			offset += 2;
		} else {
			writeByte(0xDB);
			buf.setUint32(offset, length);
			offset += 4;
		}

		writeBytes(bytes);
	};

	/** @param {Array} arr */
	const encodeArray = arr => {
		const length = arr.length;

		if (length <= 0xf) {
			writeByte(0x90 | length);
		} else if (length <= 0xffff) {
			writeByte(0xDC);
			buf.setUint16(offset, length);
			offset += 2;
		} else {
			writeByte(0xDD);
			buf.setUint32(offset, length);
			offset += 4;
		}

		for (let i = 0; i < length; i++) encode(arr[i]);
	};

	/** @param {Uint8Array | Uint8ClampedArray} arr */
	const encodeBinArray = arr => {
		const length = arr.length;

		if (length <= 0xff) {
			writeByte(0xC4);
			writeByte(length);
		} else if (length <= 0xffff) {
			writeByte(0xC5);
			buf.setUint16(offset, length);
			offset += 2;
		} else {
			writeByte(0xC6);
			buf.setUint32(offset, length);
			offset += 4;
		}

		writeBytes(arr);
	};

	/** @param {Object} obj */
	const encodeObject = obj => {
		const keys = Object.keys(obj).filter(key => obj[key] !== undefined);
		let length = keys.length;

		if (length <= 0xf) {
			writeByte(0x80 | length);
		} else if (length <= 0xffff) {
			writeByte(0xDE);
			buf.setUint16(offset, length);
			offset += 2;
		} else {
			writeByte(0xDF);
			buf.setUint32(offset, length);
			offset += 4;
		}

		if (schema) {
			const currSchema = schema;
			for (let key of keys) {
				let index = currSchema.locate(key);
				let value = obj[key];
				if (index >= 0) {
					encodeNumber(index);

					const s = currSchema[index];
					if (Array.isArray(s)) {
						let key_, valueSchema;
						[key_, schema, valueSchema] = s;
						if (valueSchema) {
							index = valueSchema.locate(value);
							if (index >= 0) value = index;
						}
					} else {
						schema = null;
					}
				} else {
					encodeString(key);
					schema = null;
				}

				encode(value);
				schema = currSchema;
			}
		} else {
			for (let key of keys) {
				encodeString(key);
				encode(obj[key]);
			}
		}
	};

	/** @param {Date} date */
	const encodeDate = date => {
		let sec = date.getTime() / 1000;
		if (date.getMilliseconds() === 0 && sec >= 0 && sec < pow32) {	 // 32 bit seconds
			buf.setUint16(offset, 0xD6FF);
			offset += 2;
			buf.setUint32(offset, sec);
			offset += 4;
		}
		else if (sec >= 0 && sec < 0x400000000) {	 // 30 bit nanoseconds, 34 bit seconds
			let ns = date.getMilliseconds() * 1000000;
			writeBytes([0xd7, 0xff, ns >>> 22, ns >>> 14, ns >>> 6, ((ns << 2) >>> 0) | (sec / pow32), sec >>> 24, sec >>> 16, sec >>> 8, sec]);
		}
		else {	 // 32 bit nanoseconds, 64 bit seconds, negative values allowed
			ensureCapacity(offset + 15);
			writeByte(0xC7);
			writeByte(12);
			writeByte(0xFF);
			buf.setUint32(offset, date.getMilliseconds() * 1000000);
			offset += 4;
			buf.setBigInt64(offset, BigInt(Math.floor(sec)));
			offset += 8;
		}
	};
	//endregion

	encode(data);
	ensureCapacity(1/0);
};

/**
 * Encode a value into a single MsgPack Uint8Array.
 *
 * @param {any} data - The value to encode.
 * @param {MsgpackSchema} [schema] - Optional schema for integer‑key encoding of objects.
 * @param {function(Object): Object} [replacer=AS_IS] - Hook to transform objects before encoding.
 *        Receives the object and must return the (possibly modified) object.
 * @returns {Uint8Array} The encoded bytes.
 */
export const encodeMsg = (data, schema, replacer) => {
	let globalOffset = 0;
	let buffer = new Uint8Array(1024);
	encodeRawMsg(data, (array) => {
		const length = array.length;
		if (globalOffset + length > buffer.length) {
			const newBuffer = new Uint8Array(Math.max(globalOffset + length + 1024, buffer.length * 1.5));
			newBuffer.set(buffer.subarray(0, globalOffset));
			buffer = newBuffer;
		}
		buffer.set(array, globalOffset);
		globalOffset += length;
	}, schema, replacer);
	return buffer.subarray(0, globalOffset);
}
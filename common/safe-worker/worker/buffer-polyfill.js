import {base64DecodeToUint8Array, base64Encode} from "../../Base64.js";
import {UTF8_TEXT_DECODER, UTF8_TEXT_ENCODER} from "../../../shared.js";

const _TE = UTF8_TEXT_ENCODER;
const UTF8_TD = UTF8_TEXT_DECODER;
const UTF16LE_TD = new TextDecoder("utf-16le");
const UTF16BE_TD = new TextDecoder("utf-16be");
const _TD2 = new TextDecoder('latin1');
const _HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

const _hexDecode = str => {
	if (str.length & 1) throw new TypeError('Invalid hex string');
	const len = str.length >>> 1;
	const out = new Uint8Array(len);
	for (let i = 0; i < len; i++) out[i] = parseInt(str.slice(i << 1, 2), 16);
	return out;
};

const _hexEncode = (buf, start, end) => {
	start ??= 0; end ??= buf.length;
	let s = '';
	for (let i = start; i < end; i++) s += _HEX[buf[i]];
	return s;
};

const _b64Len = s =>  ((s + 3) / 4 | 0) * 3;
const _latin1Decode = str => Array.from(str, x => x.charCodeAt(0));

const _ENCODERS = {
	'utf8':   { decode: s => _TE.encode(s),           encode: (b, s, e) => UTF8_TD.decode(b.subarray(s ?? 0, e ?? b.length)), blen: s => _TE.encode(s).length },
	'hex':    { decode: _hexDecode,                   encode: _hexEncode, blen: s => s.length >>> 1 },
	'base64': { decode: base64DecodeToUint8Array,     encode: (buf, start, end) => base64Encode(buf.subarray(start ?? 0, end ?? buf.length)), blen: _b64Len },
	'base64url': { decode: base64DecodeToUint8Array,  encode: (buf, start, end) => base64Encode(buf.subarray(start ?? 0, end ?? buf.length), 1), blen: _b64Len },
	'latin1': { decode: _latin1Decode,                encode: (buf, start, end) => _TD2.decode(buf.subarray(start ?? 0, end ?? buf.length)), blen: s => s.length },
	'utf16le': {
		decode: str => {
			const out = new Uint8Array(str.length * 2);
			for (let i = 0; i < str.length; i++) {
				const c = str.charCodeAt(i);
				out[i * 2] = c;
				out[i * 2 + 1] = (c >>> 8);
			}
			return out;
		},
		encode: (b, s, e) => UTF16LE_TD.decode(b.subarray(s ?? 0, e ?? b.length)),
		blen: s => s.length * 2
	},
	'utf16be': {
		decode: str => {
			const out = new Uint8Array(str.length * 2);
			for (let i = 0; i < str.length; i++) {
				const c = str.charCodeAt(i);
				out[i * 2] = (c >>> 8);
				out[i * 2 + 1] = c;
			}
			return out;
		},
		encode: (b, s, e) => UTF16BE_TD.decode(b.subarray(s ?? 0, e ?? b.length)),
		blen: s => s.length * 2
	},
};
_ENCODERS['utf-8'] = _ENCODERS['utf8'];
_ENCODERS['binary'] = _ENCODERS['latin1'];

const _encoder = enc => {
	enc = (enc || 'utf8').toLowerCase();
	const e = _ENCODERS[enc];
	if (!e) throw new TypeError(`Unknown encoding: ${enc}`);
	return e;
};

const _assertUint8Array = (v, label) => {
	if (!(v instanceof Uint8Array)) throw new TypeError(`${label} must be a Buffer or Uint8Array`);
};

// ── Buffer class ───────────────────────────────────────────────────────

function resolveNeedle(value, encoding) {
	if (typeof value === 'string') {
		return _encoder(encoding).decode(value);
	} else if (typeof value === 'number') {
		return new Uint8Array([value & 0xff]);
	} else if (value instanceof Uint8Array) {
		return value;
	} else {
		throw new TypeError('"value" must be a string, number, Buffer, or Uint8Array');
	}
}

class Buffer extends Uint8Array {
	#dataView;

	// ── Static constructors ──────────────────────────────────────────

	static alloc(size, fill, encoding) {
		if (!Number.isInteger(size) || size < 0) throw new TypeError('"size" must be a non-negative integer');
		const buf = new Buffer(size);
		if (fill !== undefined) buf.fill(fill, 0, size, encoding);
		return buf;
	}

	static allocUnsafe(size) {
		if (!Number.isInteger(size) || size < 0) throw new TypeError('"size" must be a non-negative integer');
		return new Buffer(size);
	}

	static allocUnsafeSlow(size) {
		return Buffer.allocUnsafe(size);
	}

	/** Create a Buffer from a string, ArrayBuffer, TypedArray, Array, or array-like. */
	static from(value, offsetOrEncoding, length) {
		if (typeof value === 'string') {
			return new Buffer(_encoder(offsetOrEncoding).decode(value));
		}
		if (Array.isArray(value)) {
			return new Buffer(value);
		}
		if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)) {
			return new Buffer(value, offsetOrEncoding || 0, length);
		}
		if (ArrayBuffer.isView(value)) {
			// copy
			return new Buffer(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
		}
		if (value != null && typeof value === 'object' && typeof value.length === 'number') {
			return new Buffer(value);
		}
		throw new TypeError('First argument must be a string, Buffer, ArrayBuffer, Array, or array-like object.');
	}

	static concat(list, totalLength) {
		if (!Array.isArray(list)) throw new TypeError('"list" must be an Array');
		if (list.length === 0) return Buffer.alloc(0);
		if (totalLength === undefined) totalLength = list.reduce((a, b) => a + b.length, 0);
		const out = Buffer.allocUnsafe(totalLength);
		let off = 0;
		for (const buf of list) {
			_assertUint8Array(buf, 'list element');
			out.set(buf, off);
			off += buf.length;
		}
		return out;
	}

	static compare(a, b) {
		_assertUint8Array(a, 'buf1');
		_assertUint8Array(b, 'buf2');
		for (let i = 0; i < Math.min(a.length, b.length); i++) {
			if (a[i] !== b[i]) return a[i] - b[i];
		}
		return a.length - b.length;
	}

	static isBuffer(obj) { return obj instanceof Buffer; }

	static byteLength(string, encoding) {
		if (typeof string === 'string') return _encoder(encoding).blen(string);
		if (ArrayBuffer.isView(string)) return string.byteLength;
		if (string instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && string instanceof SharedArrayBuffer)) return string.byteLength;
		throw new TypeError('"string" must be a string, Buffer, or ArrayBuffer');
	}

	static isEncoding(enc) { return enc != null && _ENCODERS[enc.toLowerCase()] !== undefined; }

	// ── Conversion / inspection ──────────────────────────────────────

	toString(encoding, start, end) { return _encoder(encoding).encode(this, start, end); }

	toJSON() { return { type: 'Buffer', data: Array.from(this) }; }

	// ── Manipulation ─────────────────────────────────────────────────

	slice(start, end) { return this.subarray(start, end); }

	copy(target, targetStart, sourceStart, sourceEnd) {
		_assertUint8Array(target, 'target');
		targetStart ??= 0;
		sourceStart ??= 0;
		sourceEnd ??= this.length;
		target.set(this.subarray(sourceStart, sourceEnd), targetStart);
		return Math.min(sourceEnd - sourceStart, target.length - targetStart);
	}

	fill(value, offset, end, encoding) {
		offset ??= 0; end ??= this.length;
		let byteVal;
		if (typeof value === 'string') {
			if (value.length === 0) return this;
			byteVal = _encoder(encoding).decode(value)[0];
		} else if (typeof value === 'number') {
			byteVal = value & 0xff;
		} else if (value instanceof Uint8Array) {
			byteVal = value[0];
		} else {
			throw new TypeError('"value" must be a string, number, Buffer, or Uint8Array');
		}
		for (let i = offset; i < end; i++) this[i] = byteVal;
		return this;
	}

	equals(other) {
		if (!(other instanceof Uint8Array) || this.length !== other.length) return false;
		for (let i = 0; i < this.length; i++) if (this[i] !== other[i]) return false;
		return true;
	}

	compare(other, targetStart, targetEnd, sourceStart, sourceEnd) {
		sourceStart ??= 0; sourceEnd ??= this.length;
		targetStart ??= 0; targetEnd ??= other.length;
		const a = this.subarray(sourceStart, sourceEnd);
		const b = other instanceof Uint8Array ? other.subarray(targetStart, targetEnd) : new Uint8Array(0);
		for (let i = 0; i < Math.min(a.length, b.length); i++) {
			if (a[i] !== b[i]) return a[i] - b[i];
		}
		return a.length - b.length;
	}

	indexOf(value, byteOffset, encoding) {
		byteOffset = Math.trunc(byteOffset ?? 0);
		if (byteOffset < 0) byteOffset = 0;
		const needle = resolveNeedle(value, encoding);
		if (needle.length === 0) return byteOffset <= this.length ? byteOffset : -1;
		const limit = this.length - needle.length;
		outer: for (let i = byteOffset; i <= limit; i++) {
			for (let j = 0; j < needle.length; j++) {
				if (this[i + j] !== needle[j]) continue outer;
			}
			return i;
		}
		return -1;
	}

	lastIndexOf(value, byteOffset, encoding) {
		byteOffset = Math.trunc(byteOffset ?? this.length - 1);
		if (byteOffset >= this.length) byteOffset = this.length - 1;
		const needle = resolveNeedle(value, encoding);
		if (needle.length === 0) return byteOffset >= 0 ? byteOffset : -1;
		if (byteOffset < 0) return -1;
		const start = Math.min(byteOffset, this.length - needle.length);
		outer: for (let i = start; i >= 0; i--) {
			for (let j = 0; j < needle.length; j++) {
				if (this[i + j] !== needle[j]) continue outer;
			}
			return i;
		}
		return -1;
	}

	includes(value, byteOffset, encoding) {
		return this.indexOf(value, byteOffset, encoding) !== -1;
	}

	write(string, offset, length, encoding) {
		offset ??= 0;
		length ??= this.length - offset;
		const bytes = _encoder(encoding).decode(string);
		const toWrite = bytes.subarray(0, Math.min(length, bytes.length));
		this.set(toWrite, offset);
		return toWrite.length;
	}

	// ── Endianness swaps ─────────────────────────────────────────────

	swap16() { for (let i = 0; i < this.length - 1; i += 2) { const t = this[i]; this[i] = this[i + 1]; this[i + 1] = t; } return this; }
	swap32() { for (let i = 0; i < this.length - 3; i += 4) { const t = this[i]; this[i] = this[i + 3]; this[i + 3] = t; const u = this[i + 1]; this[i + 1] = this[i + 2]; this[i + 2] = u; } return this; }
	swap64() { for (let i = 0; i < this.length - 7; i += 8) { const t = this[i]; this[i] = this[i + 7]; this[i + 7] = t; const u = this[i + 1]; this[i + 1] = this[i + 6]; this[i + 6] = u; const v = this[i + 2]; this[i + 2] = this[i + 5]; this[i + 5] = v; const w = this[i + 3]; this[i + 3] = this[i + 4]; this[i + 4] = w; } return this; }

	// ── Read methods ─────────────────────────────────────────────────

	#dv()   { return this.#dataView || (this.#dataView = new DataView(this.buffer, this.byteOffset, this.byteLength)); }
	#chk(off, sz) { if (off < 0 || off + sz > this.length) throw new RangeError(`Offset ${off} + size ${sz} exceeds length ${this.length}`); }

	readUInt8(o, n)       { !n&&this.#chk(o, 1); return this[o]; }
	readUInt16LE(o, n)    { !n&&this.#chk(o, 2); return this.#dv().getUint16(o, true); }
	readUInt16BE(o, n)    { !n&&this.#chk(o, 2); return this.#dv().getUint16(o); }
	readUInt32LE(o, n)    { !n&&this.#chk(o, 4); return this.#dv().getUint32(o, true); }
	readUInt32BE(o, n)    { !n&&this.#chk(o, 4); return this.#dv().getUint32(o); }
	readInt8(o, n)        { !n&&this.#chk(o, 1); return this.#dv().getInt8(o); }
	readInt16LE(o, n)     { !n&&this.#chk(o, 2); return this.#dv().getInt16(o, true); }
	readInt16BE(o, n)     { !n&&this.#chk(o, 2); return this.#dv().getInt16(o); }
	readInt32LE(o, n)     { !n&&this.#chk(o, 4); return this.#dv().getInt32(o, true); }
	readInt32BE(o, n)     { !n&&this.#chk(o, 4); return this.#dv().getInt32(o); }
	readFloatLE(o, n)     { !n&&this.#chk(o, 4); return this.#dv().getFloat32(o, true); }
	readFloatBE(o, n)     { !n&&this.#chk(o, 4); return this.#dv().getFloat32(o); }
	readDoubleLE(o, n)    { !n&&this.#chk(o, 8); return this.#dv().getFloat64(o, true); }
	readDoubleBE(o, n)    { !n&&this.#chk(o, 8); return this.#dv().getFloat64(o); }
	readBigUInt64LE(o, n) { !n&&this.#chk(o, 8); return this.#dv().getBigUint64(o, true); }
	readBigUInt64BE(o, n) { !n&&this.#chk(o, 8); return this.#dv().getBigUint64(o); }
	readBigInt64LE(o, n)  { !n&&this.#chk(o, 8); return this.#dv().getBigInt64(o, true); }
	readBigInt64BE(o, n)  { !n&&this.#chk(o, 8); return this.#dv().getBigInt64(o); }

	// ── Write methods ────────────────────────────────────────────────

	writeUInt8(v, o, n)         { !n&&this.#chk(o, 1); this[o] = v & 0xff; return o + 1; }
	writeUInt16LE(v, o, n)      { !n&&this.#chk(o, 2); this.#dv().setUint16(o, v, true); return o + 2; }
	writeUInt16BE(v, o, n)      { !n&&this.#chk(o, 2); this.#dv().setUint16(o, v, false); return o + 2; }
	writeUInt32LE(v, o, n)      { !n&&this.#chk(o, 4); this.#dv().setUint32(o, v, true); return o + 4; }
	writeUInt32BE(v, o, n)      { !n&&this.#chk(o, 4); this.#dv().setUint32(o, v, false); return o + 4; }
	writeInt8(v, o, n)          { !n&&this.#chk(o, 1); this.#dv().setInt8(o, v); return o + 1; }
	writeInt16LE(v, o, n)       { !n&&this.#chk(o, 2); this.#dv().setInt16(o, v, true); return o + 2; }
	writeInt16BE(v, o, n)       { !n&&this.#chk(o, 2); this.#dv().setInt16(o, v, false); return o + 2; }
	writeInt32LE(v, o, n)       { !n&&this.#chk(o, 4); this.#dv().setInt32(o, v, true); return o + 4; }
	writeInt32BE(v, o, n)       { !n&&this.#chk(o, 4); this.#dv().setInt32(o, v, false); return o + 4; }
	writeFloatLE(v, o, n)       { !n&&this.#chk(o, 4); this.#dv().setFloat32(o, v, true); return o + 4; }
	writeFloatBE(v, o, n)       { !n&&this.#chk(o, 4); this.#dv().setFloat32(o, v, false); return o + 4; }
	writeDoubleLE(v, o, n)      { !n&&this.#chk(o, 8); this.#dv().setFloat64(o, v, true); return o + 8; }
	writeDoubleBE(v, o, n)      { !n&&this.#chk(o, 8); this.#dv().setFloat64(o, v, false); return o + 8; }
	writeBigUInt64LE(v, o, n)   { !n&&this.#chk(o, 8); this.#dv().setBigUint64(o, v, true); return o + 8; }
	writeBigUInt64BE(v, o, n)   { !n&&this.#chk(o, 8); this.#dv().setBigUint64(o, v, false); return o + 8; }
	writeBigInt64LE(v, o, n)    { !n&&this.#chk(o, 8); this.#dv().setBigInt64(o, v, true); return o + 8; }
	writeBigInt64BE(v, o, n)    { !n&&this.#chk(o, 8); this.#dv().setBigInt64(o, v, false); return o + 8; }
}

Object.defineProperty(Buffer, Symbol.species, { value: Buffer, configurable: true });
Object.defineProperty(Buffer.prototype, Symbol.toStringTag, { value: 'Buffer', configurable: true });

// Node.js compat
Buffer.Buffer = Buffer;

export { Buffer };
export default Buffer;

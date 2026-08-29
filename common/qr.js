// qr.js — Fastest JavaScript QRCode pattern generator. < 5999 bytes minified, ~2800 bytes gzipped.
// - Minified with BYTE_ONLY flag and Canvas backend only (ideal for browser). other backends are tree-shared.
// - For Smart mode (no BYTE_ONLY), ~7.5 KiB minified.
// - Require ~2.2KiB RAM for constants.

const BYTE_ONLY = false;

'use strict';

// ---------------------------------------------------------------------------
// Reed-Solomon over GF(256), primitive polynomial 0x11d (x^8+x^4+x^3+x^2+1)
// ---------------------------------------------------------------------------
import {UTF8_TEXT_ENCODER} from "../shared.js";

// branchless gfMul
const EXP = new Uint8Array(512 + 511);
const LOG = new Uint16Array(256);

for (let i = 0; i < 8; i++) EXP[i] = (1 << i);
for (let i = 8; i < 256; i++) EXP[i] = (EXP[i - 4] ^ EXP[i - 5] ^ EXP[i - 6] ^ EXP[i - 8]);
for (let i = 0; i < 255; i++) LOG[EXP[i]&255] = i;
for (let i = 255; i < 511; i++) EXP[i] = EXP[i - 255];
LOG[0] = 511;

/**
 * 使用LFSR算法计算RS纠错码
 * @param {Uint8Array} ec
 * @param {Uint16Array} logGen 生成多项式的对数
 * @param {number} ecLength
 * @param {Uint8Array} data
 */
const batchLFSR = (ec, logGen, ecLength, data) => {
	for (let i = 0; i < data.length; i++) {
		const input = data[i];
		const feedback = ec[0] ^ input;
		const logFeedback = LOG[feedback];

		const last = ecLength - 1;
		for (let j = 0; j < last; j++) {
			// 预计算 LOG[gen[j]]
			ec[j] = ec[j + 1] ^ EXP[logGen[j] + logFeedback];
		}
		ec[last] = EXP[logGen[last] + logFeedback];
	}
};

/**
 * 计算生成多项式的对数，使用Uint16Array以实现无分支乘法
 * @param {number} size
 * @return {Uint16Array}
 */
const gfGenPolyLog = size => {
	const poly = new Uint8Array(size + 1);
	poly[0] = 1;

	let lambdaLen = 0;
	for (let i = 0; i < size; i++) {
		for (let j = lambdaLen; j >= 0; j--) {
			poly[j + 1] ^= EXP[LOG[poly[j]] + i];
		}
		lambdaLen++;
	}

	const logGen = new Uint16Array(size);
	for (let i = 0; i < size;) logGen[i++] = LOG[poly[i]];
	return logGen;
};

// numeric value embedded in format info (top 2 bits): L=1 M=0 Q=3 H=2
const LEVEL_BIT = { M: 0, L: 1, H: 2, Q: 3 };
// For each (version-1) + ecIndex*40 the flat list:
//   [shortBlocks, dataLength, ecLength, longBlocks?]
const RS_PATTERNS = new Uint8Array(4 * 4 * 40);

{

// 使用 delta 编码以压缩文件大小
const RS_BLOCKS_ACC = Int8Array.of(
	1, 0, 0, 1, 0, 2, 0, 0, 1, 0, 0, 3, 1, 0, 1, 0, 1, 2, 1, 2, 1, 0, 1, 2, 1, 2, 2, 1, 2, 1, 2, 2, 2, 2, 1, 2, 3, 2, 2, 2,
	1, 0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 1, 1, 0, 1, 0, 1, 2, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 2, 1,
	1, 0, 1, 2, 0, 0, 1, 1, 2, 0, 3, 0, 5, 0, 2, -2, 3, 2, 4, 0, 0, 9, -4, 2, 3, 2, 3, 2, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 3, 4,
	1, 0, 1, 0, 2, 0, 2, 0, 2, 0, 0, 2, 2, 4, -4, 5, -1, 2, 3, -1, 3, 0, 2, 2, 2, 5, 0, 1, 3, 2, 3, 2, 3, 3, 2, 3, 3, 3, 3, 3
);
const RS_SIZES_ACC = Int8Array.of(
	10, 6, 10, -8, 6, -8, 2, 4, 0, 4, 4, -8, 0, 2, 0, 4, 0, -2, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	7, 3, 5, 5, 6, -8, 2, 4, 6, -12, 2, 4, 2, 4, -8, 2, 4, 2, -2, 0, 0, 0, 2, 0, -4, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	17, 11, -6, -6, 6, 6, -2, 0, -2, 4, -4, 4, -6, 2, 0, 6, -2, 0, -2, 2, 2, -6, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	13, 9, -4, 8, -8, 6, -6, 4, -2, 4, 4, -2, -2, -4, 10, -6, 4, 0, -2, 4, -2, 2, 0, 0, 0, -2, 2//, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
);

/**
 *
 * @param {number} version
 * @return {number}
 */
const countDataModules = (version) => {
	let mods = (16 * version + 128) * version + 64;
	if (version >= 2) {
		const numAlign = Math.trunc(version / 7) + 2;
		mods -= (25 * numAlign - 10) * numAlign - 55;
		if (version >= 7) mods -= 36;
	}
	return mods;
};

for (let level = 0; level < 4; level++) {
	let blocks = 0, ecLength = 0;
	for (let version = 0; version < 40;) {
		const tab = version + level * 40;

		blocks += RS_BLOCKS_ACC[tab];
		ecLength += RS_SIZES_ACC[tab] | 0;

		const dataModules = countDataModules(++version) >> 3;
		const shortBlocks = blocks - dataModules % blocks;
		const idx = tab << 2;

		RS_PATTERNS[idx] = shortBlocks;
		RS_PATTERNS[idx+1] = Math.trunc(dataModules / blocks) - ecLength;
		RS_PATTERNS[idx+2] = ecLength;
		RS_PATTERNS[idx+3] = blocks - shortBlocks;
	}
}

}

const ALIGNMENT_PATTERNS = Uint8Array.of(
	11, 15, 19, 23, 27, 31,
	16, 18, 20, 22, 24, 26, 28, 20, 22, 24, 24, 26, 28, 28, 22, 24, 24,
	26, 26, 28, 28, 24, 24, 26, 26, 26, 28, 28, 24, 26, 26, 26, 28, 28
);

// BCH generator polynomials & mask used for format / version information.

/**
 * Count trailing zeroes.
 *
 * You should know that Math.clz32 exists since Chrome 38 (2014)
 * @param {number} data
 * @return {number}
 */
const ctz32 = data => 32 - Math.clz32(data);

const G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0); // 0x537
const G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0); // 0x1F25
const G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1); // 0x5412
const G15Len = ctz32(G15);
const G18Len = ctz32(G18);

const getBCHTypeInfo = data => {
	let d = data << 10;
	let tmp;
	while ((tmp = ctz32(d) - G15Len) >= 0) d ^= (G15 << tmp);
	return ((data << 10) | d) ^ G15_MASK;
};
const getBCHVersion = data => {
	let d = data << 12;
	let tmp;
	while ((tmp = ctz32(d) - G18Len) >= 0) d ^= (G18 << tmp);
	return (data << 12) | d;
};

// Eight data-mask conditions. `y` is row, `x` is column.
const MASK_FUNCS = [
	(y, x) => ((y + x) & 1) === 0,
	(y, x) => (y & 1) === 0,
	(y, x) => x % 3 === 0,
	(y, x) => (y + x) % 3 === 0,
	(y, x) => ((Math.floor(y / 2) + Math.floor(x / 3)) & 1) === 0,
	(y, x) => ((y * x) % 2) + ((y * x) % 3) === 0,
	(y, x) => ((((y * x) % 2) + ((y * x) % 3)) & 1) === 0,
	(y, x) => ((((y * x) % 3) + (y + x) % 2) & 1) === 0
];

const NUM = [1, 10, 12, 14];
const ALNUM = [2, 9, 11, 13];
const BYTE = [4, 8, 16, 16];
const getLengthBits = (mode, version) => mode[Math.floor((version + 7) / 17) + 1];

const ALNUM_IDX = /*#__PURE__*/ new Map(Array.prototype.map.call("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:", (k, v) => [k.charCodeAt(0), v]));

/**
 * @typedef {Object} Segment
 * @property {number[]} t type
 * @property {Uint8Array} d data
 * @property {number} l length
 * @property {number} p pad
 */

/**
 * @param {string} text
 * @return {Segment}
 */
const makeByteSegment = text => {
	const buf = UTF8_TEXT_ENCODER.encode(text);
	return {
		t: BYTE,
		d: buf,
		l: buf.length,
		p: 0
	};
};

/**
 * @param {number[]} type
 * @param {string} text
 * @return {Segment}
 */
const makeSegment = (type, text) => {
	const length = text.length;
	const out = new Uint8Array(length);

	let bytePos = 0;
	let bitPos  = 7;

	const put = (num, len) => {
		for (let i = len - 1; i >= 0; i--) {
			out[bytePos] |= ((num >>> i) & 1) << bitPos;
			if (--bitPos < 0) { bytePos++; bitPos = 7; }
		}
	};

	if (type === ALNUM) {
		let i = 0;
		for (; i + 2 <= length; i += 2)
			put(ALNUM_IDX.get(text.charCodeAt(i)) * 45 + ALNUM_IDX.get(text.charCodeAt(i + 1)), 11);
		if (i < length)
			put(ALNUM_IDX.get(text.charCodeAt(i)), 6);
	} else if (type === NUM) {
		let i = 0;
		for (; i + 3 <= length; i += 3)
			put(parseInt(text.substring(i, i + 3), 10), 10);

		const n = length - i;
		if (n) put(parseInt(text.substring(i, i + n), 10), n * 3 + 1);
	}

	return {
		t: type,
		d: out.subarray(0, bytePos + 1),
		l: length,
		p: (bitPos+1) & 7
	};
}

/**
 * @param {string} text
 * @param {{ dumb?: boolean }} options
 * @return {Uint8Array|Segment[]}
 */
const splitSegments = (text, options) => {
	if (text.startsWith("http") && !options.dumb) {
		try {
			const url = new URL(text);

			text = url.protocol.toUpperCase() + '//';

			if (url.username || url.password) {
				text += url.username;
				if (url.password) text += ':' + url.password;
				text += '@';
			}

			text += url.host.toUpperCase();
			text += url.pathname; // maybe decodeURIComponent + encodeURIComponent, but not now.
			text += url.search;
			text += url.hash;
		} catch {}
	}

	const segments = [];

	const regex = /([0-9]{4,})|[0-9A-Z\x20$%*+\-.\/:]{7,}/g;

	let lastIndex = 0;
	let match;

	while ((match = regex.exec(text)) !== null) {
		const index = match.index;
		if (index > lastIndex) segments.push(makeByteSegment(text.slice(lastIndex, index)));
		segments.push(makeSegment(match[1] ? NUM : ALNUM, match[0]));
		lastIndex = index + match[0].length;
	}

	if (lastIndex < text.length) {
		if (lastIndex === 0) return UTF8_TEXT_ENCODER.encode(text);
		segments.push(makeByteSegment(text.slice(lastIndex)));
	}

	return segments;
};

/**
 * 编码QR流
 * @param {Uint8Array | Segment[]} data
 * @param {number} version
 * @param {number} dataLength
 * @return {Uint8Array}
 */
const encodeData = (data, version, dataLength) => {
	const totalBits = dataLength * 8;
	const out = new Uint8Array(dataLength);

	let bytePos = 0;
	let bitPos  = 7;
	let written = 0;

	const put = (num, len) => {
		for (let i = len - 1; i >= 0; i--) {
			out[bytePos] |= ((num >>> i) & 1) << bitPos;
			if (--bitPos < 0) { bytePos++; bitPos = 7; }
		}
		written += len;
	};

	if (BYTE_ONLY || data instanceof Uint8Array) {
		put(0b0100, 4); // byte mode
		put(data.length, version < 10 ? 8 : 16);
		for (let i = 0; i < data.length; i++) put(data[i], 8);
	} else {
		for (const segment of data) {
			put(segment.t[0], 4);
			put(segment.l, getLengthBits(segment.t, version));
			const bb = segment.d;
			for (let i = 0; i < bb.length - 1; i++) put(bb[i], 8);
			const pad = segment.p;
			put(bb[bb.length - 1] >> pad, 8 - pad);
		}
	}

	if (written > totalBits) throw new RangeError(`data too long. (${written}>${totalBits})`);

	// terminator
	if (written + 4 <= totalBits) put(0, 4);
	if (bitPos !== 7) { bytePos++; bitPos = 7; }

	// padding
	for (let toggle = 0; bytePos < dataLength; toggle ^= 1) {
		out[bytePos++] = toggle ? 0x11 : 0xEC;
	}

	return out;
};

/**
 * 生成交错校验码
 * @param {Uint8Array} codewords
 * @param {number} version
 * @param {number} level
 * @return {Uint8Array}
 */
const createEC = (codewords, version, level) => {
	const tab = ((version - 1) + level * 40) << 2;
	const r0 = RS_PATTERNS[tab], dataLength = RS_PATTERNS[tab+1], ecLength = RS_PATTERNS[tab+2], r1 = RS_PATTERNS[tab+3];
	const rows = r0+r1;

	let pIn = 0;
	const blocks = Array(rows);
	for (let r = 0; r < r0; r++) {
		blocks[r] = codewords.subarray(pIn, pIn += dataLength);
	}
	for (let r = 0; r < r1; r++) {
		blocks[r+r0] = codewords.subarray(pIn, pIn += (dataLength + 1));
	}

	let pOut = 0;
	const outLen = r0 * dataLength + r1 * (dataLength + 1) + rows * ecLength;
	const out = new Uint8Array(outLen);

	for (let i = 0; i < dataLength; i++)
		for (let r = 0; r < rows; r++)
			out[pOut++] = blocks[r][i];
	for (let r = 0; r < r1; r++)
		out[pOut++] = blocks[r0 + r][dataLength];

	const ec = new Uint8Array(ecLength);
	const logGen = gfGenPolyLog(ecLength);

	for (let r = 0; r < rows; r++) {
		batchLFSR(ec, logGen, ecLength, blocks[r]);
		for (let i = 0; i < ecLength; i++)
			out[pOut + i * rows + r] = ec[i];
		ec.fill(0);
	}

	return out;
};

/**
 *
 * @param {number} version
 * @return {Int8Array}
 */
const buildMatrix = version => {
	const size = version * 4 + 17;
	const mat = new Int8Array(size * size).fill(-1); // -1 = empty, 0 = light, 1 = dark
	const set = (r, c, v) => { mat[r * size + c] = v; };
	const get = (r, c) => mat[r * size + c];

	// --- finder patterns (+ separators) ---
	const probe = (row, col) => {
		for (let r = -1; r <= 7; r++) {
			if (row + r < 0 || size <= row + r) continue;
			for (let c = -1; c <= 7; c++) {
				if (col + c < 0 || size <= col + c) continue;
				const dark =
					(0 <= r && r <= 6 && (c === 0 || c === 6)) ||
					(0 <= c && c <= 6 && (r === 0 || r === 6)) ||
					(2 <= r && r <= 4 && 2 <= c && c <= 4);
				set(row + r, col + c, +dark);
			}
		}
	};
	probe(0, 0);
	probe(0, size - 7);
	probe(size - 7, 0);

	// --- alignment patterns ---
	const pos = version > 1 && ALIGNMENT_PATTERNS[version - 1];
	if (pos) {
		const addAlignment = (r, c) => {
			if (get(r, c) !== -1) return; // avoid overlap with finder patterns
			for (let dr = -2; dr <= 2; dr++) {
				for (let dc = -2; dc <= 2; dc++) {
					const dark = dr === -2 || dr === 2 || dc === -2 || dc === 2 || (dr === 0 && dc === 0);
					set(r + dr, c + dc, +dark);
				}
			}
		};

		let y = size - 7;
		for (;;) {
			let x = size - 7;

			while (x > pos - 3) {
				addAlignment(x, y);

				if (x < pos) break;
				x -= pos;
			}

			if (y <= pos + 9) break;
			y -= pos;

			addAlignment(6, y);
			addAlignment(y, 6);
		}
	}

	// --- timing patterns ---
	for (let i = 8; i < size - 8; i++) {
		if (get(i, 6) === -1) set(i, 6, (i & 1) ^ 1);
		if (get(6, i) === -1) set(6, i, (i & 1) ^ 1);
	}

	return mat;
};

/**
 * @param {Int8Array} mat
 * @param {number} version
 * @param {number} level
 * @param {number} maskPattern
 * @param {0 | -1} apply
 */
const buildBCH = (mat, version, level, maskPattern, apply) => {
	const size = version * 4 + 17;
	const set = (r, c, v) => { mat[r * size + c] = v; };

	// --- format information (reserved/actual) ---
	const fmt = apply & getBCHTypeInfo((level << 3) | maskPattern);
	for (let i = 0; i < 15; i++) {
		const mod = ((fmt >> i) & 1);
		if (i < 6) set(i, 8, mod);
		else if (i < 8) set(i + 1, 8, mod);
		else set(size - 15 + i, 8, mod);
	}
	for (let i = 0; i < 15; i++) {
		const mod = ((fmt >> i) & 1);
		if (i < 8) set(8, size - i - 1, mod);
		else if (i < 9) set(8, 15 - i, mod);
		else set(8, 15 - i - 1, mod);
	}
	set(size - 8, 8, 1);

	// --- version information ---
	if (version >= 7) {
		const v = apply & getBCHVersion(version);
		for (let i = 0; i < 18; i++) {
			const mod = ((v >> i) & 1);
			const a = Math.floor(i / 3);
			const b = i % 3 + size - 11;
			set(a, b, mod);
			set(b, a, mod);
		}
	}
};

/**
 * @param {Int8Array} mat
 * @param {number} version
 * @param {string} level
 * @param {Uint8Array} codewords
 * @param {number} maskPattern
 * @return {Int8Array}
 */
const buildMask = (mat, version, level, codewords, maskPattern) => {
	const size = version * 4 + 17;
	// --- data modules (zig-zag, with chosen mask) ---
	const maskFn = MASK_FUNCS[maskPattern];
	let inc = -1, row = size - 1, bitIndex = 7, byteIndex = 0;
	for (let col = size - 1; col > 0; col -= 2) {
		if (col === 6) col--; // skip vertical timing column
		while (true) {
			for (let c = 0; c < 2; c++) {
				const cc = col - c;
				if (mat[row * size + cc] === -1) {
					mat[row * size + cc] = 1 & (codewords[byteIndex] >>> bitIndex) ^ maskFn(row, cc);
					bitIndex--;
					if (bitIndex === -1) { byteIndex++; bitIndex = 7; }
				}
			}
			row += inc;
			if (row < 0 || size <= row) { row -= inc; inc = -inc; break; }
		}
	}
};

/**
 * Mask evaluation
 * @param {Int8Array} mat
 * @param {number} size
 * @return {number}
 */
const lostPoint = (mat, size) => {
	const end = size * size;
	const runs = new Int16Array(size);
	let point = 0;
	let darkCount = 0;

	// N1 + N3 in one pass
	for (let pass = 0; pass < 2; pass++) {
		const stride = pass === 0 ? 1 : size; // pass0 为行，pass1 为列
		for (let o = 0; o < size; o++) {
			const base = pass === 0 ? o * size : o;
			let color = mat[base];
			const startColor = color;
			let nc = 0;
			runs[0] = 1;

			for (let k = 1; k < size; k++) {
				const c = mat[base + k * stride];
				if (c === color) {
					runs[nc]++;
				} else {
					if (runs[nc] >= 5) point += 3 + (runs[nc] - 5);
					color = c;
					runs[++nc] = 1;
				}
			}
			if (runs[nc] >= 5) point += 3 + (runs[nc] - 5);

			// N3 1011101 pattern
			const darkParity = 1 - startColor;
			for (let i = 2; i + 2 <= nc; i++) {
				if ((i & 1) !== darkParity) continue;
				if (runs[i] === 3 && runs[i - 2] === 1 && runs[i - 1] === 1 &&
					runs[i + 1] === 1 && runs[i + 2] === 1) {
					const leftPad = (i - 3 < 0) || runs[i - 3] >= 4;
					const rightPad = (i + 3 > nc) || runs[i + 3] >= 4;
					if (leftPad || rightPad) point += 40;
				}
			}
		}
	}

	// N2: 2x2 blocks of same colour
	for (let r = 0; r < size - 1; r++) {
		for (let c = 0; c < size - 1; c++) {
			const v = mat[r * size + c];
			if (v === mat[r * size + c + 1] && v === mat[(r + 1) * size + c] && v === mat[(r + 1) * size + c + 1])
				point += 3;
		}
	}

	// N4: dark-module proportion
	for (let i = 0; i < end; i++) if (mat[i] === 1) darkCount++;
	point += Math.abs(100 * darkCount / end - 50) / 5 * 10;

	return point;
};

/**
 *
 * @param {number} version
 * @param {number} level
 * @return {number}
 */
const getDataCapacity = (version, level) => {
	const tab = ((version - 1) + level * 40) << 2;
	return RS_PATTERNS[tab] * (RS_PATTERNS[tab+1]) + (RS_PATTERNS[tab+3]) * (RS_PATTERNS[tab+1]+1);
};

/**
 *
 * @param {number} version
 * @param {Uint8Array | Segment[]} data
 * @return {number}
 */
const getRawLength = (version, data) => {
	if (BYTE_ONLY || data instanceof Uint8Array) {
		const lengthBits = version < 10 ? 8 : 16;
		return 4 + lengthBits + 8 * data.length;
	}

	let bits = data.length << 2;
	for (const seg of data) {
		bits += getLengthBits(seg.t, version);
		bits += seg.d.length * 8 - seg.p;
	}
	return bits;
};

/**
 *
 * @param {Uint8Array | string | Segment[]} data
 * @param {{ level?: 'L' | 'M' | 'Q' | 'H', version?: number, minVersion?: number, maxVersion?: number, mask?: number, dumb?: boolean }} options
 * @return {{size: number, modules: Int8Array}}
 */
export const generateQRCode = (data, options = {}) => {
	if (typeof data === 'string') data = !BYTE_ONLY ? splitSegments(data, options) : UTF8_TEXT_ENCODER.encode(data);

	let level = LEVEL_BIT[options.level ?? 'L'];
	if (null == level) throw new RangeError("level must in "+Object.keys(LEVEL_BIT));

	let version = options.version;
	if (version == null) {
		const max = options.maxVersion ?? 40;
		let bits;
		for (version = options.minVersion ?? 1; version < max; version++) {
			bits = getRawLength(version, data);
			if (bits <= getDataCapacity(version, level) * 8) break;
		}

		// auto use higher level if unspecified and applicable.
		if (!options.dumb && null == options.level) {
			for (const c of [0,3,2]) { // M Q H
				if (bits > getDataCapacity(version, c)) break;
				level = c;
			}
		}
	} else if (!Number.isInteger(version) || version < 1 || version > 40) {
		throw new RangeError('version must be an 1..40');
	}

	const dataLength = getDataCapacity(version, level);
	const dataCodewords = encodeData(data, version, dataLength);
	const codewords = createEC(dataCodewords, version, level);
	const size = version * 4 + 17;

	const mat = buildMatrix(version);
	buildBCH(mat, version, level, 0, 0);

	// 选罚分最低的掩码
	let bestMask = options.mask, bestPoint = Infinity;
	if (null == bestMask) {
		const mastMat = new Int8Array(mat.length);
		for (let m = 0; m < 8; m++) {
			mastMat.set(mat);
			buildMask(mastMat, version, level, codewords, m);
			const p = lostPoint(mastMat, size);
			if (p < bestPoint) { bestPoint = p; bestMask = m; }
		}
	}

	buildBCH(mat, version, level, bestMask, -1);
	buildMask(mat, version, level, codewords, bestMask);
	return { modules: mat, size };
};

export default generateQRCode;

/**
 *
 * @param {string | Uint8Array} data
 * @param {{
 *     canvas?: HTMLCanvasElement,
 *     level?: 'L' | 'M' | 'Q' | 'H',
 *     version?: number,
 *     border?: number,
 *     width?: number,
 *     background?: string,
 *     color?: string,
 * }} options
 * @return {HTMLCanvasElement}
 */
export const renderQRCodeToCanvas = (data, options = {}) => {
	const canvas = options.canvas ?? document.createElement("canvas");
	canvas.style.imageRendering = 'pixelated';
	if (typeof data === 'string') canvas.title = data;

	const {modules, size} = generateQRCode(data, options);

	const border = options.border ?? 1;

	canvas.width = canvas.height = size + (border * 2);

	const lineWidth = options.width ?? size * 8;
	canvas.style.width = canvas.style.height = lineWidth + "px";

	const context = canvas.getContext("2d");

	context.fillStyle = options.background ?? "white";
	context.fillRect(0, 0, size + (border * 2), size + (border * 2));
	context.fillStyle = options.color ?? "black";

	for (let x = 0; x < size; x++) {
		for (let y = 0; y < size; y++) {
			if (modules[y * size + x])
				context.fillRect(x+border, y+border, 1, 1);
		}
	}

	return canvas;
};

/**
 * Render a QR code as ASCII art.
 *
 * @param {string | Uint8Array} data
 * @param {{
 *     level?: 'L' | 'M' | 'Q' | 'H',
 *     version?: number,
 *     mask?: number,
 *     border?: number,
 *     background?: 'white' | string,
 * }} options
 * @returns {string}
 */
export const renderQRCodeToASCII = (data, options = {}) => {
	const { modules, size } = generateQRCode(data, options);
	const border = options.border ?? 1;
	const total = size + border * 2;
	const invert = +(options.background !== 'white');
	const isDark = (x, y) => {
		const mx = x - border, my = y - border;
		return (mx >= 0 && mx < size && modules[my * size + mx]) ^ invert;
	};

	let out = '';
	for (let y = 0; y < total; y += 2) {
		for (let x = 0; x < total; x++) {
			const top = isDark(x, y);
			const bottom = y + 1 < total ? isDark(x, y + 1) : false;
			out += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
		}
		out += '\n';
	}
	return out;
};
/*
import {crc32} from "./zip-io.js";

const concatBytes = (a, b) => {
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
};

const pngChunk = (type, data) => {
	const t = UTF8_TEXT_ENCODER.encode(type);
	const out = new Uint8Array(12 + data.length);
	const v = new DataView(out.buffer);
	v.setUint32(0, data.length);
	out.set(t, 4);
	out.set(data, 8);
	v.setUint32(8 + data.length, crc32(concatBytes(t, data)));
	return out;
};

/**
 * Render a monochrome (1-bit grayscale) PNG of a QR code as a Blob.
 *
 * @param {string | Uint8Array} data
 * @param {{
 *     level?: 'L' | 'M' | 'Q' | 'H',
 *     version?: number,
 *     mask?: number,
 *     border?: number,
 *     scale?: number,
 * }} options
 * @returns {Promise<Blob>}
 * /
export const renderQRCodeToPngBlob = async (data, options = {}) => {
	const { modules, size } = generateQRCode(data, options);
	const border = options.border ?? 1;
	const scale = options.scale ?? 1; // repeat each module `scale` times in both axes
	const width = (size + border * 2) * scale;
	const height = width;

	// 1-bit grayscale scanlines, filter type 0 (None). dark→0(black), light→1(white)
	const stride = (width + 7) >> 3;
	const raw = new Uint8Array((stride + 1) * height);
	let p = 0;
	for (let y = 0; y < height; y++) {
		raw[p++] = 0;
		let byte = 0, bits = 0;
		const my = Math.floor(y / scale) - border;
		for (let x = 0; x < width; x++) {
			const mx = Math.floor(x / scale) - border;
			const dark = mx >= 0 && my >= 0 && mx < size && my < size && modules[my * size + mx] !== 0;
			byte = (byte << 1) | (dark ? 0 : 1);
			if (++bits === 8) { raw[p++] = byte; byte = 0; bits = 0; }
		}
		if (bits > 0) raw[p++] = byte << (8 - bits);
	}

	const cs = new CompressionStream('deflate');
	const compressed = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(cs)).arrayBuffer());

	const ihdr = new Uint8Array(13);
	const dv = new DataView(ihdr.buffer);
	dv.setUint32(0, width);
	dv.setUint32(4, height);
	ihdr[8] = 1;  // bit depth
	ihdr[9] = 0;  // color type: grayscale
	ihdr[10] = 0; // compression method
	ihdr[11] = 0; // filter method
	ihdr[12] = 0; // interlace

	const sig = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

	return new Blob(
		[sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', compressed), pngChunk('IEND', new Uint8Array(0))],
		{ type: 'image/png' }
	);
};
*/
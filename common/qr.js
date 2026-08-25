// qr.js — Fast QRCode pattern generator within 8KiB

'use strict';

// ---------------------------------------------------------------------------
// Reed-Solomon over GF(256), primitive polynomial 0x11d (x^8+x^4+x^3+x^2+1)
// ---------------------------------------------------------------------------
import {UTF8_TEXT_ENCODER} from "../shared.js";

const EXP = new Uint8Array(512 + 511);
const LOG = new Uint16Array(256);

for (let i = 0; i < 8; i++) EXP[i] = (1 << i);
for (let i = 8; i < 256; i++) EXP[i] = (EXP[i - 4] ^ EXP[i - 5] ^ EXP[i - 6] ^ EXP[i - 8]);
for (let i = 0; i < 255; i++) LOG[EXP[i]&255] = i;
for (let i = 255; i < 511; i++) EXP[i] = EXP[i - 255];
LOG[0] = 511;

// branchless multiply
const mul = (a, b) => EXP[LOG[a] + LOG[b]];

/**
 *
 * @param {Uint8Array} MEM
 * @param {number} p1
 * @param {number} p1Len
 * @param {number} p2
 * @param {number} p2Len
 * @param {number} pOut
 */
function polyMul(MEM, p1, p1Len, p2, p2Len, pOut) {
	MEM.fill(0, pOut, pOut + p1Len + p2Len - 1);
	for (let i = 0; i < p1Len; i++) {
		for (let j = 0; j < p2Len; j++) {
			MEM[pOut + i + j] ^= mul(MEM[p1 + i], MEM[p2 + j]);
		}
	}
}

function batchLFSR(gen, ecLength, data) {
	const ec = new Uint8Array(ecLength);

	for (let i = 0; i < data.length; i++) {
		const input = data[i];
		const feedback = ec[0] ^ input;

		// 如果嫌弃性能差可以把Java里面那个premult表拿过来
		// 另外不需要检查零, mul是完全无分支的
		const last = ecLength - 1;
		for (let j = 0; j < last; j++) {
			ec[j] = ec[j + 1] ^ mul(gen[j + 1], feedback);
		}
		ec[last] = mul(gen[ecLength], feedback);
	}

	return ec;
}

/**
 *
 * @param {number} size
 * @return {Uint8Array}
 */
function polyNewGenerator(size) {
	const MEM = new Uint8Array((size + 1) * 2 + 2);
	let pLambdaA = 2;
	let pLambdaB = 3 + size;
	let pLambda = pLambdaA;

	MEM[pLambda] = 1;
	let lambdaLen = 1;

	MEM[0] = 1;

	for (let i = 0; i < size; i++) {
		MEM[1] = EXP[i];

		let pDest = (pLambda === pLambdaA) ? pLambdaB : pLambdaA;
		polyMul(MEM, pLambda, lambdaLen, 0, 2, pDest);
		lambdaLen++;
		pLambda = pDest;
	}

	return MEM.slice(pLambda, pLambda + lambdaLen);
}

// numeric value embedded in format info (top 2 bits): L=1 M=0 Q=3 H=2
const EC_BITS = { M: 0, L: 1, H: 2, Q: 3 };
// For each (version-1)*4 + ecIndex the flat list:
//   [count, dataLength, ecLength, count2?]
const RS_PATTERNS = [
	[1,16,10],[1,19,7],[1,9,17],[1,13,13],
	[1,28,16],[1,34,10],[1,16,28],[1,22,22],
	[1,44,26],[1,55,15],[2,13,22],[2,17,18],
	[2,32,18],[1,80,20],[4,9,16],[2,24,26],
	[2,43,24],[1,108,26],[2,11,22,2],[2,15,18,2],
	[4,27,16],[2,68,18],[4,15,28],[4,19,24],
	[4,31,18],[2,78,20],[4,13,26,1],[2,14,18,4],
	[2,38,22,2],[2,97,24],[4,14,26,2],[4,18,22,2],
	[3,36,22,2],[2,116,30],[4,12,24,4],[4,16,20,4],
	[4,43,26,1],[2,68,18,2],[6,15,28,2],[6,19,24,2],
	[1,50,30,4],[4,81,20],[3,12,24,8],[4,22,28,4],
	[6,36,22,2],[2,92,24,2],[7,14,28,4],[4,20,26,6],
	[8,37,22,1],[4,107,26],[12,11,22,4],[8,20,24,4],
	[4,40,24,5],[3,115,30,1],[11,12,24,5],[11,16,20,5],
	[5,41,24,5],[5,87,22,1],[11,12,24,7],[5,24,30,7],
	[7,45,28,3],[5,98,24,1],[3,15,30,13],[15,19,24,2],
	[10,46,28,1],[1,107,28,5],[2,14,28,17],[1,22,28,15],
	[9,43,26,4],[5,120,30,1],[2,14,28,19],[17,22,28,1],
	[3,44,26,11],[3,113,28,4],[9,13,26,16],[17,21,26,4],
	[3,41,26,13],[3,107,28,5],[15,15,28,10],[15,24,30,5],
	[17,42,26],[4,116,28,4],[19,16,30,6],[17,22,28,6],
	[17,46,28],[2,111,28,7],[34,13,24],[7,24,30,16],
	[4,47,28,14],[4,121,30,5],[16,15,30,14],[11,24,30,14],
	[6,45,28,14],[6,117,30,4],[30,16,30,2],[11,24,30,16],
	[8,47,28,13],[8,106,26,4],[22,15,30,13],[7,24,30,22],
	[19,46,28,4],[10,114,28,2],[33,16,30,4],[28,22,28,6],
	[22,45,28,3],[8,122,30,4],[12,15,30,28],[8,23,30,26],
	[3,45,28,23],[3,117,30,10],[11,15,30,31],[4,24,30,31],
	[21,45,28,7],[7,116,30,7],[19,15,30,26],[1,23,30,37],
	[19,47,28,10],[5,115,30,10],[23,15,30,25],[15,24,30,25],
	[2,46,28,29],[13,115,30,3],[23,15,30,28],[42,24,30,1],
	[10,46,28,23],[17,115,30],[19,15,30,35],[10,24,30,35],
	[14,46,28,21],[17,115,30,1],[11,15,30,46],[29,24,30,19],
	[14,46,28,23],[13,115,30,6],[59,16,30,1],[44,24,30,7],
	[12,47,28,26],[12,121,30,7],[22,15,30,41],[39,24,30,14],
	[6,47,28,34],[6,121,30,14],[2,15,30,64],[46,24,30,10],
	[29,46,28,14],[17,122,30,4],[24,15,30,46],[49,24,30,10],
	[13,46,28,32],[4,122,30,18],[42,15,30,32],[48,24,30,14],
	[40,47,28,7],[20,117,30,4],[10,15,30,67],[43,24,30,22],
	[18,47,28,31],[19,118,30,6],[20,15,30,61],[34,24,30,34]
];

const ALIGNMENT_PATTERNS = Uint8Array.of(
	11, 15, 19, 23, 27, 31,
	16, 18, 20, 22, 24, 26, 28, 20, 22, 24, 24, 26, 28, 28, 22, 24, 24,
	26, 26, 28, 28, 24, 24, 26, 26, 26, 28, 28, 24, 26, 26, 26, 28, 28
);

// BCH generator polynomials & mask used for format / version information.
const G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0); // 0x537
const G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0); // 0x1F25
const G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1); // 0x5412

function bchDigit(data) { let d = 0; while (data !== 0) { d++; data >>>= 1; } return d; }
function getBCHTypeInfo(data) {
	let d = data << 10;
	while (bchDigit(d) - bchDigit(G15) >= 0) d ^= (G15 << (bchDigit(d) - bchDigit(G15)));
	return ((data << 10) | d) ^ G15_MASK;
}
function getBCHVersion(data) {
	let d = data << 12;
	while (bchDigit(d) - bchDigit(G18) >= 0) d ^= (G18 << (bchDigit(d) - bchDigit(G18)));
	return (data << 12) | d;
}

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

/**
 * 编码QR流
 * @param {Uint8Array} data
 * @param {number} version
 * @param {number} dataLength
 * @return {Uint8Array}
 */
function encodeData(data, version, dataLength) {
	const totalBits = dataLength * 8;
	const out = new Uint8Array(dataLength);

	let bytePos = 0;
	let bitPos  = 7;
	let written = 0;

	// 把 num 的低 len 位按 MSB-first 写入 out
	const put = (num, len) => {
		for (let i = len - 1; i >= 0; i--) {
			out[bytePos] |= ((num >>> i) & 1) << bitPos;
			if (--bitPos < 0) { bytePos++; bitPos = 7; }
		}
		written += len;
	};

	put(0b0100, 4); // byte mode
	put(data.length, version < 10 ? 8 : 16);
	for (let i = 0; i < data.length; i++) put(data[i], 8);

	if (written > totalBits) throw new Error(`code length overflow. (${written}>${totalBits})`);

	// terminator
	if (written + 4 <= totalBits) put(0, 4);
	if (bitPos !== 7) { bytePos++; bitPos = 7; }

	// padding
	for (let toggle = 0; bytePos < dataLength; toggle ^= 1) {
		out[bytePos++] = toggle ? 0x11 : 0xEC;
	}

	return out;
}

/**
 * 生成交错校验码
 * @param {Uint8Array} codewords
 * @param {number} version
 * @param {'L' | 'M' | 'Q' | 'H'} level
 * @return {Uint8Array}
 */
function createEC(codewords, version, level) {
	const tab = RS_PATTERNS[(version - 1) * 4 + EC_BITS[level]];
	const r0 = tab[0], dataLength = tab[1], ecLength = tab[2], r1 = tab[3] ?? 0;
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

	const genPoly = polyNewGenerator(ecLength);
	for (let r = 0; r < rows; r++) {
		const ec = batchLFSR(genPoly, ecLength, blocks[r]);
		for (let i = 0; i < ecLength; i++)
			out[pOut + i * rows + r] = ec[i];
	}

	return out;
}

/**
 *
 * @param {number} version
 * @param {string} level
 * @param {Uint8Array} codewords
 * @param {number} maskPattern
 * @param {boolean} test
 * @return {Int8Array}
 */
function buildMatrix(version, level, codewords, maskPattern, test) {
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
				set(row + r, col + c, dark ? 1 : 0);
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
					set(r + dr, c + dc, dark ? 1 : 0);
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
		if (get(i, 6) === -1) set(i, 6, i % 2 === 0 ? 1 : 0);
		if (get(6, i) === -1) set(6, i, i % 2 === 0 ? 1 : 0);
	}

	// --- format information (reserved/actual) ---
	const fmt = getBCHTypeInfo((EC_BITS[level] << 3) | maskPattern);
	for (let i = 0; i < 15; i++) {
		const mod = (!test && ((fmt >> i) & 1) === 1) ? 1 : 0;
		if (i < 6) set(i, 8, mod);
		else if (i < 8) set(i + 1, 8, mod);
		else set(size - 15 + i, 8, mod);
	}
	for (let i = 0; i < 15; i++) {
		const mod = (!test && ((fmt >> i) & 1) === 1) ? 1 : 0;
		if (i < 8) set(8, size - i - 1, mod);
		else if (i < 9) set(8, 15 - i, mod);
		else set(8, 15 - i - 1, mod);
	}
	set(size - 8, 8, test ? 0 : 1); // fixed dark module

	// --- version information (versions 7..40) ---
	if (version >= 7) {
		const v = getBCHVersion(version);
		for (let i = 0; i < 18; i++) {
			const mod = (!test && ((v >> i) & 1) === 1) ? 1 : 0;
			set(Math.floor(i / 3), i % 3 + size - 11, mod);
			set(i % 3 + size - 11, Math.floor(i / 3), mod);
		}
	}

	// --- data modules (zig-zag, with chosen mask) ---
	const maskFn = MASK_FUNCS[maskPattern];
	let inc = -1, row = size - 1, bitIndex = 7, byteIndex = 0;
	for (let col = size - 1; col > 0; col -= 2) {
		if (col === 6) col--; // skip vertical timing column
		while (true) {
			for (let c = 0; c < 2; c++) {
				const cc = col - c;
				if (get(row, cc) === -1) {
					let dark = 0;
					if (byteIndex < codewords.length) dark = (codewords[byteIndex] >>> bitIndex) & 1;
					if (maskFn(row, cc)) dark ^= 1;
					set(row, cc, dark);
					bitIndex--;
					if (bitIndex === -1) { byteIndex++; bitIndex = 7; }
				}
			}
			row += inc;
			if (row < 0 || size <= row) { row -= inc; inc = -inc; break; }
		}
	}
	return mat;
}

/**
 * Mask evaluation
 * @param {Int8Array} mat
 * @param {number} size
 * @return {number}
 */
function lostPoint(mat, size) {
	const isDark = (r, c) => mat[r * size + c] === 1;
	let point = 0;

	// N1: runs of same colour in 3x3 neighbourhood
	for (let r = 0; r < size; r++) {
		for (let c = 0; c < size; c++) {
			let same = 0;
			const d = isDark(r, c);
			for (let dr = -1; dr <= 1; dr++) {
				if (r + dr < 0 || size <= r + dr) continue;
				for (let dc = -1; dc <= 1; dc++) {
					if (c + dc < 0 || size <= c + dc) continue;
					if (dr === 0 && dc === 0) continue;
					if (d === isDark(r + dr, c + dc)) same++;
				}
			}
			if (same > 5) point += 3 + same - 5;
		}
	}
	// N2: 2x2 blocks of same colour
	for (let r = 0; r < size - 1; r++) {
		for (let c = 0; c < size - 1; c++) {
			const cnt = isDark(r, c) + isDark(r + 1, c) + isDark(r, c + 1) + isDark(r + 1, c + 1);
			if (cnt === 0 || cnt === 4) point += 3;
		}
	}
	// N3: 1011101 pattern (with surrounding light)
	for (let r = 0; r < size; r++) {
		for (let c = 0; c < size - 6; c++) {
			if (isDark(r, c) && !isDark(r, c + 1) && isDark(r, c + 2) && isDark(r, c + 3) &&
				isDark(r, c + 4) && !isDark(r, c + 5) && isDark(r, c + 6)) point += 40;
		}
	}
	for (let c = 0; c < size; c++) {
		for (let r = 0; r < size - 6; r++) {
			if (isDark(r, c) && !isDark(r + 1, c) && isDark(r + 2, c) && isDark(r + 3, c) &&
				isDark(r + 4, c) && !isDark(r + 5, c) && isDark(r + 6, c)) point += 40;
		}
	}
	// N4: dark-module proportion
	let darkCount = 0;
	for (let i = 0; i < size * size; i++) if (mat[i] === 1) darkCount++;
	const ratio = Math.abs(100 * darkCount / size / size - 50) / 5;
	point += ratio * 10;
	return point;
}

// (version, ec) 下数据码字总数(字节)
function getDataLength(version, ec) {
	const row = RS_PATTERNS[(version - 1) * 4 + EC_BITS[ec]];
	return row[0] * (row[1]) + (row[3] || 0) * (row[1]+1);
}

function byteModeBits(version, byteLen) {
	const lengthBits = version < 10 ? 8 : 16;
	return 4 + lengthBits + 8 * byteLen;
}

// 自动选择能装下 byteLen 字节的最小 version(给定 ec);装不下则抛错
function autoVersion(byteLen, ec) {
	for (let v = 1; v <= 40; v++) {
		if (byteModeBits(v, byteLen) <= getDataLength(v, ec) * 8) return v;
	}
	throw new Error('data too large for QR version 1..40 at ec=' + ec);
}

/**
 *
 * @param {Uint8Array | string} data
 * @param {{ level?: 'L' | 'M' | 'Q' | 'H', version?: number }} options
 * @return {{size: number, modules: Uint8Array}}
 */
export function generateQRCode(data, options = {}) {
	if (typeof data === 'string') data = UTF8_TEXT_ENCODER.encode(data);

	const level = options.level ?? 'L';
	if (null == EC_BITS[level]) throw new RangeError("level must be "+Object.keys(EC_BITS));

	const version = options.version ?? autoVersion(data.length, level);
	if (!Number.isInteger(version) || version < 1 || version > 40)
		throw new RangeError('version must be an 1..40');

	const dataLength = getDataLength(version, level);
	const dataCodewords = encodeData(data, version, dataLength);
	const codewords = createEC(dataCodewords, version, level);
	const size = version * 4 + 17;

	// 选罚分最低的掩码
	let bestMask = 0, bestPoint = Infinity;
	for (let m = 0; m < 8; m++) {
		const mat = buildMatrix(version, level, codewords, m, true);
		const p = lostPoint(mat, size);
		if (p < bestPoint) { bestPoint = p; bestMask = m; }
	}

	const mat = buildMatrix(version, level, codewords, bestMask, false);
	const out = new Uint8Array(size * size);
	for (let i = 0; i < size * size; i++) out[i] = mat[i] === 1 ? 1 : 0;
	return { modules: out, size };
}

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
export function renderQRCodeToCanvas(data, options = {}) {
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
}
/**
 * 独立的 QR 解码器，只用于测试。
 *
 * 它不 import `qr.js` 里的任何内部实现：
 * - 纠错块结构（每块数据/纠错码字数、块数）取自 ISO/IEC 18004 的表 9，
 *   用与 segno（独立实现）一致的 delta 编码存成字符串；
 * - 格式信息 / 版本信息的 BCH、GF(256) 运算、掩码、之字形取位、RS 校验
 *   都在这里重新实现一遍，用来交叉验证 `generateQRCode` 的输出。
 *
 * Level 索引沿用二维码里格式信息的 2 bit 值：0=M, 1=L, 2=H, 3=Q。
 */

export const LEVEL_NAME = ['M', 'L', 'H', 'Q'];

// ---------------------------------------------------------------------------
// 纠错块结构（delta 编码）
// 每个字符是 (当前值 - 上一个值)，基准 103。
// ---------------------------------------------------------------------------
const RS_BLOCKS_ACC = 'hgghgigghggjhghghihihghihiihihiiiihijiiihgggghgggiggggiggghhghghigghhhhhhhghhhihhghigghhigjglgiejikggpcijijijjjjjjjjkkjkhghgigigiggiikclfijfjgiiilghjijijjijjjjj';
const RS_SIZES_ACC = 'qmq_m_ikgkk_gigkgegggiggggggggggggggggggnjllm_ikm[ikik_ikiegggigciigggggggggggggxraammegekckaigmegeiiamgggggggggggggggggtpco_makekkeecqakgekeigggeiggggggggggggg';
const CHR_BASE = 103;

/** 一个版本/等级里数据模块的总位数除以 8（含纠错码字）。 */
export const totalCodewords = version => {
	let modules = (16 * version + 128) * version + 64;
	if (version >= 2) {
		const numAlign = Math.trunc(version / 7) + 2;
		modules -= (25 * numAlign - 10) * numAlign - 55;
		if (version >= 7) modules -= 36;
	}
	return modules >> 3;
};

const RS = new Uint8Array(4 * 4 * 40);
for (let level = 0; level < 4; level++) {
	let blocks = 0, ecLength = 0;
	for (let version = 0; version < 40;) {
		const tab = version + level * 40;
		blocks += RS_BLOCKS_ACC.charCodeAt(tab) - CHR_BASE;
		ecLength += RS_SIZES_ACC.charCodeAt(tab) - CHR_BASE;
		const dataModules = totalCodewords(++version);
		const shortBlocks = blocks - dataModules % blocks;
		const idx = tab << 2;
		RS[idx] = shortBlocks;
		RS[idx + 1] = Math.trunc(dataModules / blocks) - ecLength;
		RS[idx + 2] = ecLength;
		RS[idx + 3] = blocks - shortBlocks;
	}
}

/**
 * 返回 [短块数, 短块数据码字数, 每块纠错码字数, 长块数]
 */
export const blockInfo = (version, level) => {
	const tab = ((version - 1) + level * 40) << 2;
	return [RS[tab], RS[tab + 1], RS[tab + 2], RS[tab + 3]];
};

// ---------------------------------------------------------------------------
// GF(256)，本原多项式 0x11d
// ---------------------------------------------------------------------------
const EXP = new Uint8Array(512);
const LOG = new Uint16Array(256);
{
	let x = 1;
	for (let i = 0; i < 255; i++) {
		EXP[i] = x;
		LOG[x] = i;
		x <<= 1;
		if (x & 0x100) x ^= 0x11d;
	}
	for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** 用独立的综合式计算校验：S_i = 0 (i < ecLength) 才说明 RS 码正确。 */
export const reedSolomonOk = (block, ecLength) => {
	for (let i = 0; i < ecLength; i++) {
		let s = 0;
		for (const c of block) s = gfMul(s, EXP[i]) ^ c;
		if (s !== 0) return false;
	}
	return true;
};

// ---------------------------------------------------------------------------
// BCH 格式信息 / 版本信息
// ---------------------------------------------------------------------------
const G15 = 0x537, G18 = 0x1f25, G15_MASK = 0x5412;
const bitLength = n => 32 - Math.clz32(n);
const bchRemainder = (data, generator, shift) => {
	let d = data << shift;
	while (bitLength(d) - bitLength(generator) >= 0) d ^= generator << (bitLength(d) - bitLength(generator));
	return d;
};
const bchTypeInfo = data => ((data << 10) | bchRemainder(data, G15, 10)) ^ G15_MASK;
const bchVersion = version => (version << 12) | bchRemainder(version, G18, 12);

// ---------------------------------------------------------------------------
// 几何
// ---------------------------------------------------------------------------
const ALIGNMENT_STEP = 'aeimqufhjlnprjlnnprrlnnpprrnnppprrnppprr';

const alignmentPositions = version => {
	if (version === 1) return [];
	const size = version * 4 + 17;
	const step = ALIGNMENT_STEP.charCodeAt(version - 1) - 86;
	const out = [];
	for (let p = size - 7; p > step - 3; p -= step) out.unshift(p);
	out.unshift(6);
	return out;
};

/** 1 表示功能图形（不承载数据）。 */
const buildFunctionMask = (size, version) => {
	const fn = new Uint8Array(size * size);
	const mark = (r, c) => { if (r >= 0 && c >= 0 && r < size && c < size) fn[r * size + c] = 1; };

	for (const [br, bc] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
		for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) mark(br + r, bc + c);
	}
	for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6); }

	const pos = alignmentPositions(version);
	const n = pos.length;
	for (let i = 0; i < n; i++) {
		for (let j = 0; j < n; j++) {
			if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
			for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(pos[i] + dr, pos[j] + dc);
		}
	}

	for (let i = 0; i < 9; i++) { mark(8, i); mark(i, 8); }
	for (let i = 0; i < 8; i++) { mark(8, size - 1 - i); mark(size - 1 - i, 8); }

	if (version >= 7) {
		for (let i = 0; i < 18; i++) {
			const a = Math.floor(i / 3), b = i % 3 + size - 11;
			mark(a, b); mark(b, a);
		}
	}
	return fn;
};

const readFormat = (mat, size) => {
	let raw = 0;
	for (let i = 0; i < 15; i++) {
		const bit = i < 6 ? mat[i * size + 8]
			: i < 8 ? mat[(i + 1) * size + 8]
			: mat[(size - 15 + i) * size + 8];
		raw |= bit << i;
	}
	// 第二份拷贝应当完全相同
	for (let i = 0; i < 15; i++) {
		const bit = i < 8 ? mat[8 * size + (size - i - 1)]
			: i < 9 ? mat[8 * size + (15 - i)]
			: mat[8 * size + (15 - i - 1)];
		if (bit !== ((raw >> i) & 1)) return {error: `格式信息两份拷贝在第 ${i} 位不一致`};
	}
	for (let level = 0; level < 4; level++) {
		for (let mask = 0; mask < 8; mask++) {
			if (bchTypeInfo((level << 3) | mask) === raw) return {level, mask};
		}
	}
	return {error: `格式信息 BCH 校验失败: ${raw.toString(2)}`};
};

export const checkVersionInfo = (mat, size, version) => {
	if (version < 7) return true;
	let raw = 0;
	for (let i = 0; i < 18; i++) {
		const a = Math.floor(i / 3), b = i % 3 + size - 11;
		if (mat[a * size + b] !== mat[b * size + a]) return false;
		raw |= mat[a * size + b] << i;
	}
	return raw === bchVersion(version);
};

// ---------------------------------------------------------------------------
// 掩码 / 取位 / 反交织
// ---------------------------------------------------------------------------
const MASK_FUNCS = [
	(y, x) => ((y + x) & 1) === 0,
	(y, x) => (y & 1) === 0,
	(y, x) => x % 3 === 0,
	(y, x) => (y + x) % 3 === 0,
	(y, x) => ((Math.floor(y / 2) + Math.floor(x / 3)) & 1) === 0,
	(y, x) => ((y * x) % 2) + ((y * x) % 3) === 0,
	(y, x) => ((((y * x) % 2) + ((y * x) % 3)) & 1) === 0,
	(y, x) => ((((y * x) % 3) + (y + x) % 2) & 1) === 0,
];

const readCodewords = (mat, size, version, mask) => {
	const fn = buildFunctionMask(size, version);
	const maskFn = MASK_FUNCS[mask];
	const bits = [];
	let row = size - 1, inc = -1;
	for (let col = size - 1; col > 0; col -= 2) {
		if (col === 6) col--;
		for (;;) {
			for (let c = 0; c < 2; c++) {
				const cc = col - c;
				if (!fn[row * size + cc]) bits.push(mat[row * size + cc] ^ (maskFn(row, cc) ? 1 : 0));
			}
			row += inc;
			if (row < 0 || row >= size) { row -= inc; inc = -inc; break; }
		}
	}
	const bytes = new Uint8Array(bits.length >> 3);
	for (let i = 0; i < bytes.length * 8; i++) if (bits[i]) bytes[i >> 3] |= 0x80 >> (i & 7);
	return bytes;
};

const deinterleave = (codewords, version, level) => {
	const [r0, dL, eL, r1] = blockInfo(version, level);
	const rows = r0 + r1;
	const blocks = Array.from({length: rows}, (_, i) => new Uint8Array(dL + (i >= r0 ? 1 : 0) + eL));
	let p = 0;
	for (let i = 0; i < dL; i++) for (let r = 0; r < rows; r++) blocks[r][i] = codewords[p++] ?? 0;
	for (let r = 0; r < r1; r++) blocks[r0 + r][dL] = codewords[p++] ?? 0;
	for (let i = 0; i < eL; i++) {
		for (let r = 0; r < rows; r++) blocks[r][dL + (r >= r0 ? 1 : 0) + i] = codewords[p++] ?? 0;
	}
	return {blocks, r0, dL, eL, r1};
};

// ---------------------------------------------------------------------------
// 数据段
// ---------------------------------------------------------------------------
const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

const charCountBits = (mode, version) => {
	const range = Math.floor((version + 7) / 17) + 1;
	return mode === 1 ? [10, 12, 14][range - 1]
		: mode === 2 ? [9, 11, 13][range - 1]
		: [8, 16, 16][range - 1];
};

const parseSegments = (data, version) => {
	let bitPos = 0;
	const totalBits = data.length * 8;
	const read = n => {
		let v = 0;
		for (let i = 0; i < n; i++) {
			v = (v << 1) | ((data[bitPos >> 3] >> (7 - (bitPos & 7))) & 1);
			bitPos++;
		}
		return v;
	};

	let text = '';
	const modes = [];
	while (bitPos + 4 <= totalBits) {
		const mode = read(4);
		if (mode === 0) break;
		modes.push(mode);
		if (mode === 4) {
			const length = read(charCountBits(4, version));
			const bytes = new Uint8Array(length);
			for (let i = 0; i < length; i++) bytes[i] = read(8);
			text += new TextDecoder().decode(bytes);
		} else if (mode === 2) {
			const length = read(charCountBits(2, version));
			let i = 0;
			for (; i + 2 <= length; i += 2) {
				const v = read(11);
				text += ALNUM[Math.floor(v / 45)] + ALNUM[v % 45];
			}
			if (i < length) text += ALNUM[read(6)];
		} else if (mode === 1) {
			const length = read(charCountBits(1, version));
			let i = 0;
			for (; i + 3 <= length; i += 3) text += String(read(10)).padStart(3, '0');
			const rest = length - i;
			if (rest) text += String(read(rest * 3 + 1)).padStart(rest, '0');
		} else {
			throw new Error(`不支持的编码模式: ${mode}`);
		}
	}
	return {text, modes};
};

/**
 * 解码一个矩阵。
 *
 * @param {Int8Array|Uint8Array} modules 行优先
 * @param {number} size
 * @returns {{version: number, level: number, levelName: string, mask: number, text: string, modes: number[], blocks: Uint8Array[], data: Uint8Array}}
 */
export const decodeMatrix = (modules, size) => {
	const version = (size - 17) / 4;
	if (!Number.isInteger(version) || version < 1 || version > 40) throw new Error(`矩阵尺寸非法: ${size}`);

	const format = readFormat(modules, size);
	if (format.error) throw new Error(format.error);

	const codewords = readCodewords(modules, size, version, format.mask);
	const {blocks, r0, dL, eL, r1} = deinterleave(codewords, version, format.level);

	for (const block of blocks) {
		if (!reedSolomonOk(block, eL)) throw new Error('RS 校验失败');
	}

	const data = new Uint8Array(r0 * dL + r1 * (dL + 1));
	let p = 0;
	for (let r = 0; r < r0; r++) { data.set(blocks[r].subarray(0, dL), p); p += dL; }
	for (let r = 0; r < r1; r++) { data.set(blocks[r0 + r].subarray(0, dL + 1), p); p += dL + 1; }

	const {text, modes} = parseSegments(data, version);
	return {
		version,
		level: format.level,
		levelName: LEVEL_NAME[format.level],
		mask: format.mask,
		text,
		modes,
		blocks,
		data,
	};
};

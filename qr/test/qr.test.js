import {test} from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {generateQRCode, renderQRCodeToASCII, renderQRCodeToCanvas} from '../qr.js';
import {renderQRCodeToPNG} from '../qr-png.js';
import {crc32} from '../../jszip/zip-io.js';
import {blockInfo, checkVersionInfo, decodeMatrix, LEVEL_NAME, totalCodewords} from './qr-decode.js';

const toRows = ({modules, size}) => {
	const rows = [];
	for (let y = 0; y < size; y++) {
		let row = '';
		for (let x = 0; x < size; x++) row += modules[y * size + x];
		rows.push(row);
	}
	return rows;
};
const decode = (data, options) => {
	const {modules, size} = generateQRCode(data, options);
	return decodeMatrix(modules, size);
};

/** 解析 PNG，返回 {chunks, width, height, pixels(x,y)} */
const parsePNG = bytes => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG 签名');
	const chunks = [];
	let p = 8;
	while (p < bytes.length) {
		const length = view.getUint32(p);
		const type = new TextDecoder().decode(bytes.subarray(p + 4, p + 8));
		const data = bytes.subarray(p + 8, p + 8 + length);
		const crc = view.getUint32(p + 8 + length);
		assert.equal(crc, crc32(bytes.subarray(p + 4, p + 8 + length)), `${type} chunk 的 CRC`);
		chunks.push({type, data});
		p += 12 + length;
	}
	const ihdr = new DataView(chunks[0].data.buffer, chunks[0].data.byteOffset, chunks[0].data.byteLength);
	const width = ihdr.getUint32(0), height = ihdr.getUint32(4);
	const idat = chunks.find(c => c.type === 'IDAT').data;
	const raw = zlib.inflateSync(Buffer.from(idat));
	const stride = (width + 7) >> 3;
	assert.equal(raw.length, (stride + 1) * height, '解压后的扫描线长度');
	for (let y = 0; y < height; y++) assert.equal(raw[y * (stride + 1)], 0, '每行的 filter type 应为 0');
	return {
		chunks,
		width,
		height,
		dark: (x, y) => (((raw[y * (stride + 1) + 1 + (x >> 3)] >> (7 - (x & 7))) & 1) === 0),
	};
};

test('矩阵尺寸为 version*4+17，取值只有 0/1', () => {
	for (const version of [1, 2, 7, 20, 40]) {
		const {modules, size} = generateQRCode('hi', {version, level: 'L'});
		assert.equal(size, version * 4 + 17);
		assert.equal(modules.length, size * size);
		for (const v of modules) assert.ok(v === 0 || v === 1, `意外的模块值 ${v}`);
	}
});

test('所有版本 / 等级都能解码回原文', () => {
	for (let version = 1; version <= 40; version++) {
		for (const level of ['L', 'M', 'Q', 'H']) {
			const {modules, size} = generateQRCode('hi', {version, level});
			const result = decodeMatrix(modules, size);
			assert.equal(result.version, version);
			assert.equal(result.levelName, level);
			assert.equal(result.text, 'hi');
			assert.equal(checkVersionInfo(modules, size, version), true);
		}
	}
});

test('纠错块结构覆盖全部数据码字（helper 自检）', () => {
	// 顺便验证测试里用的独立表本身是完整的
	for (let version = 1; version <= 40; version++) {
		for (let level = 0; level < 4; level++) {
			const [r0, dL, eL, r1] = blockInfo(version, level);
			const total = r0 * dL + r1 * (dL + 1) + (r0 + r1) * eL;
			assert.equal(total, totalCodewords(version), `v${version} ${LEVEL_NAME[level]}`);
		}
	}
});

test('自动选择数字 / 字母数字 / 字节模式', () => {
	assert.deepEqual(decode('12345').modes, [1]);
	assert.deepEqual(decode('HELLO WORLD').modes, [2]);
	assert.deepEqual(decode('hello world').modes, [4]);
	assert.deepEqual(decode('中文').modes, [4]);
});

test('混合模式：数字段 + 字节段', () => {
	const text = '1234abc';
	const result = decode(text);
	assert.deepEqual(result.modes, [1, 4]);
	assert.equal(result.text, text);
});

test('URL 会被规范化（协议与大写域名），dumb 可关闭', () => {
	assert.equal(decode('https://example.com/Path?x=1').text, 'HTTPS://EXAMPLE.COM/Path?x=1');
	assert.equal(decode('https://example.com/Path?x=1', {dumb: true}).text, 'https://example.com/Path?x=1');
});

test('自动选择能装下的最小版本', () => {
	const small = generateQRCode('hi');
	const large = generateQRCode('x'.repeat(500));
	assert.equal(small.size, 21);
	assert.ok(large.size > small.size);
	assert.equal(decode('x'.repeat(500)).text, 'x'.repeat(500));
});

test('minVersion / maxVersion 生效', () => {
	assert.equal(generateQRCode('hi', {minVersion: 5}).size, 5 * 4 + 17);
	assert.equal(generateQRCode('hi', {maxVersion: 1}).size, 21);
	assert.throws(() => generateQRCode('x'.repeat(5000)), RangeError);
	assert.throws(() => generateQRCode('x'.repeat(500), {maxVersion: 5}), /maxVersion is too low/);
});

test('显式版本容量不足时抛 RangeError', () => {
	assert.throws(() => generateQRCode('x'.repeat(100), {version: 1}), /data too long/);
	assert.throws(() => generateQRCode('x'.repeat(100), {version: 1, level: 'H'}), /data too long/);
});

test('未指定等级时自动提升到能装的最高等级', () => {
	assert.equal(decode('A').levelName, 'H');
	assert.equal(decode('hello world').levelName, 'Q');
	assert.equal(decode('HELLO WORLD').levelName, 'Q');
});

test('显式指定等级时不再自动提升', () => {
	assert.equal(decode('A', {level: 'L'}).levelName, 'L');
	// 显式指定 version 时也不做等级提升（当前行为）
	assert.equal(decode('A', {version: 1}).levelName, 'L');
});

test('mask 参数被采用，不同 mask 产生不同矩阵', () => {
	const rows = new Set();
	for (let mask = 0; mask < 8; mask++) {
		const {modules, size} = generateQRCode('hi', {version: 2, level: 'M', mask});
		const result = decodeMatrix(modules, size);
		assert.equal(result.mask, mask);
		rows.add(toRows({modules, size}).join('\n'));
	}
	assert.equal(rows.size, 8);
});

test('不指定 mask 时自动选择 0-7 中的一个且结果确定', () => {
	const first = generateQRCode('1234567x', {version: 2, level: 'M'});
	const second = generateQRCode('1234567x', {version: 2, level: 'M'});
	const decoded = decodeMatrix(first.modules, first.size);
	assert.ok(decoded.mask >= 0 && decoded.mask <= 7);
	assert.deepEqual(toRows(first), toRows(second));
});

test('相同输入产生相同矩阵', () => {
	const a = generateQRCode('https://example.com');
	const b = generateQRCode('https://example.com');
	assert.deepEqual(toRows(a), toRows(b));
});

test('Unicode / emoji 内容往返', () => {
	const text = '中文测试 🎉';
	assert.equal(decode(text).text, text);
	assert.equal(decode('ÿ'.repeat(50)).text, 'ÿ'.repeat(50));
});

test('大内容往返', () => {
	const text = 'x'.repeat(2000);
	const result = decode(text);
	assert.ok(result.version > 20);
	assert.equal(result.text, text);
});

test('非法参数', () => {
	assert.throws(() => generateQRCode('A', {level: 'Z'}), RangeError);
	assert.throws(() => generateQRCode('A', {level: 'l'}), RangeError);
	assert.throws(() => generateQRCode('A', {version: 0}), RangeError);
	assert.throws(() => generateQRCode('A', {version: 41}), RangeError);
	assert.throws(() => generateQRCode('A', {version: 1.5}), RangeError);
});

test('与参考实现（segno）的矩阵逐位一致', () => {
	const vectors = [
		{
			text: '12345', version: 1, level: 'L', mask: 0,
			rows: ['111111100101101111111', '100000100111001000001', '101110101101101011101', '101110100101001011101', '101110100010101011101', '100000100000101000001', '111111101010101111111', '000000001101100000000', '111011111111011000100', '000110001110001000001', '000101100110100011100', '011101000110001001101', '001101101100101010011', '000000001111010101010', '111111101011011100111', '100000101011110111000', '101110101101011100101', '101110100100001000110', '101110101000100010001', '100000101110001000100', '111111101110101010101'],
		},
		{
			text: '1234567890123456789012345', version: 3, level: 'H', mask: 2,
			rows: ['11111110110000111000001111111', '10000010111001001000101000001', '10111010100100100010001011101', '10111010001101101010101011101', '10111010011101001110001011101', '10000010100100101101001000001', '11111110101010101010101111111', '00000000111100110111000000000', '00111010101011010001011100111', '00110000111111110010110101101', '00011011010101100111000000111', '00110100001101000101100101101', '11010011101011000011111110000', '01101101010101110001000011000', '01001110010011000110110101110', '01111000110101001100100010000', '10100111100101010010110110110', '10101100111110111100000010010', '10011011101001011000111111000', '10000101000000100010011010011', '10110010111111100110111111000', '00000000101000001100100010010', '11111110010110011110101011101', '10000010011001011100100010011', '10111010100011001001111111001', '10111010100100101011111011110', '10111010111011010110100010110', '10000010010111000000001111100', '11111110001101001111111110010'],
		},
		{
			text: 'A1B2C3D4E5F6G7', version: 2, level: 'M', mask: 4,
			rows: ['1111111010001110101111111', '1000001001100111001000001', '1011101000010010001011101', '1011101010001000001011101', '1011101010111000001011101', '1000001011101000101000001', '1111111010101010101111111', '0000000011001101100000000', '1000101111101100011111001', '0110000101100110111010000', '1010011111011000101111001', '1111100101111010010011001', '0100111000000111101100001', '1011000101001000001111010', '0010001100011111001100010', '0011100001110101111100010', '1100001000101100111111010', '0000000010100110100010011', '1111111010000001101011010', '1000001000001010100010101', '1011101011010111111110111', '1011101001101000110010101', '1011101001011110010101010', '1000001001010100110110111', '1111111011001100011101101'],
		},
	];
	for (const vector of vectors) {
		const {modules, size} = generateQRCode(vector.text, vector);
		assert.deepEqual(toRows({modules, size}), vector.rows, vector.text);
	}
});

test('ASCII 渲染的尺寸与边框', () => {
	const ascii = renderQRCodeToASCII('hi', {version: 1, background: 'white'});
	const lines = ascii.replace(/\n$/, '').split('\n');
	assert.equal(lines.length, Math.ceil(23 / 2));
	assert.equal(lines[0].length, 23);
	for (const line of lines) {
		assert.ok(/^[█▀▄ ]+$/.test(line), `非法字符: ${JSON.stringify(line)}`);
	}

	const noBorder = renderQRCodeToASCII('hi', {version: 1, border: 0, background: 'white'});
	assert.equal(noBorder.split('\n')[0].length, 21);
	const wideBorder = renderQRCodeToASCII('hi', {version: 1, border: 3, background: 'white'});
	assert.equal(wideBorder.split('\n')[0].length, 27);
});

test('ASCII 渲染（白底）逐点还原矩阵', () => {
	const {modules, size} = generateQRCode('hi', {version: 3, level: 'M', mask: 5});
	const ascii = renderQRCodeToASCII('hi', {version: 3, level: 'M', mask: 5, background: 'white', border: 1});
	const lines = ascii.replace(/\n$/, '').split('\n');
	const isDark = (x, y) => {
		const ch = lines[y >> 1][x];
		return y % 2 === 0 ? (ch === '█' || ch === '▀') : (ch === '█' || ch === '▄');
	};
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			assert.equal(+isDark(x + 1, y + 1), modules[y * size + x], `(${x},${y})`);
		}
	}
});

test('PNG 结构与 CRC', async () => {
	const blob = await renderQRCodeToPNG('hi', {version: 1});
	assert.equal(blob.type, 'image/png');
	const bytes = new Uint8Array(await blob.arrayBuffer());
	const {chunks, width, height} = parsePNG(bytes);
	assert.deepEqual(chunks.map(c => c.type), ['IHDR', 'IDAT', 'IEND']);
	assert.deepEqual([...chunks[0].data.subarray(8)], [1, 0, 0, 0, 0], '1bit 灰度、无隔行');
	assert.equal(width, 23);
	assert.equal(height, 23);
});

test('PNG 像素与矩阵一致（scale / border）', async () => {
	const options = {version: 2, level: 'Q', mask: 5, scale: 3, border: 2};
	const {modules, size} = generateQRCode('hi', options);
	const bytes = new Uint8Array(await (await renderQRCodeToPNG('hi', options)).arrayBuffer());
	const {width, height, dark} = parsePNG(bytes);
	assert.equal(width, (size + 4) * 3);
	assert.equal(height, (size + 4) * 3);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const mx = Math.floor(x / 3) - 2;
			const my = Math.floor(y / 3) - 2;
			const expected = mx >= 0 && my >= 0 && mx < size && my < size && modules[my * size + mx];
			assert.equal(+dark(x, y), +Boolean(expected), `(${x},${y})`);
		}
	}
});

test('PNG 默认参数：scale=1、border=1', async () => {
	const bytes = new Uint8Array(await (await renderQRCodeToPNG('hi', {version: 1})).arrayBuffer());
	const {width} = parsePNG(bytes);
	assert.equal(width, 23);
});

/** 一个只记录 fillRect 调用的假 canvas。 */
const fakeCanvas = () => {
	const calls = [];
	const context = {
		fillStyle: '',
		fillRect(...args) { calls.push([this.fillStyle, ...args]); },
	};
	return {
		calls,
		canvas: {
			style: {},
			width: 0,
			height: 0,
			getContext: () => context,
			title: '',
		},
	};
};

test('canvas 渲染画出背景和深色模块', () => {
	const {canvas, calls} = fakeCanvas();
	const {modules, size} = generateQRCode('hi', {version: 1, level: 'M'});
	const result = renderQRCodeToCanvas('hi', {version: 1, level: 'M', canvas, border: 2, width: 100, color: 'blue', background: '#eee'});
	assert.equal(result, canvas);
	assert.equal(canvas.width, size + 4);
	assert.equal(canvas.height, size + 4);
	assert.equal(canvas.style.width, '100px');
	assert.equal(canvas.style.height, '100px');
	assert.equal(canvas.style.imageRendering, 'pixelated');
	assert.equal(canvas.title, 'hi');
	assert.deepEqual(calls[0], ['#eee', 0, 0, size + 4, size + 4]);
	const dark = modules.reduce((a, b) => a + b, 0);
	assert.equal(calls.length - 1, dark);
	for (const call of calls.slice(1)) {
		assert.equal(call[0], 'blue');
		assert.equal(call[3], 1);
		assert.equal(call[4], 1);
	}
});

test('canvas 默认尺寸与样式', () => {
	const {canvas} = fakeCanvas();
	renderQRCodeToCanvas('hi', {version: 1, canvas});
	assert.equal(canvas.width, 23);
	assert.equal(canvas.style.width, `${21 * 8}px`);
});

test('没有 document 且未传 canvas 时报错', () => {
	assert.throws(() => renderQRCodeToCanvas('hi'), ReferenceError);
});

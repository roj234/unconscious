import {test} from 'node:test';
import assert from 'node:assert/strict';
import JSZip from '../JSZip.js';
import {crc32, ZipReader, ZipWriter} from '../zip-io.js';

const b64 = s => Uint8Array.from(Buffer.from(s, 'base64'));

/**
 * 外部实现（python zipfile）生成的 zip，用来验证读取端不是只认识自己写出来的格式。
 * plain:      store + deflate + 空文件 + UTF-8 文件名
 * descriptor: 使用 data descriptor 的流式 zip（local header 里 size 为 0）
 * dup:        含重复文件名
 * method99:   把压缩方法改成 99（不支持）
 */
const FIXTURES = {
	plain: 'UEsDBBQAAAAAAIBTb12NPrumBgAAAAYAAAAJAAAAc3RvcmUudHh0U1RPUkVEUEsDBBQAAAAIAIBTb12IyVJLDgAAALAEAAALAAAAZGVmbGF0ZS50eHRLTEpOHEWjaBSNoqGAAFBLAwQUAAAAAACAU29dAAAAAAAAAAAAAAAACQAAAGVtcHR5LnR4dFBLAwQUAAAICACAU29dQbiiUAgAAAAGAAAACgAAAOS4reaWhy50eHR7snfB06V7AVBLAQIUABQAAAAAAIBTb12NPrumBgAAAAYAAAAJAAAAAAAAAAAAAACAAQAAAABzdG9yZS50eHRQSwECFAAUAAAACACAU29diMlSSw4AAACwBAAACwAAAAAAAAAAAAAAgAEtAAAAZGVmbGF0ZS50eHRQSwECFAAUAAAAAACAU29dAAAAAAAAAAAAAAAACQAAAAAAAAAAAAAAgAFkAAAAZW1wdHkudHh0UEsBAhQAFAAACAgAgFNvXUG4olAIAAAABgAAAAoAAAAAAAAAAAAAAIABiwAAAOS4reaWhy50eHRQSwUGAAAAAAQABADfAAAAuwAAAAAA',
	descriptor: 'UEsDBBQACAAIAIBTb10AAAAAAAAAAAAAAAAHAAAAZGQxLnR4dEtJLElUSEktTi7KLCjJL1LIz0sFAFBLBwh52M6tFQAAABMAAABQSwMEFAAIAAgAgFNvXQAAAAAAAAAAAAAAAAcAAABkZDIudHh0K05Nzs9LKR4lR0mqkgBQSwcIp0Qlxg4AAABYAgAAUEsBAhQAFAAIAAgAgFNvXXnYzq0VAAAAEwAAAAcAAAAAAAAAAAAAAIABAAAAAGRkMS50eHRQSwECFAAUAAgACACAU29dp0Qlxg4AAABYAgAABwAAAAAAAAAAAAAAgAFKAAAAZGQyLnR4dFBLBQYAAAAAAgACAGoAAACNAAAAAAA=',
	dup: 'UEsDBBQAAAAAAIBTb11X7nGSBQAAAAUAAAAHAAAAZHVwLnR4dGZpcnN0UEsDBBQAAAAAAIBTb11pER+2BgAAAAYAAAAHAAAAZHVwLnR4dHNlY29uZFBLAQIUABQAAAAAAIBTb11X7nGSBQAAAAUAAAAHAAAAAAAAAAAAAACAAQAAAABkdXAudHh0UEsBAhQAFAAAAAAAgFNvXWkRH7YGAAAABgAAAAcAAAAAAAAAAAAAAIABKgAAAGR1cC50eHRQSwUGAAAAAAIAAgBqAAAAVQAAAAAA',
	method99: 'UEsDBBQAAABjAIBTb12NPrumBgAAAAYAAAAJAAAAc3RvcmUudHh0U1RPUkVEUEsDBBQAAABjAIBTb12IyVJLDgAAALAEAAALAAAAZGVmbGF0ZS50eHRLTEpOHEWjaBSNoqGAAFBLAwQUAAAAYwCAU29dAAAAAAAAAAAAAAAACQAAAGVtcHR5LnR4dFBLAwQUAAAIYwCAU29dQbiiUAgAAAAGAAAACgAAAOS4reaWhy50eHR7snfB06V7AVBLAQIUABQAAABjAIBTb12NPrumBgAAAAYAAAAJAAAAAAAAAAAAAACAAQAAAABzdG9yZS50eHRQSwECFAAUAAAAYwCAU29diMlSSw4AAACwBAAACwAAAAAAAAAAAAAAgAEtAAAAZGVmbGF0ZS50eHRQSwECFAAUAAAAYwCAU29dAAAAAAAAAAAAAAAACQAAAAAAAAAAAAAAgAFkAAAAZW1wdHkudHh0UEsBAhQAFAAACGMAgFNvXUG4olAIAAAABgAAAAoAAAAAAAAAAAAAAIABiwAAAOS4reaWhy50eHRQSwUGAAAAAAQABADfAAAAuwAAAAAA',
};

/** 解析 ZIP 的 EOCD，返回关键字段。 */
const readEOCD = bytes => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const eocd = bytes.length - 22;
	assert.equal(view.getUint32(eocd, true), 0x06054b50, 'EOCD 签名');
	return {
		offset: eocd,
		entries: view.getUint16(eocd + 10, true),
		cdSize: view.getUint32(eocd + 12, true),
		cdOffset: view.getUint32(eocd + 16, true),
		commentLen: view.getUint16(eocd + 20, true),
		view,
	};
};

/** 解析 local header 的关键字段。 */
const readLocalHeader = (bytes, offset = 0) => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	assert.equal(view.getUint32(offset, true), 0x04034b50, 'local header 签名');
	const nameLen = view.getUint16(offset + 26, true);
	const extraLen = view.getUint16(offset + 28, true);
	const decoder = new TextDecoder();
	return {
		version: view.getUint16(offset + 4, true),
		flags: view.getUint16(offset + 6, true),
		method: view.getUint16(offset + 8, true),
		crc: view.getUint32(offset + 14, true),
		compressedSize: view.getUint32(offset + 18, true),
		size: view.getUint32(offset + 22, true),
		name: decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLen)),
		dataOffset: offset + 30 + nameLen + extraLen,
	};
};

test('file() 作为 setter 返回自身，作为 getter 返回 ZipObject', () => {
	const zip = new JSZip();
	assert.equal(zip.file('a.txt', 'hello'), zip);
	const file = zip.file('a.txt');
	assert.equal(file.name, 'a.txt');
	assert.equal(file.dir, false);
	assert.deepEqual(file.options, {});
	assert.equal(zip.file('missing.txt'), null);
});

test('file(RegExp) 返回匹配的文件列表', () => {
	const zip = new JSZip();
	zip.file('a.txt', '1').file('b.md', '2').file('c.txt', '3');
	assert.deepEqual(zip.file(/\.txt$/).map(f => f.name), ['a.txt', 'c.txt']);
});

test('目录条目与隐式目录', () => {
	const zip = new JSZip();
	zip.file('dir/empty.txt', '');
	zip.file('empty/', null, {dir: true});
	assert.deepEqual(Object.keys(zip.files), ['dir/', 'dir/empty.txt', 'empty/']);
	assert.equal(zip.file('empty/').dir, true);
	assert.equal(zip.file('nope'), null);

	// createFolders 关闭时，目录只能靠前缀推断
	const lazy = new JSZip();
	lazy.file('lazy/a.txt', 'x', {createFolders: false});
	assert.deepEqual(Object.keys(lazy.files), ['lazy/a.txt']);
	assert.equal(lazy.file('lazy').dir, true, '没有显式条目时按前缀推断目录');
	assert.equal(lazy.file('lazy').name, 'lazy');
});

test('createFolders 应创建中间目录条目', () => {
	const zip = new JSZip();
	zip.file('a/b/c.txt', 'x');
	assert.deepEqual(Object.keys(zip.files).sort(), ['a/', 'a/b/', 'a/b/c.txt']);
	// 已存在的目录条目不能被覆盖，也不该被重复创建
	const d = new Date(2020, 0, 1);
	zip.file('a/', null, {dir: true, date: d});
	const before = zip.files['a/'];
	zip.file('a/b/other.txt', 'y');
	assert.equal(zip.files['a/'], before, '已有目录条目应保持原对象');
	// 目录条目本身也不再多建一层
	assert.deepEqual(Object.keys(zip.files).sort(), ['a/', 'a/b/', 'a/b/c.txt', 'a/b/other.txt']);
});

test('folder() 共享文件表并用前缀隔离路径', () => {
	const zip = new JSZip();
	zip.file('root.txt', 'r');
	const sub = zip.folder('dir');
	sub.file('a.txt', 'a');
	sub.folder('deep').file('b.txt', 'b');
	assert.equal(sub._prefix, 'dir/');
	assert.deepEqual(Object.keys(zip.files), ['root.txt', 'dir/', 'dir/a.txt', 'dir/deep/', 'dir/deep/b.txt']);
	assert.equal(sub.file('a.txt').name, 'dir/a.txt');
	assert.equal(sub.folder('deep')._prefix, 'dir/deep/');
});

test('forEach 给出相对路径，filter 按相对路径匹配', () => {
	const zip = new JSZip();
	zip.file('dir/a.txt', '1').file('dir/sub/b.md', '2');
	const names = [];
	zip.folder('dir').forEach((name, file) => names.push([name, file.name]));
	assert.deepEqual(names, [['a.txt', 'dir/a.txt'], ['sub/', 'dir/sub/'], ['sub/b.md', 'dir/sub/b.md']]);
	assert.deepEqual(zip.folder('dir').filter(name => /\.md$/.test(name)).map(f => f.name), ['dir/sub/b.md']);
});

test('remove 删除单个文件或整个目录', () => {
	const zip = new JSZip();
	zip.file('d/a', '1').file('d/b', '2').file('d2/c', '3').file('x.txt', '4');
	zip.remove('d');
	assert.deepEqual(Object.keys(zip.files), ['d2/', 'd2/c', 'x.txt']);
	zip.remove('d2/');
	assert.deepEqual(Object.keys(zip.files), ['x.txt']);
	zip.remove('x.txt');
	assert.deepEqual(Object.keys(zip.files), []);
});

test('文件名中的反斜杠被规范化为 /', () => {
	const zip = new JSZip();
	zip.file('a\\b\\c.txt', 'x');
	assert.deepEqual(Object.keys(zip.files), ['a/', 'a/b/', 'a/b/c.txt']);
	assert.equal(zip.file('a/b/c.txt').name, 'a/b/c.txt');
});

test('支持各种输入数据类型', async () => {
	const zip = new JSZip();
	zip.file('str.txt', 'hello');
	zip.file('b64.txt', Buffer.from('hi').toString('base64'), {base64: true});
	zip.file('u8.bin', new Uint8Array([1, 2, 3]));
	zip.file('ab.bin', new Uint8Array([4, 5]).buffer);
	zip.file('view.bin', new Uint8Array([9, 8, 7, 6]).subarray(1, 3));
	zip.file('blob.txt', new Blob(['blobdata']));

	assert.equal(await zip.file('str.txt').async('string'), 'hello');
	assert.equal(await zip.file('b64.txt').async('string'), 'hi');
	assert.deepEqual([...await zip.file('u8.bin').async('uint8array')], [1, 2, 3]);
	assert.deepEqual([...await zip.file('ab.bin').async('uint8array')], [4, 5]);
	assert.deepEqual([...await zip.file('view.bin').async('uint8array')], [8, 7], '视图应只取自己的区间');
	assert.equal(await zip.file('blob.txt').async('string'), 'blobdata');
	assert.equal(await zip.file('empty/', null, {dir: true}) instanceof JSZip, true);
});

test('async() 支持所有输出类型', async () => {
	const zip = new JSZip();
	zip.file('a.txt', 'hello');
	const file = zip.file('a.txt');
	assert.equal(await file.async('string'), 'hello');
	assert.equal(await file.async('text'), 'hello');
	assert.deepEqual([...await file.async('uint8array')], [104, 101, 108, 108, 111]);
	assert.deepEqual([...await file.async('array')], [104, 101, 108, 108, 111]);
	assert.ok((await file.async('arraybuffer')) instanceof ArrayBuffer);
	assert.ok((await file.async('blob')) instanceof Blob);
	assert.ok(Buffer.isBuffer(await file.async('nodebuffer')));
	assert.equal(await file.async('base64'), 'aGVsbG8=');
	assert.equal(await file.async('binarystring'), 'hello');
	await assert.rejects(() => file.async('nope'), /Unsupported type nope/);
});

test('不支持的数据类型会抛错', () => {
	const zip = new JSZip();
	assert.throws(() => zip.file('x', null), /Unsupported data type/);
	assert.throws(() => zip.file('x', {}), /Unsupported data type/);
	assert.throws(() => zip.file('x', 1), /Unsupported data type/);
});

test('generateAsync 输出的 ZIP 结构正确', async () => {
	const zip = new JSZip();
	zip.file('hello.txt', 'Hello World');
	const bytes = await zip.generateAsync({type: 'uint8array'});

	const local = readLocalHeader(bytes);
	assert.equal(local.version, 20);
	assert.equal(local.flags, 0x0800, '必须设置 UTF-8 文件名标志');
	assert.equal(local.method, 0, '默认 STORE');
	assert.equal(local.size, 11);
	assert.equal(local.compressedSize, 11);
	assert.equal(local.name, 'hello.txt');
	assert.equal(local.crc, crc32(new TextEncoder().encode('Hello World')));
	assert.equal(new TextDecoder().decode(bytes.subarray(local.dataOffset, local.dataOffset + 11)), 'Hello World');

	const eocd = readEOCD(bytes);
	assert.equal(eocd.entries, 1);
	assert.equal(eocd.commentLen, 0);
	assert.equal(eocd.view.getUint32(eocd.cdOffset, true), 0x02014b50, '中央目录签名');
	assert.equal(eocd.cdOffset, local.dataOffset + local.compressedSize);
	assert.equal(eocd.cdSize, 46 + 'hello.txt'.length);
});

test('generateAsync 支持所有输出类型', async () => {
	const zip = new JSZip();
	zip.file('a.txt', 'A');
	for (const type of ['uint8array', 'arraybuffer', 'blob', 'nodebuffer']) {
		const out = await zip.generateAsync({type});
		const bytes = type === 'blob' ? new Uint8Array(await out.arrayBuffer()) : new Uint8Array(out.buffer ?? out, out.byteOffset ?? 0, out.byteLength ?? out.length);
		assert.equal(new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true), 0x04034b50, type);
	}
	assert.equal(typeof await zip.generateAsync({type: 'base64'}), 'string');
	assert.equal(typeof await zip.generateAsync({type: 'binarystring'}), 'string');
	assert.equal((await zip.generateAsync({type: 'blob', mimeType: 'x/y'})).type, 'x/y');
});

test('generateAsync 缺少 type 时报错', async () => {
	const zip = new JSZip();
	zip.file('a', '1');
	await assert.rejects(() => zip.generateAsync({}), /Unsupported type undefined/);
});

test('generateAsync 空 zip 只有 EOCD', async () => {
	const bytes = await new JSZip().generateAsync({type: 'uint8array'});
	assert.equal(bytes.length, 22);
	const eocd = readEOCD(bytes);
	assert.equal(eocd.entries, 0);
	assert.equal(eocd.cdSize, 0);
	assert.equal(eocd.cdOffset, 0);
});

test('UTF-8 文件名与内容可以往返', async () => {
	const zip = new JSZip();
	zip.file('中文/名字.txt', '你好');
	const bytes = await zip.generateAsync({type: 'uint8array'});
	const local = readLocalHeader(bytes);
	assert.equal(local.name, '中文/名字.txt');
	assert.equal(local.flags & 0x0800, 0x0800);
	const reader = await ZipReader(Buffer.from(bytes));
	assert.equal(await reader.getText('中文/名字.txt'), '你好');
});

test('DEFLATE 压缩：体积变小、内容可还原、方法为 8', async () => {
	const zip = new JSZip();
	const text = 'abc'.repeat(1000);
	zip.file('big.txt', text, {compression: 'DEFLATE'});
	const bytes = await zip.generateAsync({type: 'uint8array'});
	const local = readLocalHeader(bytes);
	assert.equal(local.method, 8);
	assert.ok(local.compressedSize < local.size);
	assert.equal(local.size, 3000);

	const reader = await ZipReader(Buffer.from(bytes), {verify: true});
	assert.equal(await reader.getText('big.txt'), text);
});

test('压缩后反而更大时退回 STORE', async () => {
	const zip = new JSZip();
	zip.file('tiny.txt', 'x');
	const bytes = await zip.generateAsync({type: 'uint8array', compression: 'DEFLATE'});
	assert.equal(readLocalHeader(bytes).method, 0);
	const reader = await ZipReader(Buffer.from(bytes), {verify: true});
	assert.equal(await reader.getText('tiny.txt'), 'x');
});

test('generateAsync 的 compression 参数作用于所有条目', async () => {
	const zip = new JSZip();
	zip.file('a.txt', 'a'.repeat(500)).file('b.txt', 'b'.repeat(500));
	const bytes = await zip.generateAsync({type: 'uint8array', compression: 'DEFLATE'});
	const reader = await ZipReader(Buffer.from(bytes));
	for (const [, entry] of reader.entries()) assert.equal(entry.compression, 8);
});

test('onUpdate 报告进度与文件名', async () => {
	const zip = new JSZip();
	zip.file('empty/', null, {dir: true});
	zip.file('a', '1').file('b', '2').file('c', '3');
	const updates = [];
	await zip.generateAsync({type: 'uint8array'}, (percent, name) => updates.push([percent, name]));
	assert.deepEqual(updates.map(u => u[1]), ['a', 'b', 'c']);
	assert.equal(updates.at(-1)[0], 100);
});

test('静态字段', () => {
	assert.equal(JSZip.version, '3.10.1-shim');
	assert.equal(JSZip.support.base64, true);
	assert.equal(JSZip.support.uint8array, true);
	assert.equal(JSZip.support.nodestream, false);
});

test('loadAsync 在 Node 下应能加载自己生成的 zip', async () => {
	const zip = new JSZip();
	zip.file('a.txt', 'hello');
	const bytes = await zip.generateAsync({type: 'uint8array'});
	const loaded = await JSZip.loadAsync(bytes);
	assert.equal(await loaded.file('a.txt').async('string'), 'hello');
});

test('loadAsync 支持 Blob 输入', async () => {
	const zip = new JSZip();
	zip.file('a.txt', 'hello');
	const blob = await zip.generateAsync({type: 'blob'});
	const loaded = await JSZip.loadAsync(blob);
	assert.equal(await loaded.file('a.txt').async('string'), 'hello');
});

test('loadAsync 拒绝字符串输入', async () => {
	await assert.rejects(() => JSZip.loadAsync('not a zip'), /expected Blob, Uint8Array, or ArrayBuffer/);
});

test('loadAsync 不能在 folder() 返回的实例上调用', async () => {
	const zip = new JSZip();
	await assert.rejects(() => zip.folder('x').loadAsync(new Uint8Array()), /prefix stub/);
});

test('crc32 与标准一致', () => {
	assert.equal(crc32(new Uint8Array(0)), 0);
	assert.equal(crc32(new TextEncoder().encode('abc')), 0x352441c2);
	assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('ZipWriter 生成的文件可以用 ZipReader 读回', async () => {
	const writer = ZipWriter();
	assert.equal(writer.fileCount(), 0);
	await writer.add('a.txt', 'abc');
	await writer.add('b.bin', new Uint8Array([1, 2, 3]), {compression: 8});
	assert.equal(writer.fileCount(), 2);

	const blob = writer.finish();
	assert.ok(blob instanceof Blob);
	assert.equal(blob.type, 'application/zip');
	const reader = await ZipReader(Buffer.from(await blob.arrayBuffer()), {verify: true});
	assert.deepEqual([...reader.entries().keys()], ['a.txt', 'b.bin']);
	assert.equal(await reader.getText('a.txt'), 'abc');
	assert.deepEqual([...await reader.get('b.bin')], [1, 2, 3]);
});

test('ZipWriter 支持 brotli（仅 Node）', async () => {
	const writer = ZipWriter();
	const text = 'abc'.repeat(500);
	await writer.add('b.txt', text, {compression: 92});
	const reader = await ZipReader(Buffer.from(await writer.finish().arrayBuffer()), {verify: true});
	assert.equal([...reader.entries()][0][1].compression, 92);
	assert.equal(await reader.getText('b.txt'), text);
});

test('ZipWriter 未知压缩方法报错', async () => {
	const writer = ZipWriter();
	await assert.rejects(() => writer.add('x', 'abc', {compression: 13}), /Unsupported method/);
});

test('ZipWriter 流式模式返回的是函数，需要手动调用', async () => {
	const chunks = [];
	const writer = ZipWriter({write: async chunk => chunks.push(chunk)});
	await (await writer.add('a.txt', 'abc'))();
	assert.ok(chunks.length > 0);
});

test('ZipReader 可以读取外部实现生成的 zip', async () => {
	const reader = await ZipReader(Buffer.from(b64(FIXTURES.plain)), {verify: true});
	const entries = [...reader.entries()];
	assert.deepEqual(entries.map(([name]) => name), ['store.txt', 'deflate.txt', 'empty.txt', '中文.txt']);
	assert.equal(entries[0][1].compression, 0);
	assert.equal(entries[1][1].compression, 8);
	assert.equal(await reader.getText('store.txt'), 'STORED');
	assert.equal(await reader.getText('deflate.txt'), 'abc'.repeat(400));
	assert.equal(await reader.getText('empty.txt'), '');
	assert.equal(await reader.getText('中文.txt'), '你好');
	assert.equal(await reader.getText('missing.txt'), undefined);
	assert.equal(await reader.get('missing.txt'), null);
});

test('ZipReader 支持 data descriptor（local header 尺寸为 0）', async () => {
	const reader = await ZipReader(Buffer.from(b64(FIXTURES.descriptor)), {verify: true});
	assert.equal(await reader.getText('dd1.txt'), 'data descriptor one');
	assert.equal(await reader.getText('dd2.txt'), 'second'.repeat(100));
});

test('ZipReader 读到重复文件名时报错', async () => {
	await assert.rejects(() => ZipReader(Buffer.from(b64(FIXTURES.dup))), /Duplicate file dup\.txt/);
});

test('ZipReader 遇到不支持的压缩方法时报错', async () => {
	const reader = await ZipReader(Buffer.from(b64(FIXTURES.method99)));
	await assert.rejects(() => reader.get('store.txt'), /Unsupported compression method: 99/);
});

test('ZipReader 的 verify 会校验 CRC', async () => {
	const zip = new JSZip();
	zip.file('a.txt', 'hello world', {compression: 'STORE'});
	const bytes = await zip.generateAsync({type: 'uint8array'});
	const local = readLocalHeader(bytes);
	bytes[local.dataOffset] ^= 0xff; // 改坏第一个字节

	await assert.rejects(() => ZipReader(Buffer.from(bytes), {verify: true}).then(r => r.get('a.txt')), /Checksum error/);
	const lenient = await ZipReader(Buffer.from(bytes));
	assert.notEqual(await lenient.getText('a.txt'), 'hello world');
});

test('ZipReader 拒绝无效输入', async () => {
	await assert.rejects(() => ZipReader(Buffer.from([1, 2, 3])), /Not a valid ZIP file/);
	await assert.rejects(() => ZipReader(new Blob([])), /Input must be Buffer/);
	await assert.rejects(() => ZipReader('string'), /Input must be Buffer/);
});

test('ZipReader getRaw 返回未解压的数据', async () => {
	const zip = new JSZip();
	zip.file('a.txt', 'abc');
	const bytes = await zip.generateAsync({type: 'uint8array'});
	const reader = await ZipReader(Buffer.from(bytes));
	const entry = reader.entries().get('a.txt');
	assert.deepEqual([...await reader.getRaw(entry)], [97, 98, 99]);
});

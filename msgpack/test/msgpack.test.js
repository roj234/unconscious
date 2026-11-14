import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bakeSchema, decodeMsg, decodeRawMsg, encodeMsg, encodeRawMsg} from '../msgpack.js';

const fromHex = hex => new Uint8Array(hex.match(/../g)?.map(x => parseInt(x, 16)) ?? []);
const toHex = bytes => [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');

/** 解码结果用的是 null 原型对象，deepEqual 前先转成普通对象。 */
const plain = value => {
	if (Array.isArray(value)) return value.map(plain);
	if (ArrayBuffer.isView(value) && !(value instanceof Uint8Array)) return [...value];
	if (value && typeof value === 'object' && !(value instanceof Uint8Array) && !(value instanceof Date)) {
		const out = {};
		for (const [k, v] of Object.entries(value)) out[k] = plain(v);
		return out;
	}
	return value;
};

const roundtrip = (value, options) => decodeMsg(encodeMsg(value, options), options);
const assertRoundtrip = (value, options) => assert.deepEqual(plain(roundtrip(value, options)), plain(value));

test('基础类型往返', () => {
	assert.equal(roundtrip(null), null);
	assert.equal(roundtrip(true), true);
	assert.equal(roundtrip(false), false);
	assert.equal(roundtrip('hello'), 'hello');
	assert.equal(roundtrip(42), 42);
	assertRoundtrip([]);
	assertRoundtrip({});
});

test('整数按最小长度编码（与规范 / 参考实现一致）', () => {
	const vectors = [
		[0, '00'], [1, '01'], [127, '7f'],
		[128, 'cc80'], [255, 'ccff'],
		[256, 'cd0100'], [65535, 'cdffff'],
		[65536, 'ce00010000'], [4294967295, 'ceffffffff'],
	];
	for (const [value, hex] of vectors) assert.equal(toHex(encodeMsg(value)), hex, String(value));
});

test('负数按最小长度编码', () => {
	const vectors = [
		[-1, 'ff'], [-32, 'e0'],
		[-33, 'd0df'], [-128, 'd080'],
		[-129, 'd1ff7f'], [-32768, 'd18000'],
		[-32769, 'd2ffff7fff'], [-2147483648, 'd280000000'],
	];
	for (const [value, hex] of vectors) assert.equal(toHex(encodeMsg(value)), hex, String(value));
});

test('大于 2^32 的整数用 int64 编码并可还原', () => {
	for (const value of [4294967296, 2 ** 40, Number.MAX_SAFE_INTEGER, -2147483649, Number.MIN_SAFE_INTEGER]) {
		assert.equal(encodeMsg(value)[0], 0xd3, String(value));
		assert.equal(roundtrip(value), value, String(value));
	}
});

test('浮点数按 float64 编码', () => {
	const vectors = [
		[1.5, 'cb3ff8000000000000'],
		[-0.25, 'cbbfd0000000000000'],
		[Math.PI, 'cb400921fb54442d18'],
	];
	for (const [value, hex] of vectors) assert.equal(toHex(encodeMsg(value)), hex, String(value));
	assert.equal(roundtrip(-0.25), -0.25);
	assert.ok(Number.isNaN(roundtrip(NaN)));
	assert.equal(roundtrip(Infinity), Infinity);
	assert.equal(roundtrip(-Infinity), -Infinity);
});

test('useFloat32 用 float32 编码，精度相应降低', () => {
	const bytes = encodeMsg(0.1, {useFloat32: true});
	assert.equal(bytes[0], 0xca);
	assert.equal(decodeMsg(bytes), Math.fround(0.1));
	assert.notEqual(decodeMsg(bytes), 0.1);
	assert.equal(decodeMsg(encodeMsg(1.5, {useFloat32: true})), 1.5);
});

test('字符串长度使用 fixstr / str8 / str16 / str32', () => {
	const cases = [
		[0, 0xa0], [1, 0xa1], [31, 0xbf],
		[32, 0xd9], [255, 0xd9],
		[256, 0xda], [65535, 0xda],
		[65536, 0xdb],
	];
	for (const [length, tag] of cases) {
		const value = 'a'.repeat(length);
		const bytes = encodeMsg(value);
		assert.equal(bytes[0], tag, `len=${length}`);
		assert.equal(bytes.length, length + (length < 32 ? 1 : length < 256 ? 2 : length < 65536 ? 3 : 5));
		assert.equal(decodeMsg(bytes), value, `len=${length}`);
	}
});

test('UTF-8 字符串的字节长度与长度前缀一致', () => {
	for (const value of ['中文', '🎉', 'a中b🎉c', '汉字'.repeat(100), '🎉'.repeat(200)]) {
		const bytes = encodeMsg(value);
		const decoded = decodeMsg(bytes);
		assert.equal(decoded, value);
		// 解码器读出的长度是字节数，用 UTF-8 重新编码应完全一致
		assert.equal(toHex(bytes), toHex(encodeMsg(decoded)));
	}
});

test('二进制数据使用 bin 系列编码并可还原', () => {
	for (const length of [0, 1, 255, 256, 65535, 65536]) {
		const value = new Uint8Array(length).map((_, i) => i & 0xff);
		const bytes = encodeMsg(value);
		const expectedTag = length <= 0xff ? 0xc4 : length <= 0xffff ? 0xc5 : 0xc6;
		assert.equal(bytes[0], expectedTag, `len=${length}`);
		const decoded = roundtrip(value);
		assert.ok(decoded instanceof Uint8Array);
		assert.deepEqual([...decoded], [...value]);
	}
});

test('TypedArray 视图按数组编码', () => {
	assertRoundtrip(new Uint16Array([1, 65535, 0]));
	assertRoundtrip(new Float64Array([1.5, -2]));
	assertRoundtrip(new Uint8Array([1, 2, 3]).subarray(1));
});

test('数组长度使用 fixarray / array16 / array32', () => {
	for (const [length, tag] of [[0, 0x90], [1, 0x91], [15, 0x9f], [16, 0xdc], [255, 0xdc], [256, 0xdc], [65535, 0xdc], [65536, 0xdd]]) {
		const value = Array.from({length}, (_, i) => i & 7);
		const bytes = encodeMsg(value);
		assert.equal(bytes[0], tag, `len=${length}`);
		assert.equal(roundtrip(value).length, length, `len=${length}`);
	}
});

test('对象长度使用 fixmap / map16 / map32', () => {
	for (const [length, tag] of [[0, 0x80], [1, 0x81], [15, 0x8f], [16, 0xde], [255, 0xde], [256, 0xde]]) {
		const value = {};
		for (let i = 0; i < length; i++) value['k' + i] = i;
		const bytes = encodeMsg(value);
		assert.equal(bytes[0], tag, `len=${length}`);
		assert.equal(Object.keys(roundtrip(value)).length, length, `len=${length}`);
	}
});

test('嵌套结构往返', () => {
	const value = {
		id: 1,
		name: '测试',
		tags: ['a', 'b'],
		nested: {deep: {value: [1, null, true, {x: 'y'}]}},
		bin: new Uint8Array([1, 2, 3]),
	};
	const decoded = roundtrip(value);
	assert.deepEqual(plain(decoded), plain(value));
	assert.deepEqual([...decoded.bin], [1, 2, 3]);
});

test('解码出的对象原型为 null 且保留 toString / valueOf', () => {
	const decoded = roundtrip({a: 1});
	// 直接原型是只挂了 toString / valueOf 的 null 原型对象
	assert.equal(Object.getPrototypeOf(Object.getPrototypeOf(decoded)), null);
	assert.equal(Object.prototype.isPrototypeOf(decoded), false);
	assert.equal(typeof decoded.toString, 'function');
	assert.equal(decoded.toString(), '[object Object]');
	assert.equal(String(decoded), '[object Object]');
	assert.equal(decoded.valueOf(), decoded);
});

test('对象键名 __proto__ 不会污染原型链', () => {
	const value = JSON.parse('{"__proto__": {"polluted": true}}');
	const decoded = roundtrip(value);
	assert.ok(Object.prototype.hasOwnProperty.call(decoded, '__proto__'));
	assert.equal(({}).polluted, undefined);
});

test('undefined 默认被忽略，ignoreUndefined=false 时编码为 null', () => {
	assert.equal(encodeMsg(undefined).length, 0);
	assert.deepEqual(plain(roundtrip({a: undefined, b: 1})), {b: 1});
	assert.deepEqual(plain(roundtrip({a: undefined}, {ignoreUndefined: false})), {a: null});
});

test('sortKeys 让输出与键顺序无关', () => {
	const a = encodeMsg({b: 1, a: 2}, {sortKeys: true});
	const b = encodeMsg({a: 2, b: 1}, {sortKeys: true});
	assert.equal(toHex(a), toHex(b));
	assert.equal(toHex(a), '82a16102a16201');
	// 嵌套对象同样排序
	assert.equal(toHex(encodeMsg({b: {z: 1, a: 2}, a: 0}, {sortKeys: true})),
		toHex(encodeMsg({a: 0, b: {a: 2, z: 1}}, {sortKeys: true})));
});

test('replacer 在编码前转换对象', () => {
	const replacer = obj => (obj && obj.constructor === Object ? {...obj, added: true} : obj);
	assert.deepEqual(plain(roundtrip({a: 1}, {replacer})), {a: 1, added: true});
});

test('multiple 连续解码直到输入结束', () => {
	const bytes = fromHex(toHex(encodeMsg(1)) + toHex(encodeMsg('a')) + toHex(encodeMsg([1])));
	assert.deepEqual(decodeMsg(bytes, {multiple: true}), [1, 'a', [1]]);
	assert.deepEqual(decodeMsg(new Uint8Array(0), {multiple: true}), []);
});

test('decodeRawMsg 返回值与新的偏移', () => {
	const bytes = encodeMsg('hello');
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const [value, offset] = decodeRawMsg(view, 0);
	assert.equal(value, 'hello');
	assert.equal(offset, bytes.length);

	const joined = new Uint8Array([...encodeMsg(1), ...encodeMsg('x')]);
	const jv = new DataView(joined.buffer);
	assert.deepEqual(decodeRawMsg(jv, 0), [1, 1]);
	assert.deepEqual(decodeRawMsg(jv, 1), ['x', 3]);
});

test('encodeRawMsg 的分块可以拼回完整结果', () => {
	for (const value of [1, 'hello', {a: [1, 2, 3]}, 'x'.repeat(1000), Array.from({length: 500}, (_, i) => i)]) {
		const chunks = [];
		encodeRawMsg(value, (chunk, shared) => {
			// shared 为 true 表示 chunk 是内部缓冲的视图，异步使用前必须复制
			assert.ok(shared === undefined || typeof shared === 'boolean');
			chunks.push(chunk.slice());
		});
		const joined = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
		let p = 0;
		for (const chunk of chunks) { joined.set(chunk, p); p += chunk.length; }
		assert.equal(toHex(joined), toHex(encodeMsg(value)));
	}
});

test('跨内部缓冲区边界的值可以正确往返', () => {
	const value = {
		text: '汉字'.repeat(500),
		ascii: 'b'.repeat(2000),
		list: Array.from({length: 1000}, (_, i) => ({i, s: 'v' + i})),
	};
	const decoded = roundtrip(value);
	assert.equal(decoded.text, value.text);
	assert.equal(decoded.ascii, value.ascii);
	assert.equal(decoded.list.length, 1000);
	assert.deepEqual(plain(decoded.list[999]), value.list[999]);
});

test('byte 输入支持 Array / Buffer / DataView / 带偏移的视图', () => {
	const bytes = encodeMsg([1, 'x', true]);
	const asArray = bytes.buffer;
	assert.deepEqual(decodeMsg([...bytes]), [1, 'x', true]);
	assert.deepEqual(decodeMsg(Buffer.from(bytes)), [1, 'x', true]);
	assert.deepEqual(decodeMsg(new DataView(asArray, bytes.byteOffset, bytes.byteLength)), [1, 'x', true]);

	const padded = new Uint8Array(bytes.length + 2);
	padded.set(bytes, 1);
	const view = new Uint8Array(padded.buffer, 1, bytes.length);
	assert.deepEqual(decodeMsg(view), [1, 'x', true]);
});

test('bakeSchema 添加 locate 并可重复调用', () => {
	const schema = ['id', 'name'];
	bakeSchema(schema);
	assert.equal(schema.locate('id'), 0);
	assert.equal(schema.locate('name'), 1);
	assert.equal(schema.locate('missing'), -1);
	bakeSchema(schema); // 幂等
	assert.equal(schema.locate('name'), 1);
});

test('schema 用整数键编码对象字段', () => {
	const schema = ['id', 'name'];
	bakeSchema(schema);
	const value = {id: 7, name: 'n'};
	const bytes = encodeMsg(value, schema);
	// 82 00 07 01 a1 6e：map(2) + fixint(0)=id + 7 + fixint(1)=name + "n"
	assert.equal(toHex(bytes), '82000701a16e');
	assert.deepEqual(plain(decodeMsg(bytes, {schema})), value);
	assert.deepEqual(Object.keys(decodeMsg(bytes, {schema})), ['id', 'name']);
});

test('schema 支持嵌套字段与枚举值映射', () => {
	const schema = ['id', ['tags', ['t0', 't1']], ['kind', null, ['A', 'B', 'C']]];
	bakeSchema(schema);
	const value = {id: 1, tags: {t0: 'x'}, kind: 'B'};
	const decoded = decodeMsg(encodeMsg(value, schema), {schema});
	assert.deepEqual(plain(decoded), value);
	// 枚举值被编码成索引 1
	assert.equal(encodeMsg({kind: 'B'}, schema).at(-1), 1);
	assert.equal(encodeMsg({kind: 'C'}, schema).at(-1), 2);
});

test('schema 中未声明的键回退为字符串键', () => {
	const schema = ['id'];
	bakeSchema(schema);
	const value = {id: 1, extra: 'e'};
	const bytes = encodeMsg(value, schema);
	assert.equal(encodeMsg(value, schema)[1], 0);
	assert.deepEqual(plain(decodeMsg(bytes, {schema})), value);
});

test('未 bakeSchema 的 schema 会被忽略（文档要求先 bake）', () => {
	const schema = ['id', 'name'];
	const value = {id: 1, name: 'n'};
	assert.equal(toHex(encodeMsg(value, schema)), toHex(encodeMsg(value)));
});

test('decodeExt 自定义扩展类型', () => {
	const bytes = fromHex('d40542'); // fixext1, type 5, data 0x42
	const seen = [];
	const decoded = decodeMsg(bytes, {
		decodeExt(view, type, offset, length) {
			seen.push([type, offset, length]);
			return {type, value: view.getUint8(offset)};
		},
	});
	assert.deepEqual(seen, [[5, 2, 1]]);
	assert.deepEqual(decoded, {type: 5, value: 0x42});
});

test('未知扩展类型默认抛错', () => {
	assert.throws(() => decodeMsg(fromHex('d40542')), /自定义类型: 0x5/);
});

test('不同长度的扩展类型会解析出正确的段长度', () => {
	const lengths = {d4: 1, d5: 2, d6: 4, d7: 8, d8: 16};
	for (const [tag, len] of Object.entries(lengths)) {
		const data = fromHex(tag + '07' + '00'.repeat(len));
		const out = decodeMsg(data, {decodeExt: (v, t, off, l) => [t, off, l]});
		assert.deepEqual(out, [7, 2, len], tag);
	}
});

test('timestamp 32 / 64 / 96 解码', () => {
	assert.equal(decodeMsg(fromHex('d6ff00000001')).getTime(), 1000);
	assert.equal(decodeMsg(fromHex('d7ff1d5353005e0be100')).getTime(), new Date('2020-01-01T00:00:00.123Z').getTime());
	assert.equal(decodeMsg(fromHex('c70cff00000000ffffffff7c558180')).getTime(), new Date('1900-01-01T00:00:00Z').getTime());
	assert.throws(() => decodeMsg(fromHex('d4ff00')), /时间戳长度无效/);
});

test('Date 编码与参考实现一致', () => {
	const vectors = [
		['2020-01-01T00:00:00Z', 'd6ff5e0be100'],
		['2020-01-01T00:00:00.123Z', 'd7ff1d5353005e0be100'],
		['1900-01-01T00:00:00Z', 'c70cff00000000ffffffff7c558180'],
		['2200-01-01T00:00:00Z', 'd7ff00000001b09e1900'],
	];
	for (const [iso, hex] of vectors) {
		const date = new Date(iso);
		assert.equal(toHex(encodeMsg(date)), hex, iso);
		assert.equal(roundtrip(date).getTime(), date.getTime(), iso);
	}
});

test('毫秒与 1970 之前的 Date 往返', () => {
	for (const time of [0, 1, -1, 1234567890123, -1234567890123, 4102444800000]) {
		const date = new Date(time);
		assert.equal(roundtrip(date).getTime(), time, String(time));
	}
});

test('bigint 选项：超出安全整数时保留 BigInt', () => {
	const bytes = fromHex('cf2000000000000000');
	assert.equal(decodeMsg(bytes), 2 ** 61);
	assert.equal(decodeMsg(bytes, {bigint: true}), 2n ** 61n);
	assert.equal(decodeMsg(fromHex('d37fffffffffffffff'), {bigint: true}), 2n ** 63n - 1n);
	assert.equal(decodeMsg(encodeMsg(2n ** 63n - 1n), {bigint: true}), 2n ** 63n - 1n);
});

test('bigint 超出 int64 范围抛出异常', () => {
	assert.throws(() => encodeMsg(2n ** 64n), RangeError);
	assert.throws(() => encodeMsg(-(2n ** 63n) - 1n), RangeError);
});

test('错误输入', () => {
	assert.throws(() => decodeMsg('not bytes'), /不支持的输入/);
	assert.throws(() => decodeMsg(new Uint8Array(0)), RangeError);
	assert.throws(() => decodeMsg(fromHex('c1')), /0xC1/);
	assert.throws(() => encodeMsg(new Map()), TypeError);
});

test('encodeMsg 返回的数组不与内部缓冲共享', () => {
	const first = encodeMsg({a: 1});
	const second = encodeMsg({b: 2});
	assert.notEqual(first.buffer, second.buffer);
	first.fill(0);
	assert.equal(toHex(second), toHex(encodeMsg({b: 2})));
});

test('相同字符串多次解码结果稳定', () => {
	const bytes = encodeMsg({hello: 'world', other: 'world'});
	for (let i = 0; i < 100; i++) {
		assert.deepEqual(plain(decodeMsg(bytes)), {hello: 'world', other: 'world'});
	}
});

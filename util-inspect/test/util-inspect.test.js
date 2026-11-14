import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspect, INSPECT_ALL, inspectTypedArray} from '../index.js';
import {parseJson5} from '@roj234/stream-json';

/**
 * 「能直接粘回代码里」是 inspect 的核心承诺，所以用同仓库的解析器验一遍。
 * @param {string} text
 */
const roundTrip = text => parseJson5(text);

test('基本类型', () => {
	assert.equal(inspect(1), '1');
	assert.equal(inspect(-1.5e3), '-1500');
	assert.equal(inspect(true), 'true');
	assert.equal(inspect(false), 'false');
	assert.equal(inspect(null), 'null');
	assert.equal(inspect(10n), '10n');
	assert.equal(inspect(undefined), undefined, '顶层 undefined 无法表示');
});

test('字符串：引号、反斜杠与控制字符', () => {
	assert.equal(inspect('abc'), '"abc"');
	assert.equal(inspect('a"b'), '"a\\"b"');
	assert.equal(inspect('a\\b'), '"a\\\\b"');
	assert.equal(inspect('a\tb'), '"a\\tb"');
	assert.equal(inspect('\x00'), '"\\x00"');
	assert.equal(inspect('\b\v\f\r'), '"\\b\\v\\f\\r"');
	assert.equal(inspect('\u2028\u2029'), '"\\u2028\\u2029"');
	// 反引号、${ 只在模板字符串里需要转义
	assert.equal(inspect('a`b'), '"a`b"');
	assert.equal(inspect('a${b}'), '"a${b}"');
});

test('字符串：含换行时使用模板字符串，并转义反引号与 ${', () => {
	assert.equal(inspect('a\nb'), '`a\nb`');
	assert.equal(inspect('a\n`b`'), '`a\n\\`b\\``');
	assert.equal(inspect('a\n${b}'), '`a\n\\${b}`');
});

test('数组：纯标量内联，其他换行缩进', () => {
	assert.equal(inspect([]), '[]');
	assert.equal(inspect([1, 2, 3]), '[ 1, 2, 3 ]');
	assert.equal(inspect([1, [2, 3]]), '[\n  1,\n  [ 2, 3 ]\n]');
	assert.equal(inspect([1, {a: 2}]), '[\n  1,\n  {\n    a: 2\n  }\n]');
});

test('对象：合法键名裸写，非法键名加引号', () => {
	assert.equal(inspect({a: 1}), '{\n  a: 1\n}');
	assert.equal(inspect({'b-c': 1}), '{\n  "b-c": 1\n}');
	assert.equal(inspect({'a b': 1}), '{\n  "a b": 1\n}');
	assert.equal(inspect({1.5: 'x'}), '{\n  1.5: "x"\n}');
	assert.equal(inspect({}), '{}');
	assert.equal(inspect({a: {b: {c: 1}}}), '{\n  a: {\n    b: {\n      c: 1\n    }\n  }\n}');
});

test('对象中的 undefined：默认丢弃，INSPECT_ALL 保留', () => {
	assert.equal(inspect({a: undefined, b: 1}), '{\n  b: 1\n}');
	assert.equal(inspect({a: undefined, b: 1}, INSPECT_ALL), '{\n  a: undefined,\n  b: 1\n}');
	assert.equal(inspect([1, undefined, 2]), '[ 1, null, 2 ]', '数组里的 undefined 变成 null');
});

test('symbol 键默认被忽略，INSPECT_ALL 才输出', () => {
	const value = {[Symbol('k')]: 1, a: 2};
	assert.deepEqual(Object.keys(roundTrip(inspect(value))), ['a']);
	assert.match(inspect(value, INSPECT_ALL), /Symbol\(/);
});

test('函数、正则、Error', () => {
	assert.equal(inspect(function foo() {}), '[Function: foo]');
	assert.equal(inspect(() => {}), '[Function: anonymous]');
	assert.equal(inspect(/ab+c/gi), '/ab+c/gi');
	const errorText = inspect(new Error('boom'));
	assert.match(errorText, /^Error: boom/);
	assert.match(errorText, /\n\s+at /, 'Error 应输出 stack');
});

test('Date 走 toJSON', () => {
	assert.equal(inspect(new Date(0)), '"1970-01-01T00:00:00.000Z"');
});

test('Map / Set', () => {
	assert.equal(inspect(new Map([[1, 'a'], ['b', 2]])), 'Map(2) [\n  1 => "a",\n  "b" => 2\n]');
	assert.equal(inspect(new Set([1, 'a'])), 'Set(2) [\n  1,\n  "a"\n]');
	assert.equal(inspect(new Map()), 'Map(0) []');
	assert.equal(inspect(new Set()), 'Set(0) []');
});

test('循环引用有标记', () => {
	const a = {};
	a.self = a;
	assert.equal(inspect(a), '{\n  self: *#0 /* Circular reference */\n}');
});

test('缩进支持数字和字符串', () => {
	assert.equal(inspect({a: {b: 1}}, undefined, 4), '{\n    a: {\n        b: 1\n    }\n}');
	assert.equal(inspect({a: 1}, undefined, '\t'), '{\n\ta: 1\n}');
	assert.equal(inspect({a: {b: 1}}, undefined, 0), '{\na: {\nb: 1\n}\n}');
});

test('TypedArray / DataView / ArrayBuffer', () => {
	assert.equal(inspect(new Uint8Array([1, 2, 3])), 'Uint8Array(3) [ 1, 2, 3 ]');
	assert.equal(inspect(new Uint8Array(0)), 'Uint8Array(0) []');
	assert.equal(
		inspect(new DataView(new Uint8Array([1, 2, 3, 4]).buffer)),
		'DataView {\n  buffer: Uint8Array(4) [ 1, 2, 3, 4 ]\n  byteOffset: 0\n  byteLength: 4\n}',
	);
	assert.equal(
		inspect(new Uint8Array([1, 2, 3]).buffer),
		'ArrayBuffer {\n  [Uint8Contents]: Uint8Array(3) [ 1, 2, 3 ]\n  [ByteLength]: 3\n}',
	);
});

test('自定义 replacer 可以过滤 / 改写属性', () => {
	const source = {a: 1, b: 2};
	assert.equal(inspect(source, (key, value) => key === 'b' ? undefined : value), '{\n  a: 1\n}');
	assert.equal(inspect(source, (key, value) => typeof value === 'number' ? value * 10 : value), '{\n  a: 10,\n  b: 20\n}');
});

test('inspectTypedArray：Buffer 与普通 TypedArray', () => {
	assert.equal(inspectTypedArray(Buffer.from([0, 255, 16])), '<Buffer 00 ff 10>');
	assert.equal(inspectTypedArray(new Uint8Array([1, 2, 3])), 'Uint8Array(3) [ 1, 2, 3 ]');
	assert.equal(inspectTypedArray(new Uint8Array(0)), 'Uint8Array(0) []');
});

test('inspectTypedArray：截断长数组', () => {
	const bytes = new Uint8Array(120);
	const text = inspectTypedArray(bytes);
	assert.match(text, /^Uint8Array \[ 0, 0, .*\.\.\. 70 more items \]$/);

	const buffer = Buffer.alloc(120, 0xab);
	buffer[0] = 0;
	buffer[119] = 255;
	assert.equal(
		inspectTypedArray(buffer),
		`<Buffer 00 ${'ab '.repeat(49)}... 20 more bytes ... ${'ab '.repeat(49)}ff>`,
	);
});

test('round-trip：普通 JSON 值可以粘回代码', () => {
	const value = {
		num: 1.5,
		neg: -2,
		truthy: true,
		nothing: null,
		text: 'a"b\\c\t\x1F',
		multiline: 'line1\nline2',
		'needs\nquote': 'x',
		list: [1, 'two', {three: 3}],
	};
	assert.deepEqual(JSON.parse(JSON.stringify(roundTrip(inspect(value)))), value);
});

test('round-trip：toJSON 生效', () => {
	const value = {toJSON: () => ({ok: 1})};
	assert.deepEqual(JSON.parse(JSON.stringify(roundTrip(inspect(value)))), {ok: 1});
});

// ── 已知 bug ───────────────────────────────────────────────────────────────

test('identifier 形式的 symbol description 应加引号', {todo: "这和真正的控制台输出比较像"}, () => {
	assert.equal(inspect(Symbol('hi')), 'Symbol("hi")');
	assert.equal(inspect(Symbol('a b')), 'Symbol("a b")');
});

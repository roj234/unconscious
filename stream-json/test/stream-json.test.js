import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createJsonParser, parseJson5} from '../index.js';

/** 用给定分块喂给解析器，返回根值。 */
function parseChunks(source, options, chunks = [source]) {
	const parser = createJsonParser(() => {}, options);
	for (const chunk of chunks) parser.write(chunk);
	return parser.end();
}

/** 收集 (path, value, isPartial) 事件。 */
function collect(source, options, chunks = [source]) {
	const events = [];
	const parser = createJsonParser((path, value, partial) => events.push([[...path], value, partial]), options);
	for (const chunk of chunks) parser.write(chunk);
	const root = parser.end();
	return {events, root};
}

/** 解析结果是 betterObject 原型，比较前先拍平成普通对象。 */
const jsonEqual = (actual, expected) => assert.equal(JSON.stringify(actual), JSON.stringify(expected));

test('parseJson5：基本 JSON', () => {
	assert.equal(parseJson5('null'), null);
	assert.equal(parseJson5('true'), true);
	assert.equal(parseJson5('false'), false);
	assert.equal(parseJson5('0'), 0);
	assert.equal(parseJson5('-1.5e3'), -1500);
	assert.equal(parseJson5('"str"'), 'str');
	jsonEqual(parseJson5('{"a":1,"b":[2,3]}'), {a: 1, b: [2, 3]});
	jsonEqual(parseJson5('[]'), []);
	jsonEqual(parseJson5('{}'), {});
});

test('parseJson5：默认开启 JSON5', () => {
	jsonEqual(parseJson5('{a:1, b:[1,2,]}'), {a: 1, b: [1, 2]});
	jsonEqual(parseJson5('// hi\n{a:1}'), {a: 1});
	jsonEqual(parseJson5('{/* block */a:1}'), {a: 1});
	assert.equal(parseJson5("'single'"), 'single');
	assert.equal(parseJson5('`backtick`'), 'backtick');
	assert.equal(parseJson5('0x1F'), 31);
	assert.equal(parseJson5('1_000'), 1000);
	assert.equal(parseJson5('+1'), 1);
	assert.equal(parseJson5('Infinity'), Infinity);
	assert.equal(parseJson5('-Infinity'), -Infinity);
	assert.equal(Number.isNaN(parseJson5('NaN')), true);
	assert.equal(parseJson5('123n'), 123n);
});

test('字符串转义', () => {
	assert.equal(parseJson5('"a\\nb\\tc\\r\\b\\f\\v"'), 'a\nb\tc\r\b\f\v');
	assert.equal(parseJson5('"\\x41"'), 'A');
	assert.equal(parseJson5('"\\u00e9"'), 'é');
	assert.equal(parseJson5('"\\uD83D\\uDE00"'), '😀');
	assert.equal(parseJson5('"a\\\nb"'), 'ab', '反斜杠+换行应被忽略');
	assert.equal(parseJson5('"a\nb"'), 'a\nb', '允许未转义控制字符');
	assert.equal(parseJson5('"a\\/b"'), 'a/b');
});

test('非法字符串转义报错', () => {
	assert.throws(() => parseJson5('"\\uZZZZ"'), /ESCAPE/);
	assert.throws(() => parseJson5('"\\u12"'), /state=3|EOF/);
});

test('注释可以跨 chunk', () => {
	jsonEqual(parseChunks('{a:1 /* c */, b:2}', {json5: true}, ['{a:1 /*', ' c */, b:2}']), {a: 1, b: 2});
	jsonEqual(parseChunks('{a:1 // c\n, b:2}', {json5: true}, ['{a:1 // c', '\n, b:2}']), {a: 1, b: 2});
	jsonEqual(parseChunks('{a:1 /* c *', {json5: true}, ['{a:1 /* c *', '/, b:2}']), {a: 1, b: 2});
});

test('任意切分位置的结果都与整段解析一致', () => {
	const docs = [
		['{"a":1,"b":[true,false,null],"c":"x"}', {}],
		['{"a":{"b":{"c":[1,2,3]}}}', {}],
		['[1,-2.5e3,0x1f,"s",{}]', {json5: true}],
		['{a:1, b:[1,2,],}', {json5: true}],
		['/*c*/ {a:1 // x\n, b:2}', {json5: true}],
		['{"s":"a\\u00e9\\n\\t\\"b\\\\c"}', {}],
		['{"s":"\\uD83D\\uDE00"}', {}],
		['{a: hello, b: world}', {yaml: true, json5: true}],
	];
	for (const [source, options] of docs) {
		let expected;
		try {
			expected = JSON.stringify(parseChunks(source, options));
		} catch (e) {
			expected = 'ERR:' + String(e).split('\n')[0];
		}
		for (let cut = 1; cut < source.length; cut++) {
			let actual;
			try {
				actual = JSON.stringify(parseChunks(source, options, [source.slice(0, cut), source.slice(cut)]));
			} catch (e) {
				actual = 'ERR:' + String(e).split('\n')[0];
			}
			assert.equal(actual, expected, `在 ${cut} 处切分后结果应一致：${source}`);
		}
	}
});

test('流式回调：路径与值', () => {
	const {events, root} = collect('{"a":{"b":[0,{"c":true}]}}', {});
	const finals = events.filter(([, , partial]) => !partial).map(([path, value]) => [path, value]);
	jsonEqual(finals, [
		[['a', 'b', 0], 0],
		[['a', 'b', 1, 'c'], true],
		[['a', 'b', 1], {c: true}],
		[['a', 'b'], [0, {c: true}]],
		[['a'], {b: [0, {c: true}]}],
		[[], {a: {b: [0, {c: true}]}}],
	]);
	jsonEqual(root, {a: {b: [0, {c: true}]}});
});

test('流式回调：对象 / 数组开始时会有一个 partial=true 的事件', () => {
	const {events} = collect('[1,{"a":2}]', {});
	jsonEqual(events, [
		[[0], 1, false],
		[[1], {a: 2}, true],
		[[1, 'a'], 2, false],
		[[1], {a: 2}, false],
		[[], [1, {a: 2}], false],
	]);
});

test('流式回调：字符串 prefix 模式', () => {
	const {events, root} = collect('{"text":"hello world"}', {}, ['{"text":"hello ', 'world"}']);
	jsonEqual(events, [
		[['text'], 'hello ', true],
		[['text'], 'hello world', false],
		[[], {text: 'hello world'}, false],
	]);
	jsonEqual(root, {text: 'hello world'});
});

test('流式回调：字符串 delta 模式', () => {
	const {events, root} = collect('{"text":"hello world"}', {emitDelta: true}, ['{"text":"hel', 'lo wo', 'rld"}']);
	jsonEqual(events, [
		[['text'], 'hel', true],
		[['text'], 'lo wo', true],
		[['text'], 'hello world', false],
		[[], {text: 'hello world'}, false],
	]);
	jsonEqual(root, {text: 'hello world'});
});

test('顶层字符串不会触发 partial 回调，但 end() 返回完整值', () => {
	const {events, root} = collect('"hello world"', {}, ['"hello ', 'world"']);
	assert.deepEqual(events, []);
	assert.equal(root, 'hello world');
});

test('JSONL：逐个输出根值', () => {
	const {events} = collect('{"a":1}\n2\n"three"\n', {jsonl: true});
	const roots = events.filter(([path, , partial]) => path.length === 0 && !partial).map(([, value]) => value);
	jsonEqual(roots, [{a: 1}, 2, 'three']);
});

test('end(ignoreUnexpected) 容忍未完成的输入', () => {
	const parser = createJsonParser(() => {}, {});
	parser.write('{"a":1');
	assert.doesNotThrow(() => parser.end(true));

	const parser2 = createJsonParser(() => {}, {});
	parser2.write('[1,2');
	assert.doesNotThrow(() => parser2.end(true));

	const parser3 = createJsonParser(() => {}, {});
	parser3.write('"abc');
	assert.equal(parser3.end(true), 'abc');
});

test('end() 默认拒绝未完成的输入', () => {
	const parser = createJsonParser(() => {}, {});
	parser.write('{"a":1');
	assert.throws(() => parser.end(), /EOF/);
});

test('pos() 统计已写入的字符数', () => {
	const parser = createJsonParser(() => {}, {});
	parser.write('{"a":');
	assert.equal(parser.pos(), 5);
	parser.write('1}');
	assert.equal(parser.pos(), 7);
});

test('原型安全：__proto__ 成为自有属性', () => {
	const value = parseJson5('{"__proto__":{"polluted":1}}');
	assert.equal({}.polluted, undefined);
	assert.equal(Object.hasOwn(value, '__proto__'), true);
	assert.equal(Object.getPrototypeOf(value), Object.getPrototypeOf(parseJson5('{}')));
	assert.equal(value.constructor, undefined, '解析结果的原型链上不应有 Object.prototype');
});

test('非法输入报错并带定位信息', () => {
	for (const source of ['{a 1}', '[1 2]', '{,}', 'tru', '{"a":}', '[1,', '{} x']) {
		assert.throws(() => parseJson5(source), err => {
			const text = String(err);
			assert.match(text, /expecting|EOF/, `${source} 的错误信息应说明期望内容`);
			assert.match(text, /Line \d+/, `${source} 的错误信息应带行号`);
			assert.match(text, /Offset: \d+/, `${source} 的错误信息应带偏移量`);
			return true;
		});
	}
});

test('YAML：换行终止裸值', () => {
	jsonEqual(parseJson5('{key: value\n}', {yaml: true, json5: true}), {key: 'value'});
	jsonEqual(parseJson5('[a\n, b]', {yaml: true, json5: true}), ['a', 'b']);
});

test('unescape 纯解转义', () => {
	const parser = createJsonParser(() => {}, {unescape: true});
	parser.write('a\\nb\\u0041');
	assert.equal(parser.end(true), 'a\nbA');
});

// ── 已知 bug ───────────────────────────────────────────────────────────────
test('YAML：根裸值应在 EOF 时返回', {todo: "现在Aint用不到这个"}, () => {
	assert.equal(parseJson5('hello', {yaml: true}), 'hello');
	assert.equal(parseJson5('hello\n', {yaml: true}), 'hello');
});

test('parseJson5 的错误应该是 Error 实例', {todo: "还没决定"}, () => {
	let thrown;
	try {
		parseJson5('{a 1}');
	} catch (e) {
		thrown = e;
	}
	assert.ok(thrown instanceof Error);
	assert.equal(typeof thrown.message, 'string');
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseArgs, ParseArgsError} from '../index.js';

/**
 * values 是 null 原型对象（防 __proto__ 污染），deepStrictEqual 会因此不相等，
 * 所以统一展开成普通对象再比较。
 */
const run = (args, options) => {
	const {values, positionals} = parseArgs({args, options});
	return {values: {...values}, positionals};
};

/** 断言抛 ParseArgsError，并包含 message 片段 */
const throwsParse = (fn, fragment) => {
	assert.throws(fn, (err) => {
		assert.ok(err instanceof ParseArgsError, `期望 ParseArgsError，实际 ${err.name}`);
		assert.ok(err.message.includes(fragment), `期望消息包含 ${fragment}，实际 ${err.message}`);
		return true;
	});
};

const throwsType = (fn, fragment) => {
	assert.throws(fn, (err) => {
		assert.ok(err instanceof TypeError && !(err instanceof ParseArgsError), `期望 TypeError，实际 ${err.name}`);
		assert.ok(err.message.includes(fragment), `期望消息包含 ${fragment}，实际 ${err.message}`);
		return true;
	});
};

/** 抓取抛出的错误，用于检查 name / instanceof */
const capture = (fn) => {
	try {
		fn();
	} catch (err) {
		return err;
	}
	assert.fail('期望抛出错误，但没有');
};

// ---------------------------------------------------------------- 布尔选项

test('布尔长选项：不带值即为 true', () => {
	// 回归：以前 eq === -1 时用了 body.slice(eq + 1)，把整个选项名当成了值，
	// 于是任何 `--flag` 都会抛 "只接受布尔值"
	assert.deepEqual(run(['--verbose'], {verbose: 'boolean'}), {values: {verbose: true}, positionals: []});
});

test('布尔长选项：接受内联值', () => {
	const options = {verbose: 'boolean'};
	for (const [raw, expected] of [
		['true', true], ['TRUE', true], ['yes', true], ['Yes', true],
		['false', false], ['FALSE', false], ['no', false], ['NO', false],
	]) {
		assert.equal(run([`--verbose=${raw}`], options).values.verbose, expected, `--verbose=${raw}`);
	}
});

test('布尔值必须整体匹配，不能用子串', () => {
	// 回归：/yes|true/ 会把 untrue 认成 true，/no|false/ 会把 nonsense 认成 false
	const options = {verbose: 'boolean'};
	for (const raw of ['untrue', 'nonsense', 'nottrue', 'falsehood', 'yess', '1', '0', 'on', '']) {
		throwsParse(() => parseArgs({args: [`--verbose=${raw}`], options}), '只接受布尔值');
	}
});

test('--no- 反转布尔选项', () => {
	// 回归：以前 --no-foo 会把 body 当成值，然后报 "不接受值"
	assert.equal(run(['--no-verbose'], {verbose: 'boolean'}).values.verbose, false);
	// 默认值应被覆盖
	assert.equal(run(['--no-verbose'], {verbose: {type: 'boolean', default: true}}).values.verbose, false);
	// 反转不接受值
	throwsParse(() => parseArgs({args: ['--no-verbose=1'], options: {verbose: 'boolean'}}), '不接受值');
	throwsParse(() => parseArgs({args: ['--no-verbose='], options: {verbose: 'boolean'}}), '不接受值');
});

test('--no- 只能反转布尔选项', () => {
	throwsParse(() => parseArgs({args: ['--no-out'], options: {out: 'string'}}), "未知选项 '--no-out'");
});

test('显式定义了 no-xxx 的选项走普通解析', () => {
	assert.deepEqual(
		run(['--no-verify'], {'no-verify': 'boolean', verify: 'boolean'}),
		{values: {'no-verify': true}, positionals: []},
	);
});

test('布尔短选项', () => {
	const options = {verbose: {type: 'boolean', short: 'v'}};
	assert.equal(run(['-v'], options).values.verbose, true);
	assert.equal(run(['-v=yes'], options).values.verbose, true);
	assert.equal(run(['-v=false'], options).values.verbose, false);
	throwsParse(() => parseArgs({args: ['-v=x'], options}), '只接受布尔值');
});

// ---------------------------------------------------------------- 字符串选项

test('字符串长选项：空格分隔、内联、以及显式空值', () => {
	const options = {out: 'string'};
	assert.deepEqual(run(['--out', 'a.txt'], options), {values: {out: 'a.txt'}, positionals: []});
	assert.deepEqual(run(['--out=a.txt'], options), {values: {out: 'a.txt'}, positionals: []});
	// 空串是「给了值」，不该报缺少值
	assert.deepEqual(run(['--out='], options), {values: {out: ''}, positionals: []});
	// 值里含有 '=' 时只按第一个 '=' 切
	assert.deepEqual(run(['--out=a=b'], options), {values: {out: 'a=b'}, positionals: []});
});

test('字符串短选项：空格分隔、贴值、= 形式', () => {
	const options = {out: {type: 'string', short: 'o'}};
	assert.deepEqual(run(['-o', 'a.txt'], options), {values: {out: 'a.txt'}, positionals: []});
	assert.deepEqual(run(['-oa.txt'], options), {values: {out: 'a.txt'}, positionals: []});
	assert.deepEqual(run(['-o=a.txt'], options), {values: {out: 'a.txt'}, positionals: []});
	assert.deepEqual(run(['-o='], options), {values: {out: ''}, positionals: []});
});

test('字符串选项缺少值时报错', () => {
	throwsParse(() => parseArgs({args: ['--out'], options: {out: 'string'}}), '缺少值');
	throwsParse(() => parseArgs({args: ['-o'], options: {out: {type: 'string', short: 'o'}}}), '缺少值');
});

test('字符串选项把后面以 - 开头的参数也当值（与 node:util 一致）', () => {
	assert.deepEqual(run(['--out', '-1'], {out: 'string'}), {values: {out: '-1'}, positionals: []});
	// 也就是说 --out 会把紧跟的选项整个吃掉，不会报错
	assert.deepEqual(run(['--out', '--verbose'], {out: 'string', verbose: 'boolean'}), {
		values: {out: '--verbose'},
		positionals: [],
	});
});

// ---------------------------------------------------------------- multiple / default

test('multiple 累积成数组', () => {
	const options = {tag: {type: 'string', multiple: true, short: 't'}};
	assert.deepEqual(run(['--tag=a', '-t', 'b', '--tag', 'c'], options), {
		values: {tag: ['a', 'b', 'c']},
		positionals: [],
	});
	// 没出现时是空数组
	assert.deepEqual(run([], options), {values: {tag: []}, positionals: []});
});

test('multiple + 布尔 + 反转', () => {
	assert.deepEqual(run(['--flag', '--no-flag'], {flag: {type: 'boolean', multiple: true}}), {
		values: {flag: [true, false]},
		positionals: [],
	});
});

test('default 在未提供时生效，且不会被后面的选项覆盖', () => {
	const options = {
		out: {type: 'string', default: 'a.out'},
		level: {type: 'string', default: 'info'},
	};
	assert.deepEqual(run(['--out', 'x'], options), {values: {out: 'x', level: 'info'}, positionals: []});
	assert.deepEqual(run([], options), {values: {out: 'a.out', level: 'info'}, positionals: []});
});

test('default 数组会被复制，不会在多次调用间串味', () => {
	const options = {tag: {type: 'string', multiple: true, default: ['base']}};
	const first = run([], options);
	first.values.tag.push('mutated');

	assert.deepEqual(run([], options).values, {tag: ['base']});
	// 提供值时不并入 default
	assert.deepEqual(run(['--tag=x'], options).values, {tag: ['x']});
});

test('未提供且没有 default 的选项不出现在 values 里', () => {
	const {values, positionals} = parseArgs({args: [], options: {verbose: 'boolean'}});
	assert.equal('verbose' in values, false);
	assert.deepEqual(Object.keys(values), []);
	assert.deepEqual(positionals, []);
});

// ---------------------------------------------------------------- 位置参数

test('位置参数与选项可以混排', () => {
	assert.deepEqual(run(['a', '-v', 'b', 'c'], {verbose: {type: 'boolean', short: 'v'}}), {
		values: {verbose: true},
		positionals: ['a', 'b', 'c'],
	});
});

test('-- 之后全部当位置参数', () => {
	assert.deepEqual(run(['a', '--', '--verbose', '-v', '--', 'b'], {verbose: 'boolean'}), {
		values: {},
		positionals: ['a', '--verbose', '-v', '--', 'b'],
	});
});

test('只有 -- 时不产生位置参数', () => {
	assert.deepEqual(run(['--'], {}), {values: {}, positionals: []});
});

test('单独的 - 是位置参数', () => {
	assert.deepEqual(run(['-', '--verbose'], {verbose: 'boolean'}), {
		values: {verbose: true},
		positionals: ['-'],
	});
});

test('空字符串是位置参数', () => {
	assert.deepEqual(run([''], {}).positionals, ['']);
});

// ---------------------------------------------------------------- 错误

test('未知选项', () => {
	throwsParse(() => parseArgs({args: ['--nope'], options: {}}), "未知选项 '--nope'");
	throwsParse(() => parseArgs({args: ['--nope=1'], options: {}}), "未知选项 '--nope'");
	throwsParse(() => parseArgs({args: ['--no-nope'], options: {}}), "未知选项 '--no-nope'");
	throwsParse(() => parseArgs({args: ['-z'], options: {}}), "未知选项 '-z'");
});

test('省略 type 时默认 boolean', () => {
	assert.deepEqual(run(['--a'], {a: {}}), {values: {a: true}, positionals: []});
});

test('不传参数不炸', () => {
	assert.deepEqual({...parseArgs().values}, {});
	assert.deepEqual(parseArgs({args: ['x']}).positionals, ['x']);
});

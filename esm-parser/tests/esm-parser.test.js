import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {ESMParseError, parseModule, replaceModule} from '../index.js';

//region 公共工具

/**
 * 校验基本不变量：raw 就是那段原文、没有首尾空白、节点不交叉。
 * @param {string} code
 */
function check(code) {
	const nodes = parseModule(code);
	for (const node of nodes) {
		node.raw = code.slice(node.start, node.end);
		assert.match(node.raw, /^(?:import|export)/, `raw 必须以关键字开头：${node.raw}`);
		assert.equal(node.raw, node.raw.trim(), `raw 不应有首尾空白：${JSON.stringify(node.raw)}`);
		assert.ok(node.start >= 0 && node.end > node.start && node.end <= code.length);
		if (node.statementEnd !== undefined) assert.ok(node.statementEnd >= node.end, 'statementEnd 不能早于 end');
	}
	for (let i = 1; i < nodes.length; i++) {
		// 可替换区间（[start, end)）不能交叉；statementEnd 只是辅助，覆盖范围允许嵌套
		assert.ok(nodes[i - 1].end <= nodes[i].start, '节点的可替换区间不能交叉');
	}
	return nodes;
}

/** 节点覆盖到的整段原文（export 只盖前缀，语句结束在 statementEnd） */
const span = (node, code) => code.slice(node.start, node.statementEnd ?? node.end);

/**
 * 把节点拍平成「跟坐标无关」的视图：只留类型、覆盖的原文、语义字段。
 * 这样期望值可以写成字面量，不用手算偏移。
 * @param {{start:number, statementEnd?:number, end:number}[]} nodes
 * @param {string} code
 */
function shape(nodes, code) {
	return nodes.map(node => {
		const out = {type: node.type, text: span(node, code)};
		if (node.type === 'import') {
			if (node.default !== undefined) out.default = node.default;
			if (node.namespace !== undefined) out.namespace = node.namespace;
			if (node.specifiers !== undefined) out.specifiers = node.specifiers;
			out.source = node.source;
			if (node.attribute !== undefined) out.attribute = node.attribute;
		} else if (node.type === 'export') {
			out.default = node.default;
			out.names = node.names;
			if (node.declaration !== undefined) out.declaration = node.declaration;
			if (node.specifiers !== undefined) out.specifiers = node.specifiers;
			if (node.source !== undefined) out.source = node.source;
			if (node.namespace !== undefined) out.namespace = node.namespace;
			if (node.attribute !== undefined) out.attribute = node.attribute;
			if (node.destruct) out.destruct = true;
			if (node.uncertain) out.uncertain = true;
		} else if (node.type === 'importDynamic') {
			out.source = node.source;
		}
		return out;
	});
}

/** 断言「这段源码 ⇒ 这些节点」，顺带跑一遍 check() 的不变量 */
const same = (code, expected) => {
	assert.deepEqual(shape(check(code), code), expected);
	return code;
};
//endregion

//region 1. 标准合法语法
test('标准 import / export / import() / import.meta：一条不漏、字段正确', () => {
	const one = (code, expected) => same(code, [expected]);

	// ---- import 声明的四种形状 ----
	one(`import 'x'`, {type: 'import', text: `import 'x'`, source: 'x'});
	one(`import a from 'x'`, {type: 'import', text: `import a from 'x'`, default: 'a', source: 'x'});
	one(`import * as ns from 'x'`, {type: 'import', text: `import * as ns from 'x'`, namespace: 'ns', source: 'x'});
	one(`import {a, b as c} from 'x'`, {
		type: 'import', text: `import {a, b as c} from 'x'`,
		specifiers: [{name: 'a', alias: 'a'}, {name: 'b', alias: 'c'}],
		source: 'x',
	});
	one(`import a, {b} from 'x'`, {
		type: 'import', text: `import a, {b} from 'x'`,
		default: 'a', specifiers: [{name: 'b', alias: 'b'}], source: 'x',
	});
	one(`import a, * as ns from 'x'`, {type: 'import', text: `import a, * as ns from 'x'`, default: 'a', namespace: 'ns', source: 'x'});
	// 字符串形式的导入名（任意模块命名）
	one(`import {'weird-name' as ok} from 'x'`, {
		type: 'import', text: `import {'weird-name' as ok} from 'x'`,
		specifiers: [{name: 'weird-name', alias: 'ok'}], source: 'x',
	});
	one(`import {default as x} from 'x'`, {
		type: 'import', text: `import {default as x} from 'x'`,
		specifiers: [{name: 'default', alias: 'x'}], source: 'x',
	});
	one(`import {a,} from 'x'`, {type: 'import', text: `import {a,} from 'x'`, specifiers: [{name: 'a', alias: 'a'}], source: 'x'});
	// import attributes
	one(`import a from 'x' with {type: 'json'}`, {
		type: 'import', text: `import a from 'x' with {type: 'json'}`,
		default: 'a', source: 'x', attribute: {keyword: 'with', entries: {type: 'json'}},
	});
	// 老的 assert 关键字（已不是标准语法，但生态里还有，保留支持）
	one(`import t from './d.txt' assert {type: 'text'}`, {
		type: 'import', text: `import t from './d.txt' assert {type: 'text'}`,
		default: 't', source: './d.txt', attribute: {keyword: 'assert', entries: {type: 'text'}},
	});
	// 说明符里的转义要被解出来
	one(String.raw`import a from '\u0041'`, {type: 'import', text: String.raw`import a from '\u0041'`, default: 'a', source: 'A'});
	// 注释可以塞在任意位置
	one(`import/*c*/a from/* c */'x'`, {type: 'import', text: `import/*c*/a from/* c */'x'`, default: 'a', source: 'x'});
	// 跨行说明符表
	one(`import {\n\ta,\n\tb as c,\n} from 'x'`, {
		type: 'import', text: `import {\n\ta,\n\tb as c,\n} from 'x'`,
		specifiers: [{name: 'a', alias: 'a'}, {name: 'b', alias: 'c'}], source: 'x',
	});

	// ---- export 声明 ----
	one(`export const a = 1`, {type: 'export', text: `export const a = 1`, default: false, names: ['a'], declaration: 'const'});
	one(`export const a = 1, b = 2`, {type: 'export', text: `export const a = 1, b = 2`, default: false, names: ['a', 'b'], declaration: 'const'});
	one(`export let x = 1,\n\ty = 2`, {type: 'export', text: `export let x = 1,\n\ty = 2`, default: false, names: ['x', 'y'], declaration: 'let'});
	one(`export var a = 1`, {type: 'export', text: `export var a = 1`, default: false, names: ['a'], declaration: 'var'});
	one(`export function f() { return 1 }`, {type: 'export', text: `export function f() { return 1 }`, default: false, names: ['f'], declaration: 'function'});
	one(`export function* gen() {}`, {type: 'export', text: `export function* gen() {}`, default: false, names: ['gen'], declaration: 'function'});
	one(`export async function h() {}`, {type: 'export', text: `export async function h() {}`, default: false, names: ['h'], declaration: 'async'});
	one(`export class C {}`, {type: 'export', text: `export class C {}`, default: false, names: ['C'], declaration: 'class'});
	one(`export class C extends B {}`, {type: 'export', text: `export class C extends B {}`, default: false, names: ['C'], declaration: 'class'});
	// export default：表达式 / 匿名 / 具名
	one(`export default 42`, {type: 'export', text: `export default 42`, default: true, names: [], declaration: 'default'});
	one(`export default function () {}`, {type: 'export', text: `export default function () {}`, default: true, names: [], declaration: 'function'});
	one(`export default function named() {}`, {type: 'export', text: `export default function named() {}`, default: true, names: ['named'], declaration: 'function'});
	one(`export default class {}`, {type: 'export', text: `export default class {}`, default: true, names: [], declaration: 'class'});
	one(`export default class extends B {}`, {type: 'export', text: `export default class extends B {}`, default: true, names: [], declaration: 'class'});
	// export 列表 / re-export（前缀带声明，避免写出「导出未声明名字」的非法模块）
	same(`const a = 1, b = 2\nexport {a, b as c}`, [{
		type: 'export', text: `export {a, b as c}`, default: false, names: [],
		specifiers: [{name: 'a', alias: 'a'}, {name: 'b', alias: 'c'}],
	}]);
	same(`const a = 1\nexport {a as default}`, [{
		type: 'export', text: `export {a as default}`, default: false, names: [],
		specifiers: [{name: 'a', alias: 'default'}],
	}]);
	same(`const a = 1, b = 2\nexport default a + b`, [{
		type: 'export', text: `export default a + b`, default: true, names: [], declaration: 'default',
	}]);
	one(`export {a} from 'x'`, {
		type: 'export', text: `export {a} from 'x'`, default: false, names: [],
		specifiers: [{name: 'a', alias: 'a'}], source: 'x',
	});
	one(`export {default as Nav} from './nav.js'`, {
		type: 'export', text: `export {default as Nav} from './nav.js'`, default: false, names: [],
		specifiers: [{name: 'default', alias: 'Nav'}], source: './nav.js',
	});
	one(`export * from 'x'`, {type: 'export', text: `export * from 'x'`, default: false, names: [], source: 'x'});
	one(`export * as ns from 'x'`, {type: 'export', text: `export * as ns from 'x'`, default: false, names: [], source: 'x', namespace: 'ns'});
	one(`export * as 'ns-str' from 'x'`, {type: 'export', text: `export * as 'ns-str' from 'x'`, default: false, names: [], source: 'x', namespace: 'ns-str'});
	one(`export * from 'x' with {type: 'json'}`, {
		type: 'export', text: `export * from 'x' with {type: 'json'}`, default: false, names: [],
		source: 'x', attribute: {keyword: 'with', entries: {type: 'json'}},
	});

	// ---- 动态 import 与 import.meta ----
	one(`import('./x.js')`, {type: 'importDynamic', text: `import('./x.js')`, source: './x.js'});
	one(`const p = import('./x.js')`, {type: 'importDynamic', text: `import('./x.js')`, source: './x.js'});
	one(`import(specifier)`, {type: 'importDynamic', text: `import(specifier)`, source: null});
	one(`import(await specifier())`, {type: 'importDynamic', text: `import(await specifier())`, source: null});
	one(`import('./x.js', {with: {type: 'json'}})`, {
		type: 'importDynamic', text: `import('./x.js', {with: {type: 'json'}})`, source: './x.js',
	});
	// 嵌套：内层先入队（文档没承诺顺序）。区间是嵌套的，不能跑 check() 的「不交叉」不变量
	assert.deepEqual(shape(parseModule(`import(import('./a'))`), `import(import('./a'))`), [
		{type: 'importDynamic', text: `import('./a')`, source: './a'},
		{type: 'importDynamic', text: `import(import('./a'))`, source: null},
	]);
	// 模板插值里是代码，必须扫
	one('`x${(await import(\'z\')).abc}y`', {type: 'importDynamic', text: `import('z')`, source: 'z'});
	one(`import.meta`, {type: 'importMeta', text: `import.meta`});
	one(`import.meta.url`, {type: 'importMeta', text: `import.meta`});
	one(`import.meta.resolve('x')`, {type: 'importMeta', text: `import.meta`});
	one('`${import.meta.resolve`x`}`', {type: 'importMeta', text: `import.meta`});

	// ---- 混排：无分号、有分号、CRLF、hashbang ----
	const mixed = `#! /usr/bin/env node\r\nimport a from 'x'\r\nimport b from 'y';\r\nexport {a, b}\r\n`;
	same(mixed, [
		{type: 'import', text: `import a from 'x'`, default: 'a', source: 'x'},
		{type: 'import', text: `import b from 'y';`, default: 'b', source: 'y'},
		{type: 'export', text: `export {a, b}`, default: false, names: [], specifiers: [{name: 'a', alias: 'a'}, {name: 'b', alias: 'b'}]},
	]);

	// ---- ASI：该断的地方断、该续的地方续 ----
	// 相邻 import 语句（无分号）
	same(`import a from 'x'\nimport b from 'y'`, [
		{type: 'import', text: `import a from 'x'`, default: 'a', source: 'x'},
		{type: 'import', text: `import b from 'y'`, default: 'b', source: 'y'},
	]);
	// 行注释 / 块注释不能吃掉换行
	same(`export const a = 1 // c\nnext()`, [
		{type: 'export', text: `export const a = 1`, default: false, names: ['a'], declaration: 'const'},
	]);
	same(`export const a = 1 /* \n */ + 2\nnext()`, [
		{type: 'export', text: `export const a = 1 /* \n */ + 2`, default: false, names: ['a'], declaration: 'const'},
	]);
	// 表达式在换行处继续（`+` / `.` / `(` / `? :` / `,`）
	same(`export const a = 1 +\n\t2\nnext()`, [
		{type: 'export', text: `export const a = 1 +\n\t2`, default: false, names: ['a'], declaration: 'const'},
	]);
	same(`export default a\n\t.b()\nnext()`, [
		{type: 'export', text: `export default a\n\t.b()`, default: true, names: [], declaration: 'default'},
	]);
	same(`export default fn\n(1)\nnext()`, [
		{type: 'export', text: `export default fn\n(1)`, default: true, names: [], declaration: 'default'},
	]);
	same(`export default cond\n\t? x\n\t: y\nnext()`, [
		{type: 'export', text: `export default cond\n\t? x\n\t: y`, default: true, names: [], declaration: 'default'},
	]);
	same(`export const a = 1,\n\tb = 2\nnext()`, [
		{type: 'export', text: `export const a = 1,\n\tb = 2`, default: false, names: ['a', 'b'], declaration: 'const'},
	]);
	// 模板原文里的换行不是语句换行
	same('export const s = `a\nb`\nnext()', [
		{type: 'export', text: 'export const s = `a\nb`', default: false, names: ['s'], declaration: 'const'},
	]);
	// 大括号写在下一行（Allman）
	same(`export function f(a, b)\n{\n\treturn a + b\n}`, [
		{type: 'export', text: `export function f(a, b)\n{\n\treturn a + b\n}`, default: false, names: ['f'], declaration: 'function'},
	]);
});
//endregion

//region 2. 不是语句的写法
test('不是语句的写法一律不报', () => {
	const cases = [
		// 字面量里的关键字
		`const s = 'import a from 1'`,
		'const t = `export const a = 1`',
		'const t2 = `a${`export default 1`}b`',
		`const re = /export const a = 1/g`,
		'const re2 = /[\'"`{}]/g',
		`x = y /* import a from 'x' */`,
		`// import a from 'x'\n/* export const a = 1 */\nconst a = 1`,
		// 属性名 / 方法名 / 私有名
		`a.import.b`,
		`a?.import.b`,
		`a.export`,
		`a?.export`,
		`o['import']`,
		`o.import('x')`,
		`o?.import('x')`,
		`o?.export(1)`,
		`const o = {import: 1, export: 2}`,
		`const o2 = {import() {}, export() {}}`,
		`class A { import() {} export() {} }`,
		`class B { #import(x) {} }`,
		// 标识符的一部分
		`$import = 1`,
		`import$ = 1`,
		`obj.$import(1)`,
		// 除号 / 数字
		`let x = 10 / 2 / 5`,
		'const t = 1..toString()',
		'x = 1..import * o',
		//'x = 1...import(o)',
		// 空 / BOM
		``,
		`\uFEFF"use strict"`,
	];
	for (const code of cases) {
		assert.deepEqual(shape(check(code), code), [], `不应识别出节点：${JSON.stringify(code)}`);
	}

	// 混合例子：方法名叫 import / 属性名叫 import，只有真正的 import() 该报
	const tricky = `
class
asd
extends
import('abc')
{
	constructor() {
		this.#import(this.import([...import('asd')]))
		this.opt = {import(a = 3) {}}
	}
}`;
	assert.deepEqual(shape(check(tricky), tricky), [
		{type: 'importDynamic', text: `import('abc')`, source: 'abc'},
		{type: 'importDynamic', text: `import('asd')`, source: 'asd'},
	]);
});
//endregion

//region 3. uncertain
test('不确定的地方要打标记：uncertain', () => {
	// ---- uncertain：class 的 heritage 以 `}` 结尾，statementEnd 只敢停在 heritage 上 ----
	const heritage = `export class C extends class {} {\n\tm() {}\n}`;
	const [node] = check(heritage);
	assert.equal(node.uncertain, 'e', '边界是猜的就要标出来');
	assert.equal(heritage.slice(node.start, node.statementEnd), 'export class C extends class {}');
	assert.equal(heritage.slice(node.start, node.end), 'export');
	assert.equal(heritage.slice(node.statementEnd), ' {\n\tm() {}\n}', '剩下的类体在 statementEnd 之后');

	// 只是边界不确定，识别一条不少
	const nested = `export class A extends class B extends import('x') {} {\n\tm() {}\n}\nimport last from 'L'`;
	assert.deepEqual(shape(check(nested), nested), [
		{type: 'export', text: `export class A extends class B extends import('x') {}`, default: false, names: ['A'], declaration: 'class', uncertain: true},
		{type: 'importDynamic', text: `import('x')`, source: 'x'},
		{type: 'import', text: `import last from 'L'`, default: 'last', source: 'L'},
	]);

	// 边界确定的不该带标记
	for (const code of [
		`export class D {}`,
		`export class C extends B { m() {} }`,
		`export default class extends (class {}) { m() {} }`,
	]) {
		assert.equal(check(code)[0].uncertain, undefined, `不该标 uncertain：${code}`);
	}

	// ---- destruct：声明列表里有解构，names 就不可信 ----
	for (const code of [
		`export const [a] = arr`,
		`export let {a, b: c} = obj`,
		`export var [a, ...rest] = arr`,
		`export const {a = 1} = o`,
		`export const {a, b} = o`,
	]) {
		const [decl] = check(code);
		assert.equal(decl.uncertain, 'd', `应当标 uncertain：${code}`);
		assert.deepEqual(decl.names, [], `解构时 names 为空：${code}`);
	}

	// 普通声明（哪怕右边是对象字面量）不标 destruct，names 是全的
	const plain = check(`export const a = 1, b = {x: 2}`);
	assert.equal(plain[0].destruct, undefined, '右边是对象字面量不算解构');
	assert.deepEqual(plain[0].names, ['a', 'b']);
});
//endregion

test('端到端测试：把 ESM 降级成 CJS', async () => {
	/**
	 * 只用 parseModule 给出的区间，把 ESM 改写成 CJS。
	 * 覆盖：import 四种形状 / import.meta / import() / export 声明 / export default / export 列表 / re-export。
	 */
	function toCjs(code) {
		const edits = [];
		for (const node of check(code)) {
			const between = (replacement) => edits.push({start: node.start, end: node.statementEnd ?? node.end, replacement});

			if (node.type === 'import') {
				const tmp = `__m${node.start}`;
				const binds = [];
				if (node.default) binds.push(`${node.default} = ${tmp}.default`);
				if (node.namespace) binds.push(`${node.namespace} = ${tmp}`);
				for (const {name, alias} of node.specifiers ?? []) binds.push(`${alias} = ${tmp}[${JSON.stringify(name)}]`);
				const mod = `require(${JSON.stringify(node.source)})`;
				edits.push({
					start: node.start, end: node.end,
					// 一个 import 只 require 一次
					replacement: binds.length ? `const ${tmp} = ${mod}; const ${binds.join(', ')};` : `${mod};`,
				});
				continue;
			}

			if (node.type === 'importDynamic') {
				// 动态 import 是懒的：包成 thunk
				const arg = node.source === null ? 'spec' : JSON.stringify(node.source);
				edits.push({start: node.start, end: node.end, replacement: `() => Promise.resolve(require(${arg}))`});
				continue;
			}

			if (node.type === 'importMeta') {
				edits.push({start: node.start, end: node.end, replacement: `__meta`});
				continue;
			}

			// export
			if (node.declaration === 'default') {
				edits.push({start: node.start, end: node.end, replacement: `__exports.default =`});
			} else if (node.declaration) {
				edits.push({start: node.start, end: node.end, replacement: ''});
				const names = node.names.length ? node.names : ['default'];
				edits.push({
					start: node.statementEnd,
					end: node.statementEnd,
					replacement: '; ' + names.map(name => `__exports[${JSON.stringify(name)}] = ${name};`).join(' '),
				});
			} else if (node.source !== undefined && node.specifiers) {
				between(node.specifiers.map(({name, alias}) => `__exports[${JSON.stringify(alias)}] = require(${JSON.stringify(node.source)})[${JSON.stringify(name)}];`).join(' '));
			} else if (node.source !== undefined && node.namespace !== undefined) {
				between(`__exports[${JSON.stringify(node.namespace)}] = require(${JSON.stringify(node.source)});`);
			} else if (node.source !== undefined) {
				between(`Object.assign(__exports, require(${JSON.stringify(node.source)}));`);
			} else {
				between(node.specifiers.map(({name, alias}) => `__exports[${JSON.stringify(alias)}] = ${name};`).join(' '));
			}
		}

		const out = replaceModule(code, edits);
		assert.doesNotThrow(() => new Function('require', '__exports', '__meta', out), '降级后必须是合法脚本');
		assert.ok(!/^\s*(?:import|export)\b/m.test(out), `不该残留 import/export 语句：\n${out}`);
		return out;
	}

	const source = `import def, {named as alias} from 'dep'
import * as ns from 'dep2'
import 'side-effect'
export const answer = def + alias
export function twice(n) { return n * 2 }
export class Box { constructor(v) { this.v = v } }
export default answer * 2
export {answer as total}
export {other as renamed} from 'dep3'
export * from 'dep4'
export * as everything from 'dep5'
export const metaUrl = import.meta.url
export const lazy = import('dep6')
`;

	const required = [];
	const registry = {
		dep: {default: 1, named: 2},
		dep2: {x: 9},
		'side-effect': {default: 'side'},
		'dep3': {other: 7},
		'dep4': {four: 4},
		'dep5': {five: 5},
		'dep6': {six: 6},
	};
	const require = id => {
		required.push(id);
		assert.ok(id in registry, `不该 require：${id}`);
		return registry[id];
	};

	const cjs = toCjs(source);
	const exports_ = {};
	new Function('require', '__exports', '__meta', cjs)(require, exports_, {url: 'file:///mod.js'});

	assert.deepEqual(required.sort(), ['dep', 'dep2', 'dep3', 'dep4', 'dep5', 'side-effect'].sort(), '按需 require，一次一条');
	assert.equal(exports_.answer, 3, 'default + named');
	assert.equal(exports_.twice(4), 8);
	assert.equal(new exports_.Box(5).v, 5);
	assert.equal(exports_.default, 6);
	assert.equal(exports_.total, 3);
	assert.equal(exports_.renamed, 7);
	assert.equal(exports_.four, 4);
	assert.deepEqual(exports_.everything, {five: 5});
	assert.equal(exports_.metaUrl, 'file:///mod.js');
	assert.ok(!required.includes('dep6'), 'import() 是懒的，执行到才 require');
	assert.deepEqual(await exports_.lazy(), {six: 6});
	assert.ok(required.includes('dep6'), '调用之后才 require');

	// 真实文件：拿掉 import/export 前缀后必须还是合法脚本
	for (const file of ['index.js']) {
		const code = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
		const nodes = check(code).filter(node => node.type === 'import' || node.type === 'export');
		assert.ok(nodes.length > 0, `${file} 应该至少有一条声明`);
		const rest = replaceModule(code, nodes.map(node => ({start: node.start, end: node.end, replacement: ''})));
		assert.equal(rest.length, code.length - nodes.reduce((n, node) => n + node.raw.length, 0));
		assert.doesNotThrow(() => new Function(rest), `${file}: 去掉前缀后应该仍是合法脚本`);
		assert.ok(rest.includes('class ESMParseError extends SyntaxError'), '声明体必须被保留');
	}

	// 规模：两千条声明也要线性扫过去
	const big = Array.from({length: 2000}, (_, i) => `import a${i} from 'm${i}'\nexport const v${i} = ${i}`).join('\n');
	const started = performance.now();
	const nodes = parseModule(big);
	const cost = performance.now() - started;
	assert.equal(nodes.length, 4000);
	assert.equal(nodes.filter(node => node.type === 'import').length, 2000);
	assert.equal(nodes.filter(node => node.type === 'export').length, 2000);
	assert.deepEqual(nodes.at(-1).names, ['v1999']);
	assert.ok(cost < 2000, `10 万字符花了 ${cost.toFixed(0)}ms`);
});

test('现有缺陷：这些行为是错的，但先钉在这里', () => {
	const mustThrow = [
		// 正则/除法判不清
		[`语句位置的正则`, `if (a) /'/.test(b)`],
		// 数字字面量的点让 `/` / 属性名判不清
		[`1. instanceof 正则`, `t(1. instanceof /"/)`],
		[`import("" / …)`, `import("" / /"/)`],
	];

	for (const [label, code] of mustThrow) {
		let caught;
		assert.throws(
			() => parseModule(code),
			error => {
				caught = error;
				return error instanceof ESMParseError;
			},
			`${label} 必须抛 ESMParseError：${JSON.stringify(code)}`,
		);
		assert.ok(Number.isInteger(caught.offset) && caught.offset >= 0, `${label} 要带 offset：${caught.offset}`);
		assert.ok(String(caught.message).includes('Line '), `${label} 的 message 里要有定位片段`);
	}

	// 1) 方法名叫 import，方法体换行写 → 被当成动态 import 报出来（多报）
	for (const code of [
		`const o = { import(x)\n{\n}\n}`,
		`class A { import(x)\n{\n}\n}`,
	]) {
		assert.deepEqual(shape(check(code), code), [
			{type: 'importDynamic', text: 'import(x)', source: null},
		], `多报：方法定义被当成 import()：${JSON.stringify(code)}`);
	}
	// 控制组：大括号写在同一行就认得对（当方法定义，不报）
	assert.deepEqual(shape(check(`const o = { import(x) {} }`), `const o = { import(x) {} }`), []);

	// 2) 非顶层的 import/export：只有「正在等 ASI 的 export」内部才会被拦下，其它位置直接多报
	assert.deepEqual(
		shape(check(`function f() { import a from 'x' }`), `function f() { import a from 'x' }`),
		[{type: 'import', text: `import a from 'x'`, default: 'a', source: 'x'}],
		'不过这是语法错误',
	);
	assert.deepEqual(
		shape(check(`{ export const a = 1 }`), `{ export const a = 1 }`),
		[{type: 'export', text: 'export const a = 1 }', default: false, names: ['a'], declaration: 'const'}],
		'这也是语法错误',
	);
	// 而在 export 声明体里（STOP_ASI 语境，depth 有效）就会抛
	assert.throws(() => parseModule(`export function g() { import c from 'z' }`), ESMParseError);

	// 3) 函数体后面的单独一个 `;`：statementEnd 把它算进语句（acorn 认为那是独立空语句）
	const semi = `export function f() {}\n;\nnext()`;
	assert.equal(span(check(semi)[0], semi), `export function f() {}\n;`, '掐在分号上，多算了一个字');

	// 4) 字符串里的 `\u{...}` 转义：抛的是 JSON 解析器的 Error，不是 ESMParseError
	assert.throws(() => parseModule(String.raw`import a from '\u{1F600}'`), error => {
		assert.notEqual(error.name, 'ESMParseError');
		assert.equal(error.offset, undefined, '没有 offset，定位信息就丢了');
		return true;
	});
});
//endregion
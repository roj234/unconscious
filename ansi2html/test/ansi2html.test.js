import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ansiToHtml} from '../ansiToHtml.js';

/**
 * 把 SGR 参数应用到 `text` 上再复位，方便断言单一样式的输出。
 * @param {string} params
 * @param {string} [text]
 */
const withSGR = (params, text = 'X') => ansiToHtml(`\x1b[${params}m${text}\x1b[0m`);

const PALETTE16 = [
	'#000000', '#ff5454', '#7ed321', '#ffd54f',
	'#5b9bd5', '#9b6ba3', '#42d4d4', '#e0e0e0',
	'#7f7f7f', '#ff7777', '#a5e85b', '#ffe066',
	'#7fbdf3', '#b388c4', '#6ee6e6', '#f5f5f5',
];

const link = (url, text = url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;

test('基础', () => {
	assert.equal(ansiToHtml('<a> & b'), '&lt;a> &amp; b');
	assert.equal(ansiToHtml(`"'`), `"'`);
	PALETTE16.slice(0, 8).forEach((color, i) => {
		assert.equal(withSGR(30 + i), `<span style="color:${color}">X</span>`);
	});
	assert.equal(withSGR('38;5;21'), '<span style="color:rgb(0,0,255)">X</span>');
	assert.equal(withSGR('38;2;1;2;3'), '<span style="color:rgb(1,2,3)">X</span>');
	assert.equal(withSGR('48;2;255;128;0'), '<span style="background-color:rgb(255,128,0)">X</span>');
	assert.equal(withSGR('1'), '<span style="font-weight:bold">X</span>');
	assert.equal(withSGR('2'), '<span style="opacity:0.6">X</span>');
	assert.equal(withSGR('3'), '<span style="font-style:italic">X</span>');
	assert.equal(withSGR('4'), '<span style="text-decoration:underline">X</span>');
	assert.equal(withSGR('9'), '<span style="text-decoration:line-through">X</span>');
	assert.equal(withSGR('1;2;3;4;9'), '<span style="font-weight:bold;opacity:0.6;font-style:italic;text-decoration:underline line-through">X</span>');
	assert.equal(ansiToHtml('\x1b[1;2mA\x1b[22mB'), '<span style="font-weight:bold;opacity:0.6">A</span>B');
	assert.equal(ansiToHtml('\x1b[3mA\x1b[23mB'), '<span style="font-style:italic">A</span>B');
	assert.equal(ansiToHtml('\x1b[4mA\x1b[24mB'), '<span style="text-decoration:underline">A</span>B');
	assert.equal(ansiToHtml('\x1b[9mA\x1b[29mB'), '<span style="text-decoration:line-through">A</span>B');
	assert.equal(ansiToHtml('a\x1b[31mb\x1b[0mc'), 'a<span style="color:#ff5454">b</span>c');
	assert.equal(ansiToHtml('\x1b[mX'), 'X');
	assert.equal(ansiToHtml('\x1b[0mX'), 'X');
	assert.equal(ansiToHtml('\x1b[31ma\x1b[32mb\x1b[0m'), '<span style="color:#ff5454">a</span><span style="color:#7ed321">b</span>');
	assert.equal(withSGR('31;31'), '<span style="color:#ff5454">X</span>');
	assert.equal(ansiToHtml('\x1b[1mhttp://a.com\x1b[22m'), `<span style="font-weight:bold">${link('http://a.com')}</span>`);
	assert.equal(ansiToHtml('http://a.com\x1b[31mX'), `${link('http://a.com')}<span style="color:#ff5454">X</span>`);
});

test('越界的 256 色索引回退到黑色', () => {
	assert.equal(withSGR('38;5;256'), '<span style="color:#000000">X</span>');
	assert.equal(withSGR('38;5;999'), '<span style="color:#000000">X</span>');
});

const BUG_BLINK = 'BUG: blink 被输出成 text-decoration:blink（非法值），带上它的整条 text-decoration 声明都会被浏览器丢弃';
const BUG_STRAY_ESC = 'BUG: 末尾孤立的 ESC 被原样写进 HTML（注释说会静默移除不完整序列）';

test('用CSS动画实现blink', {todo: BUG_BLINK}, () => {
	assert.equal(withSGR('4;5'), '<span style="text-decoration:underline;animation:blink 1.1s infinite step-start">X</span>');
});

test('只有结尾 SGR 时不输出内容', () => {
	assert.equal(ansiToHtml('\x1b[31m'), '');
});

test('未知 SGR 参数被忽略', () => {
	assert.equal(withSGR('99'), 'X');
	assert.equal(withSGR('1;99'), '<span style="font-weight:bold">X</span>');
});

test('非 SGR 序列被移除', () => {
	assert.equal(ansiToHtml('a\x1b[2Kb'), 'ab');
	assert.equal(ansiToHtml('a\x1b[?25lb'), 'ab');
	assert.equal(ansiToHtml('a\x1b[1;2Hb'), 'ab');
	assert.equal(ansiToHtml('a\x1bMb'), 'ab');
	assert.equal(ansiToHtml('a\x1b]0;title\x07b'), 'ab');
	assert.equal(ansiToHtml('a\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\b'), 'alinkb');
});

test('截断在 EOF 的 CSI 参数被丢弃', () => {
	assert.equal(ansiToHtml('a\x1b[31'), 'a');
	assert.equal(ansiToHtml('a\x1b[3'), 'a');
	// 结尾在分隔符上时，分隔符本身没有被序列覆盖（当前行为）
	assert.equal(ansiToHtml('a\x1b[38;5;'), 'a;');
});

test('孤立 ESC 不应原样进入 HTML', {todo: BUG_STRAY_ESC}, () => {
	assert.equal(ansiToHtml('a\x1b'), 'a');
});

test('链接：识别链接并转义', () => {
	assert.equal(ansiToHtml('see http://example.com now'), `see ${link('http://example.com')} now`);
	assert.equal(ansiToHtml('https://a.com/?a=1&b=<x>'), `<a href="https://a.com/?a=1&amp;b=" target="_blank" rel="noopener noreferrer">https://a.com/?a=1&amp;b=</a>&lt;x>`);
});

test('链接：移除结尾的标点', () => {
	assert.equal(ansiToHtml('go http://a.com/x.'), `go ${link('http://a.com/x')}.`);
	assert.equal(ansiToHtml('http://a.com, next'), `${link('http://a.com')}, next`);
	assert.equal(ansiToHtml('http://a.com/x!'), `${link('http://a.com/x')}!`);
	assert.equal(ansiToHtml(`http://a.com/x'`), `${link('http://a.com/x')}'`);
});

test('链接：保留成对的括号', () => {
	assert.equal(ansiToHtml('https://en.wikipedia.org/wiki/C_(lang)'), link('https://en.wikipedia.org/wiki/C_(lang)'));
	assert.equal(ansiToHtml('https://en.wikipedia.org/wiki/C_(lang))'), `${link('https://en.wikipedia.org/wiki/C_(lang)')})`);
	assert.equal(ansiToHtml('(http://a.com/x)'), `(${link('http://a.com/x')})`);
	assert.equal(ansiToHtml('http://a.com/x}'), `${link('http://a.com/x')}}`);
});

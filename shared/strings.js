import {immutableObjectMap} from "./objects.js";

const wideRe = /[\u1100-\u115F\u2329-\u232A\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;
const getStringWidth = (s) => { let w = 0; for (const ch of s) w += wideRe.test(ch) ? 2 : 1; return w; };
const digitCount = (n) => String(n).length;

/**
 * 根据字符串和其中的索引计算所在行 / 列，并返回带定位箭头的多行字符串。
 * @param {string} string
 * @param {number} index
 * @returns {string}
 */
export function locate(string, index) {
	if (!Number.isSafeInteger(index) || index < 0) throw new TypeError("locate: index 必须是非负整数");

	const len = string.length;
	const limit = index < len ? index : len;

	let line = 1;
	let lineStart = 0;
	let p = string.indexOf("\n");
	while (p !== -1 && p < limit) {
		line++;
		lineStart = p + 1;
		p = string.indexOf("\n", lineStart);
	}
	const column = index - lineStart;

	let lineEnd = string.indexOf("\n", lineStart);
	if (lineEnd === -1) lineEnd = len;
	const lineContent = string.substring(lineStart, lineEnd);

	let k = `Line ${line}: `;
	if (column < 0 || column > lineContent.length || lineContent.length > 220) {
		k += `Column: ${column}`;
	} else {
		k += lineContent + "\n";
		k += "-".repeat(7 + digitCount(line) + getStringWidth(lineContent.substring(0, column))) + "^";
	}
	k += `\nOffset: ${index}`;
	return k;
}

const map = /*#__PURE__*/ immutableObjectMap({
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
});

const reHtml = /[&<>"]/g;
const reText = /[&<]/g;
const reAttr = /[&"]/g;
const reLT = /\r\n?|[\u2028\u2029]/g;
const mapper = (str) => map[str];

export const escapeHtml = s => s.replace(reHtml, mapper);
export const escapeHtmlText = s => s.replace(reText, mapper);
export const escapeHtmlAttr = s => s.replaceAll('"', '\\"');//.replace(reAttr, mapper);
export const normalizeLineTerminator = s => s.replace(reLT, '\n');
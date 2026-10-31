
/**
 * 根据字符串和其中的索引计算所在行 / 列，并返回带定位箭头的多行字符串。
 * @param {string} string
 * @param {number} index
 * @returns {string}
 */
export function locate(string, index) {
	if (!Number.isSafeInteger(index) || index < 0) throw new TypeError("locate: index 必须是非负整数");

	// 1. 计算 line / lineStart / column
	let line = 1;
	let lineStart = 0;
	const limit = Math.min(index, string.length);
	for (let i = 0; i < limit; i++) {
		if (string.charCodeAt(i) === 10 /* \n */) {
			line++;
			lineStart = i + 1;
		}
	}
	const column = index - lineStart;

	// 2. 取出当前行内容
	let lineEnd = lineStart;
	while (lineEnd < string.length && string.charCodeAt(lineEnd) !== 10) {
		lineEnd++;
	}
	const lineContent = string.substring(lineStart, lineEnd);

	// 3. 终端显示宽度（CJK / 全角符号占 2 列）
	const wideRe =
		/[\u1100-\u115F\u2329-\u232A\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;
	const getStringWidth = (s) => {
		let w = 0;
		for (const ch of s) w += wideRe.test(ch) ? 2 : 1;
		return w;
	};
	const digitCount = (n) => String(n).length;

	let k = `Line ${line}: `;
	if (column < 0 || column > lineContent.length || lineContent.length > 220) {
		k += `Column: ${column}`;
	} else {
		k += lineContent + "\n";
		const off = 6 + digitCount(line) + getStringWidth(lineContent.substring(0, column));
		k += "-".repeat(off) + "^";
	}
	k += `\nOffset: ${index}`;
	return k;
}
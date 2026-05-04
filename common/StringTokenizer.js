/**
 * 将命令行字符串拆分为参数数组，支持转义字符和引号
 * @param {string} cmd 原始命令行字符串
 * @returns {string[]} 解析后的参数数组
 */
export function tokenize(cmd) {
	const args = [];
	let currentToken = "";
	let inQuotes = null; // 记录当前在哪个引号内: '"', "'", 或 null
	let escaped = false; // 记录当前字符是否被转义
	let hasContent = false; // 用于处理空字符串引号 ""

	for (let i = 0; i < cmd.length; i++) {
		const char = cmd[i];

		// 1. 处理转义状态
		if (escaped) {
			switch (char) {
				case 'b': currentToken += '\b'; break;
				case 'f': currentToken += '\f'; break;
				case 'n': currentToken += '\n'; break;
				case 'r': currentToken += '\r'; break;
				case 't': currentToken += '\t'; break;
				default:  currentToken += char; break;
			}
			escaped = false;
			hasContent = true;
			continue;
		}

		// 2. 遇到转义符号 \
		if (inQuotes && char === '\\') {
			escaped = true;
			continue;
		}

		// 3. 处理引号
		if (char === '"' || char === "'") {
			if (inQuotes === null) {
				// 进入引号
				inQuotes = char;
				hasContent = true; // 即使是 "" 也标记为有内容，以便推入数组
			} else if (inQuotes === char) {
				// 退出相同类型的引号
				inQuotes = null;
			} else {
				// 在双引号里遇到单引号，或者反之，作为普通字符
				currentToken += char;
			}
			continue;
		}

		// 4. 处理空格（分隔符）
		if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
			if (inQuotes === null) {
				// 不在引号内，遇到空格说明当前 token 结束
				if (currentToken.length > 0 || hasContent) {
					args.push(currentToken);
					currentToken = "";
					hasContent = false;
				}
			} else {
				// 在引号内，空格作为普通字符
				currentToken += char;
			}
			continue;
		}

		// 5. 普通字符
		currentToken += char;
		hasContent = true;
	}

	// 处理最后一个 token
	if (currentToken.length > 0 || hasContent) {
		args.push(currentToken);
	}

	return args;
}
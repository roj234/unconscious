// noinspection JSBitwiseOperatorUsage

import {locate} from "@roj234/shared/strings";
import {createJsonParser} from "@roj234/stream-json";
import {AS_IS} from "@roj234/shared";

export class ESMParseError extends SyntaxError {
	/**
	 * @param {string} message
	 * @param {string} code
	 * @param {number} offset
	 */
	constructor(message, code, offset) {
		super(`${message}\n`+locate(code, offset));
		this.name = 'ESMParseError';
		this.offset = offset;
	}
}

const STOP_TOP = /\/[/*]?|['"`]|\b(?:import|export)\b/g;
const STOP_ASI = /['"`;(){}\[\],\n]|\/[/*]?|\b(?:import|export)\b/g;
const TEMPLATE_STRING = /[`\\]|\$\{/g;
const WHITESPACES = /(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)+/y;
const IDENTIFIER = /[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*/uy;
const IDENTIFIER1 = /^[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*$/u;

const VAR = /^(?:var|let|const)$/;
const DECL = /^(?:async|function|class|var|let|const)$/;

const WORD = /[\p{L}\p{N}_]/u;
const SPACE = /\s/;

const WHITESPACE_ID = 1, CONTINUES_ID = 2, WORD_ID = 4, REGEXP_FLAGS_ID = 8;

const CHAR_TRAITS = new Uint8Array(128);
const fill = (chars, flag) => {
	for (let i = 0; i < chars.length; i++) {
		CHAR_TRAITS[chars.charCodeAt(i)] |= flag;
	}
};

fill("\t\n\v\f\r ", WHITESPACE_ID);
fill(".([`+-*/%&|^<>=?:,", CONTINUES_ID);
fill("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$", WORD_ID);
fill("iydsmgu", REGEXP_FLAGS_ID);


/**
 * @param {string} code
 * @param {number} at
 * @return {boolean}
 */
const isSpace = (code, at) => {
	const c = code.charCodeAt(at);
	return c > 0x7F ? SPACE.test(code[at]) : (CHAR_TRAITS[c] & WHITESPACE_ID);
}

/**
 * @param {string} code
 * @param {number} at
 * @return {boolean}
 */
const puncOrWord = (code, at) => {
	const c = code.charCodeAt(at);
	return c > 0x7F ? WORD.test(code[at]) : (CHAR_TRAITS[c] & WORD_ID);
};

// 正则处理

/** 后面必须接表达式的保留字：紧跟的 `/` 只能是正则。 */
const EXPR_AFTER = /^(?:return|typeof|instanceof|in|new|delete|void|throw|case|do|else|yield|await|extends)$/u;
/** `for (x of y)` 头里的 `of`：前面是操作数或右括号时才算关键字 */
const OF_AFTER = /[\p{ID_Continue}$)\]]$/u;
/** 能结束一个表达式的最后一个字符 */
const OPERAND_END = /(?:\+\+|--|[)\]}\p{ID_Continue}'"`$])$/u;
/**
 * 刚才扫到的词能不能结束表达式（决定紧跟的 `/` 是除号还是正则）。
 * @param {string} word
 * @param {string|undefined} before
 */
const endsOperand = (word, before) => {
	if (!word) return false;
	if (word === '.') return before >= '0' && before <= '9';
	if (word === 'of') return before === undefined || !OF_AFTER.test(before);
	if (EXPR_AFTER.test(word) && before !== '.') return false;
	return OPERAND_END.test(word);
};

const isLinebreak = ch => ch === 10 || ch === 13;

/**
 * 扫出整份源码里的 import / export 片段。
 * @param {string} code
 * @returns {object[]}
 */
export function parseModule(code) {
	const length = code.length;
	/** @type {object[]} */
	const nodes = [];
	/** @type {number[]} */
	const tpl = [];

	let i = 0;
	let depth = 0;

	let tail = ''; // 最近个有意义字符
	let tailBefore; // tail 前面那个非空白字符
	let tailLinebreak;
	let stopAt = STOP_TOP;

	let pendExport = null; // 语法没给出边界、正等ASI的 export 节点
	let pendForClassInherit = false;
	let pendForFunctionBody = false;
	let pendForVarDecl = false;
	let lastInterested = 0;

	const dynStack = [];

	const fail = (message, at = i) => {
		throw new ESMParseError(message, code, at);
	};

	/** 按当前上下文挑停靠点：模板原文 / 要数括号的代码 / 平时 */
	const updateStop = () => {
		stopAt = tpl.at(-1) === 0 ? TEMPLATE_STRING : pendExport || dynStack.length || tpl.length ? STOP_ASI : STOP_TOP;
	};

	//region Tokenizer
	const nextToken = from => {
		let p = from;
		let c;
		while (CHAR_TRAITS[c = code.charCodeAt(p)] & WHITESPACE_ID) p++;

		if (c === 47/* / */ || c > 0x7F) {
			WHITESPACES.lastIndex = p;
			return WHITESPACES.test(code) ? WHITESPACES.lastIndex : p;
		}
		return p;
	};

	const readIdentifier = () => {
		IDENTIFIER.lastIndex = i = nextToken(i);
		return IDENTIFIER.test(code) ? code.slice(i, i = IDENTIFIER.lastIndex) : null;
	};

	/**
	 * @param {number} quote
	 * @param {number} from
	 */
	const matchString = (quote, from) => {
		for (let p = from + 1; p < code.length; p++) {
			const ch = code.charCodeAt(p);
			if (ch === 92/* \ */) { p++; continue; }
			if (ch === quote) return p + 1;
			// 字符串里不允许换行
			if (isLinebreak(ch)) break;
		}
		return fail('未闭合的字符串字面量', from);
	}

	const readString = () => {
		const at = nextToken(i);
		const quote = code.charCodeAt(at);
		if (quote !== 39 && quote !== 34) return null;

		i = matchString(quote, at);
		const part = code.slice(at + 1, i - 1);
		if (part.includes('\\')) {
			const parser = createJsonParser(AS_IS, { json5: true, unescape: true });
			parser.write(part);
			return parser.end(true);
		} else {
			return part;
		}
	};

	const readPunctuation = char => {
		const at = nextToken(i);
		if (code[at] !== char) return false;
		i = at + 1;
		return true;
	};

	const readStringRequired = () => readString() ?? fail('期望字符串');
	const readIdentifierRequired = () => readIdentifier() ?? fail('期望标识符');

	/** `from '…'` → 模块说明符 */
	const from = () => {
		if (readIdentifier() !== 'from') fail('期望 from');
		return readStringRequired();
	};

	/** `as ns` → ns */
	const ns = () => {
		if (readIdentifier() !== 'as') fail('期望 as');
		return readIdentifierRequired();
	};

	/** 语句语法上已经结束：吃掉紧跟的 `;`，返回结束位置 */
	const endStmt = () => {
		const at = nextToken(i);
		if (code[at] === ';') i = at + 1;
		return i;
	};

	const endNode = (node, end) => {
		node.end = end;
		return node;
	};

	/**
	 * @param {boolean} exp
	 * @return {{name:string, alias:string}[]}
	 */
	const specs = (exp) => {
		const specifiers = [];
		while (!readPunctuation('}')) {
			const get = () => readIdentifier() ?? readString() ?? fail('期望字符串或标识符');
			const name = get();
			let alias = name;

			const w = readIdentifier();
			if (w === 'as') alias = exp ? get() : readIdentifierRequired();
			else if (w) fail("期望 as");

			specifiers.push({name, alias});
			readPunctuation(',');
		}
		return specifiers;
	};

	/** with { type: 'json' } */
	const attrs = node => {
		const save = i;
		const keyword = readIdentifier();
		if ((keyword !== 'with' && keyword !== 'assert') || !readPunctuation('{')) {
			i = save;
			return;
		}

		const entries = {};
		while (!readPunctuation('}')) {
			const key = readIdentifier() ?? readString() ?? fail('未闭合的 import attributes');
			if (!readPunctuation(':')) fail('期望 :');
			entries[key] = readStringRequired();
			readPunctuation(',');
		}
		node.attribute = {keyword, entries};
	};
	//endregion

	/**
	 * @param {number} start
	 */
	function parseImport(start) {
		const node = { type: 'import', start };
		let w;

		if (readPunctuation('*')) { // import * as ns from 'x'
			node.namespace = ns();
			node.source = from();
		} else if (readPunctuation('{')) { // import {a as b} from 'x'
			node.specifiers = specs();
			node.source = from();
		} else if ((w = readString()) !== null) { // import 'x'
			node.source = w;
		} else if ((w = readIdentifier()) !== null) { // import a [, * as ns | { … }] from 'x'
			node.default = w;
			if (readPunctuation(',')) {
				if (readPunctuation('*')) node.namespace = ns();
				else if (readPunctuation('{')) node.specifiers = specs();
				else fail('期望 * 或 {');
			}
			node.source = from();
		} else {
			return;
		}

		attrs(node);
		return endNode(node, endStmt());
	}

	/**
	 * @param {number} start
	 */
	function parseExport(start) {
		const node = {
			type: 'export', start,
			default: false,
			names: []
		};
		let prefixEnd = start + 6;

		if (readPunctuation('*')) {
			let keyword = readIdentifier();
			if (keyword === 'as') {
				node.namespace = readIdentifier() ?? readString() ?? fail("期望标识符或字符串");
				keyword = readIdentifier();
			}
			if (keyword !== 'from') fail('期望 from');
			node.source = readStringRequired();
			attrs(node);
			return endNode(node, node.statementEnd = endStmt());
		}

		if (readPunctuation('{')) {
			node.specifiers = specs(true);
			const save = i;
			if (readIdentifier() === 'from') {
				node.source = readStringRequired();
				attrs(node);
			} else {
				i = save;
			}
			return endNode(node, node.statementEnd = endStmt());
		}

		let kind = readIdentifier();
		if (kind === null) return null; // { export: 1 }：属性名，不是语句

		let foundFunction = false;
		if (kind === 'default') {
			node.default = true;
			prefixEnd = i; // 前缀=export default
			kind = readIdentifier();
			// 规范要求 async 和 function 之间不能有换行。但有换行是语法错误。所以我不管，坏的变好了也不错？
			if (kind === 'async' && (foundFunction = true, readIdentifier()) !== 'function') kind = null;
			if (kind !== 'function' && kind !== 'class' && kind !== 'async') {
				i = prefixEnd; // 任意表达式：边界靠 ASI
				node.declaration = 'default';
				return endNode(node, i);
			}
		} else if (!DECL.test(kind)) {
			i = prefixEnd;
			return;
		}

		node.declaration = kind;
		endNode(node, prefixEnd);

		if (VAR.test(kind)) return node; // 声明列表：边界靠 ASI

		// 数括号
		if (kind === 'async' && !foundFunction) readIdentifier();
		readPunctuation('*');
		const name = readIdentifier();
		if (name === 'extends') pendForClassInherit = true;
		else if (name !== null) node.names.push(name);
		return node;
	}

	const finishStmt = end => {
		pendExport.statementEnd = end;
		pendExport = null;
		depth = 0;
		pendForVarDecl = pendForFunctionBody = false;
		pendForClassInherit = false;
		i = end;
		tail = ';'; // 语句结束
		updateStop();
	};

	if (code.startsWith('#!')) {
		const hashbangEnd = code.indexOf('\n');
		i = hashbangEnd < 0 ? length : hashbangEnd;
	}

	//region 主循环
	while (i < length) {
		stopAt.lastIndex = i;
		const match = stopAt.exec(code);
		const at = match === null ? length : match.index;

		tailLinebreak = 0;

		let gapEnd = at;
		while (gapEnd > i && isSpace(code, gapEnd - 1)) {
			gapEnd--;
			tailLinebreak |= isLinebreak(code.charCodeAt(gapEnd));
		}

		if (gapEnd > i) {
			tail = '';
			tailBefore = undefined;

			let end = gapEnd-1;
			while (end >= i) {
				if (isSpace(code, end)) end--;
				else {
					const kind = puncOrWord(code, end);
					let start = end;
					for (; start >= i; start--) {
						if (isSpace(code, start) || puncOrWord(code, start) !== kind) break;
					}

					tail = code.slice(start+1, end+1);
					tailBefore = code[start];

					const last = code.charCodeAt(end);
					if (last >= 97 && last <= 122 && (tail === 'of' || EXPR_AFTER.test(tail))) {
						while (start >= i) {
							if (isSpace(code, start)) start--;
							else {
								tailBefore = code[start];
								break;
							}
						}
					}

					break;
				}
			}

			if (pendExport) {
				lastInterested = gapEnd;
				if (pendForVarDecl) {
					pendForVarDecl = false;
					const name = readIdentifier();
					i = gapEnd;
					if (name === null) pendExport.uncertain = 'd';
					else pendExport.names.push(name);
				}
			}
		}
		if (match === null) break;

		let stop = match[0];
		i = at + stop.length;

		outer:
		switch (stop) {
			// 注释
			case '//': {
				const end = code.indexOf('\n', at);
				i = end < 0 ? length : end;
			}
			continue;
			case '/*': {
				const end = code.indexOf('*/', at+2);
				if (end < 0) fail('未闭合的块注释', at);
				i = end + 2;
			}
			continue;

			// 字符串
			case '"':
			case "'":
				i = matchString(code.charCodeAt(at), at);
			break;

			// 模板
			case '`':
				if (tpl.at(-1) === 0) {
					tpl.pop(); // 模板字符串结束
					tail = '`';
					if (pendExport) lastInterested = i;
				} else {
					tpl.push(0);
				}
				updateStop();
			continue;
			case '\\': i = at + 2; continue;
			case '${':
				tpl.push(++depth);
				updateStop();
				tail = '(';
			continue;

			// 正则和除号
			case '/':
				if (endsOperand(tail, tailBefore)) {
					tail = '/';
				} else {
					let j = at + 1;
					let inCharacterClass = false;
					for (;; j++) {
						if (j >= code.length) fail('未闭合的正则字面量', at);
						const c = code.charCodeAt(j);
						if (c === 92/* \ */) { j++; continue; }
						if (inCharacterClass) {
							if (c === 93/* ] */) inCharacterClass = false;
							continue;
						}
						if (c === 91/* [ */) { inCharacterClass = true; continue; }
						if (c === 47/* / */) break;

						// whitespace
						if (c === 10 || c === 13 || c === 0x2028 || c === 0x2029) break outer;
					}

					// 其实跳不跳无所谓吧？
					i = j+1;
					while(CHAR_TRAITS[code.charCodeAt(i)] & REGEXP_FLAGS_ID) i++;
					stop = ')';
				}
			break;

			// ASI
			case ';':
				if (pendExport && !depth) finishStmt(at + 1);
				else tail = ';';
			continue;
			case '\n':
				if (pendExport && !depth) {
					const next = nextToken(at + 1);
					if (!(CHAR_TRAITS[code.charCodeAt(next)] & CONTINUES_ID)
						&& !(pendForFunctionBody && code[next] === '{')
						&& endsOperand(tail, tailBefore)
					)
						finishStmt(lastInterested);
				}
			continue;

			// export const ...
			case ',':
				if (pendExport && !depth) pendForVarDecl = VAR.test(pendExport.declaration);
			break;

			// 括号
			case '(':
			case '[':
			case '{':
				if (pendExport && pendForVarDecl && !depth) {
					pendExport.uncertain = 'd';
					pendForVarDecl = false;
				}
				depth++;
				break;
			case ')':
			case ']': {
				if (depth) depth--;

				// import(...) 结束
				const sup = dynStack.at(-1);
				if (sup && depth < sup[1]) {
					const dyn = dynStack.pop()[0];
					const next = nextToken(i);

					if (sup[2] || code[next] !== '{' || code.slice(i, next).includes('\n'))
						nodes.push(endNode(dyn, i));
					updateStop();
				}
			}
			break;
			case '}':
				// 模板插值
				if (tpl.at(-1) === depth) {
					depth--;
					tpl.pop();
					updateStop();
					continue;
				}

				if (depth) depth--;
				if (pendExport && pendForFunctionBody && !depth) {
					const next = nextToken(i);
					if (code[next] === '{' && pendExport.declaration === 'class') {
						pendExport.uncertain = 'e';
					}
					if (code[next] === ';') i = next + 1;
					finishStmt(i);
					continue;
				}
			break;

			// import / export
			default: {
				// \b 只处理ASCII字符，用零宽断言又影响性能，先这样
				if (puncOrWord(code, at - 1) || puncOrWord(code, at + stop.length)) {
					tail = stop;
					continue;
				}

				const tailLen = tail.length - 1;
				let dots = 0;
				while (dots <= tailLen && tail.charCodeAt(tailLen - dots) === 46/* . */) dots++;

				if (tail[tailLen] === '#' || (dots > 0 && dots < 3 && !(tailBefore >= '0' && tailBefore <= '9' && tailLinebreak))) {
					i = at + 6;
					tail = stop;
					lastInterested = i;
					continue;
				}

				let node;
				if (stop === 'import') {
					const w1 = nextToken(i);

					if (code[w1] === '(') {
						i = w1 + 1;
						const dyn = {
							type: 'importDynamic',
							start: at,
							source: readString(),
							sourceEnd: i
						};
						dynStack.push([dyn, ++depth, tail === 'extends' || pendForClassInherit]);
						tail = '(';
						updateStop();
						continue;
					}

					if (code[w1] === '.') {
						i = w1 + 1;
						if (readIdentifier() === 'meta') {
							nodes.push(endNode({type: 'importMeta', start: at}, i));
							tail = ')';
							if (pendExport) lastInterested = i;
							continue;
						}
						i = at + 6;
						tail = stop;
						lastInterested = i;
						continue;
					}

					node = parseImport(at);
				} else {
					node = parseExport(at);
				}

				if (!node) {
					tail = stop;
					lastInterested = i;
					continue;
				}

				if (depth) fail('非顶层的 import/export 语句 (也可能是实现问题)', at);

				nodes.push(node);

				if (node.statementEnd === undefined && stop === 'export') {
					pendExport = node; // 等ASI
					pendForVarDecl = VAR.test(node.declaration);
					pendForFunctionBody = !pendForVarDecl && node.declaration !== 'default';
					lastInterested = i;
					tail = '';
					updateStop();
					continue;
				}

				i = node.statementEnd ?? node.end;
				stop = ';';
			}
		}

		tail = stop;
		lastInterested = i;
	}
	//endregion

	if (tpl.length) fail('未闭合的模板字面量');
	if (dynStack.length) fail('未闭合的 import()', dynStack.at(-1)[0].start);
	if (pendExport) finishStmt(lastInterested);

	return nodes;
}

/**
 * 这个名字能不能不加引号直接写进代码
 * @param {string} name
 * @returns {boolean}
 */
export const isIdentifierName = name => IDENTIFIER1.test(name);

/**
 * 按 [start, end) 替换源码片段，区间之外逐字节保留。
 *
 * @param {string} code 原始源码
 * @param {Iterable<{start: number, end: number, text?: string|null}>} edits
 *   顺序任意；`replacement` 为 null/undefined 的项跳过
 * @returns {string}
 * @throws {TypeError} `start`/`end` 不是整数
 * @throws {RangeError} 区间越界或重叠（重叠还硬拼只会悄悄生成一堆垃圾）
 */
export function applyEdits(code, edits) {
	const list = [];
	for (const edit of edits) {
		if (edit.text == null) continue;
		list.push(edit);
	}

	list.sort((a, b) => a.start - b.start || a.end - b.end);

	let out = '';
	let pos = 0;
	for (const edit of list) {
		const {start, end} = edit;
		if (!Number.isInteger(start) || !Number.isInteger(end)) throw new TypeError(`替换区间不是整数: [${start}, ${end})`);
		if (start < pos || end < start || end > code.length) throw new RangeError(`替换区间非法或重叠: [${start}, ${end})`);

		out += code.slice(pos, start) + edit.text;
		pos = end;
	}
	return out + code.slice(pos);
}
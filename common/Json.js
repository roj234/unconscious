const AS_IS = () => {};

const WHITESPACE = 1, NUMBER_START = 2, NUMBER_START_JSON5 = 4, NUMBER_END = 8;

const CHAR_TRAITS = new Uint8Array(128);
const fill = (chars, flag) => {
	for (let i = 0; i < chars.length; i++) {
		CHAR_TRAITS[chars.charCodeAt(i)] |= flag;
	}
};
fill("\r\n\t ", WHITESPACE);
fill("0123456789+-.", NUMBER_START);
// Infinity or NaN
fill("IN", NUMBER_START_JSON5);
// 用 [0-9eE+-.] 做白名单也行
// oct+bin+hex+dec+float 的完整状态机有两百多行，已经和这个JsonParser在同一量级了，不值，更不用说JS本身就不适合计算密集型这个问题
fill(" \t\r\n+]},/\0", NUMBER_END);

/**
 * 流式增量 JSON 'push' 模式解析器。
 * 允许在 JSON 数据尚未完整接收时，通过 `write` 方法逐块输入字符，并实时触发回调处理已解析的节点。
 * 特别支持对长字符串值的“部分更新”同步。
 *
 * 需要注意的特性：
 * - 顶层字符串值不会触发增量更新回调
 * - 字符串接受未转义控制字符 (如换行)
 * - 不支持 \U{...} 语法
 *
 * @param {function(path: (string|number)[], value: any, is_partial: boolean): void} onValue
 * 当解析到新值或字符串片段时的回调函数。
 * - `path`: 当前值的路径数组（包含键名或数组索引）。
 * - `value`: 解析到的值。如果是字符串片段，则为片段内容。
 * - `is_partial`: 为 true 时表示 value 仅为字符串的一部分，常用于流式处理大文本或 AI 响应。
 *
 * @param {boolean=false} emitDelta 当解析字符串未完成时，回调完整的已解析字符串(prefix)，还是仅新增部分(delta)
 * - 无论如何，is_partial=false时都是完整字符串
 *
 * @param {boolean=false} json5 启用 JSON5 解析 (注：并非所有 JSON5 特性都被禁用，如尾逗号在架构上就允许，检测反而需要额外代价影响性能)
 * @param {boolean=false} jsonl 启用 JSONL 解析 (在 onValue 中用 !path.length 分割)
 * @returns {StreamJsonParserInstance}
 *
 * @example
 * const parser = StreamJsonParser((path, val, partial) => {
 *   console.log(`Path: ${path.join('.')}, Value: ${val}, Partial: ${partial}`);
 * });
 * parser.write(`{'text': "hello `);
 * parser.write(`world",}`);
 * const result = parser.end();
 */
export function createJsonParser(onValue, {emitDelta, json5, jsonl} = {}) {
	let root;
	const stack = [];
	const path = [];

	const
		STATE_STR = 0,
		STATE_STR_ESC = 1,
		STATE_STR_HEX = 2,
		STATE_STR_UNICODE = 3,
		STATE_LIT = 4,
		STATE_NUM = 5,
		OBJECT_BARE_KEY = 6,

		STATE_NORM = 7,
		OBJECT_KEY_AFTER = 8,
		OBJECT_BEGIN = 9,
		AFTER = 10,
		ENDED = 11,

		COMMENT_START = 12,
		COMMENT_MULTI_LINE = 16 | (0 << 5),
		COMMENT_SINGLE_LINE = 16 | (2 << 5);

	/** @type {number} */
	let priorCommentState;

	/** @type {string|null} */
	let key;

	let state = STATE_NORM;
	/** @type {string} */
	let buf = '', enterCh;
	/** @type {number} */
	let bufLastPartialSyncIdx;
	/** @type {number} */
	let index;
	let literal;
	/** @type {string} */
	let escapeBuf;

	let diagnosticPos = 0;

	const FAIL = (excepting, found) => {
		throw new Error((path.length?"pointer /"+path.join("/")+": ":"")+"excepting "+excepting+" but found "+JSON.stringify(found));
	};

	const pushValue = (obj, partial = false) => {
		buf = '';

		if (root === undefined) {
			root = obj;
			if (!partial) {
				state = ENDED;
				return;
			}
		} else {
			const container = stack.at(-1);
			if (Array.isArray(container)) {
				onValue(path, obj, partial);
				container.push(obj);
			} else {
				if (key == null) {
					key = obj;
					state = OBJECT_KEY_AFTER;
					path.push(key);
					return;
				} else {
					onValue(path, obj, partial);
					container[key] = obj;
					key = null;
				}
			}
		}
		state = AFTER;
	};

	const enterStringMode = ch => {
		enterCh = ch;
		bufLastPartialSyncIdx = 0;
		state = STATE_STR;
	};

	/**
	 * @param {string} input
	 */
	const write = input => {
		let i = 0;
		const length = input.length;
		for (; i < length; i++, diagnosticPos++) {
			let ch = input[i];

			if (state >= STATE_NORM) {
				if (state >= COMMENT_MULTI_LINE) {
					const prevI = i;
					const type = state >>> 5;
					// 单行注释
					if (type === 2) {
						i = input.indexOf('\n', i);
						const end = i < 0 ? length : i;
						diagnosticPos += end - prevI;
						//handleComment(chars.slice(prevI, end));
						if (i < 0) return;
						state &= 0xF;
					} else {
						if (type === 1) {
							// 遇到了星号
							if (ch === '/') {
								state &= 0xF;
								continue;
							} else {
								//handleComment('*');
								// reset type to 0
								state &= 0x1F;
							}
						}

						i = input.indexOf('*/', i);
						const end = i < 0 ? length : i;
						diagnosticPos += end - prevI;
						//handleComment(chars.slice(prevI, end));
						if (i < 0) {
							if (input.endsWith('*')) state |= 1 << 5;
							return;
						}

						state &= 0xF;
						i++;
					}

					continue;
				}
				if (state === COMMENT_START) {
					if (ch === '/') state = priorCommentState|COMMENT_SINGLE_LINE;
					else if (ch === '*') state = priorCommentState|COMMENT_MULTI_LINE;
					else FAIL("COMMENT", ch);

					continue;
				}
				if (ch === '/' && json5) {
					priorCommentState = state;
					state = COMMENT_START;
					continue;
				}
				if (CHAR_TRAITS[ch.charCodeAt(0)] & WHITESPACE) continue;
			}

			switch (state) {
				// {" or {}
				//  ^     ^
				case OBJECT_BEGIN: {
					if (ch === '"' || ch === '\'') {
						enterStringMode(ch);
						continue;
					} else if (ch === '}') {
						const last = stack.pop();
						state = stack.length ? AFTER : ENDED;
						onValue(path, last, false);
						continue;
					} else {
						if (json5) {
							state = OBJECT_BARE_KEY;
						} else {
							FAIL('"\\"" or "}"', ch);
						}
					}
				}
				// {"a":
				//     ^
				// noinspection FallThroughInSwitchStatementJS
				case OBJECT_BARE_KEY:
				case OBJECT_KEY_AFTER:
					if (state === OBJECT_BARE_KEY) {
						const prevI = i;
						i = input.indexOf(':', i);
						if (i < 0) {
							diagnosticPos += length - prevI;
							buf += input.slice(prevI);
							return;
						}

						buf += input.slice(prevI, i);
						if (!buf) FAIL("KEY", ':');

						let j = 0;
						while (j < buf.length && !(CHAR_TRAITS[buf.charCodeAt(j)] & WHITESPACE)) j++;
						for (; j < buf.length; j++) {
							if (!(CHAR_TRAITS[buf.charCodeAt(j)] & WHITESPACE)) {
								FAIL('":"', buf[j]);
							}
						}

						diagnosticPos += i - prevI;
						pushValue(buf);
					} else {
						if (ch !== ':') FAIL('":"', ch);
					}

					state = STATE_NORM;
					continue;
				// {"a":1  or [1
				//       ^      ^
				case AFTER:
					if (ch === ',') {
						if (Array.isArray(stack.at(-1))) {
							state = STATE_NORM;
							path[path.length-1]++;
						} else {
							state = OBJECT_BEGIN;
							path.pop();
						}
						continue;
					}

					if (ch !== ']' && ch !== '}') FAIL("TERM", ch);
					state = STATE_NORM;
					break;
			}
			switch (state) {
				case ENDED:
					if (!jsonl) FAIL("WHITESPACE", ch);
					root = undefined;
				// noinspection FallThroughInSwitchStatementJS
				case STATE_NORM: {
					switch (ch) {
						case 't':
							buf = "true";
							index = 1;
							literal = true;
							state = STATE_LIT;
						break;
						case 'f':
							buf = "false";
							index = 1;
							literal = false;
							state = STATE_LIT;
						break;
						case 'n':
							buf = "null";
							index = 1;
							literal = null;
							state = STATE_LIT;
						break;
						case '{': {
							const obj = {};
							pushValue(obj, 1);
							stack.push(obj);
							state = OBJECT_BEGIN;
						}
						break;
						case '[': {
							const obj = [];
							pushValue(obj, 1);
							stack.push(obj);
							path.push(0);
							state = STATE_NORM;
						}
						break;
						case '"':
						case '\'':
							enterStringMode(ch);
						break;
						case '}':
						case ']': {
							if (key != null) FAIL("VALUE", ch);

							const last = stack.pop();
							if (!last) FAIL("VALUE", ch);

							const lastIsArray = Array.isArray(last);
							if (lastIsArray !== (ch === ']')) FAIL(lastIsArray ? '"]"' : '"}"', ch);

							path.pop();
							state = stack.length ? AFTER : ENDED;
							onValue(path, last, false);
							break;
						}
						default:
							if (CHAR_TRAITS[ch.charCodeAt(0)] & (json5 ? NUMBER_START_JSON5|NUMBER_START : NUMBER_START)) {
								buf = ch === '+' ? '' : ch;
								state = STATE_NUM;
								break;
							}
							FAIL("VALUE", ch);
					}
				}
				break;
				case STATE_LIT: {
					if (ch !== buf[index]) FAIL(JSON.stringify(buf)+" (index "+index+")", ch);

					if (++index === buf.length) {
						pushValue(literal);
						index = 0;
					}
				}
				break;
				case STATE_STR: {
					const prevI = i;
					let earlyExitFlag;
					for (;;) {
						if (ch === '\\' || ch === enterCh) {
							earlyExitFlag = ch;
							break;
						}
						if (++i === length) break;
						ch = input[i];
					}

					diagnosticPos += i - prevI;
					buf += input.slice(prevI, i);

					// or just i === length
					if (!earlyExitFlag) return;
					if (earlyExitFlag === enterCh) {
						pushValue(buf);
					} else {
						state = STATE_STR_ESC;
					}
				}
				break;
				case STATE_STR_ESC: {
					state = STATE_STR;
					switch (ch) {
						default: buf += ch; break;
						//case '"': buf += '"'; break;
						//case '\\': buf += '\\'; break;
						//case '/': buf += '/'; break;
						case '\n': break; // 忽略换行符 (\r\n还挺麻烦又要加状态的先只处理\n吧)
						case '0': buf += '\0'; break; // 禁止八进制转义
						case 'b': buf += '\b'; break;
						case 'f': buf += '\f'; break;
						case 'n': buf += '\n'; break;
						case 'r': buf += '\r'; break;
						case 't': buf += '\t'; break;
						case 'v': buf += '\v'; break;
						case 'x': case 'X': state = STATE_STR_HEX; escapeBuf = ''; break;
						case 'u': state = STATE_STR_UNICODE; escapeBuf = ''; break;
					}
				}
				break;
				case STATE_STR_HEX:
				case STATE_STR_UNICODE: {
					const needLength = ((state === STATE_STR_HEX) ? 2 : 4) - escapeBuf.length;
					const remainLength = length - i;

					const delta = Math.min(remainLength, needLength);

					escapeBuf += input.slice(i, i + delta);
					diagnosticPos += delta;

					if (remainLength < needLength) return;

					const codePoint = parseInt(escapeBuf, 16);
					if (isNaN(codePoint)) FAIL('ESCAPE', `\\u${escapeBuf}`);
					buf += String.fromCharCode(codePoint);
					state = STATE_STR;

					diagnosticPos--;
					i += needLength - 1;
				}
				break;
				case STATE_NUM: {
					const prevI = i;
					let earlyExitFlag;
					for (;;) {
						if ((earlyExitFlag = (CHAR_TRAITS[ch.charCodeAt(0)] & NUMBER_END)) || ++i === length) break;
						ch = input[i];
					}

					diagnosticPos += i - prevI;
					buf += input.slice(prevI, i);

					// or just i === length
					if (!earlyExitFlag) return;

					let num = Number(buf);
					isOk:
					if (isNaN(num)) {
						// 这些都是冷路径，因为大部分JSON里都不会有这些
						// 我之前设计Tokenizer的时候就没做好冷热分离
						if (json5) {
							buf = buf.replaceAll("_", "");
							num = Number(buf);
							if (!isNaN(num)) break isOk;

							const neg = buf[0] === '-';
							if (buf.length <= 4 && buf.endsWith("NaN")) {
								if (buf[neg ? 1 : 0] === 'N') break isOk;
							} else if (buf.length <= 9 && buf.endsWith("Infinity")) {
								num = neg ? -Infinity : Infinity;
								if (buf[neg ? 1 : 0] === 'I') break isOk;
							}
						}

						FAIL('NUMBER', buf);
					}
					pushValue(num);
					if (ch !== '\0') {
						i--;
						diagnosticPos--;
					}
				}
				break;
			}
		}

		if (state <= STATE_STR_UNICODE && buf.length > bufLastPartialSyncIdx && (key != null || Array.isArray(stack.at(-1)))) {
			onValue(path, buf.slice(bufLastPartialSyncIdx), true);
			if (emitDelta) bufLastPartialSyncIdx = buf.length;
		}
	};

	return {
		pos: () => diagnosticPos,
		write,
		end: (ignoreUnexpected) => {
			if (state !== ENDED) {
				const noValue = root === undefined;
				if (state === STATE_NUM && noValue) {
					write('\0');
					// 允许注释持续到文件尾
				} else if ((state < 16 || noValue) && !ignoreUnexpected) {
					throw "Unexpected end of JSON input";
				}
			}
			return root;
		}
	}
}

/**
 * 宽容解析JSON（例如用户输入）
 * @param {string} str
 * @return {any}
 */
export const parseJson5 = (str) => {
	const parser = createJsonParser(AS_IS, {json5: true});
	try {
		parser.write(str);
		return parser.end();
	} catch (e) {
		throw e+" at position "+parser.pos();
	}
}
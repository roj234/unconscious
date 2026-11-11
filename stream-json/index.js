import {AS_IS} from "@roj234/shared";
import {locate} from "@roj234/shared/strings";
import {betterObject} from "@roj234/shared/objects";

const
	WHITESPACE = 1,
	NUMBER_START = 2, NUMBER_START_JSON5 = 4, NUMBER_END = 8,
	BARE_KEY_ILLEGAL = 16,
	YAML_KEY_END = 32,
	STRING_ESCAPE = 64;

const CHAR_TRAITS = new Uint16Array(128);
const fill = (chars, flag) => {
	for (let i = 0; i < chars.length; i++) {
		CHAR_TRAITS[chars.charCodeAt(i)] |= flag;
	}
};
fill("\t\n\v\f\r ", WHITESPACE);
fill("0123456789+-.", NUMBER_START);
// Infinity or NaN
fill("IN", NUMBER_START_JSON5);
// 用 [0-9eE+-.] 做白名单也行
// oct+bin+hex+dec+float 的完整状态机有两百多行，已经和这个JsonParser在同一量级了，不值，更不用说JS本身就不适合计算密集型这个问题
fill(" \t\r\n+]},/\0", NUMBER_END|BARE_KEY_ILLEGAL);
fill("{|~#%&()*,:<=>?@[^`\\/", BARE_KEY_ILLEGAL);
fill(",]}\r\n", YAML_KEY_END);

const HEX_VALUE = new Int8Array(103).fill(-1);
for (let c = 48; c <= 57; c++) HEX_VALUE[c] = c - 48;   // 0-9
for (let c = 65; c <= 70; c++) HEX_VALUE[c] = c - 55;   // A-F
for (let c = 97; c <= 102; c++) HEX_VALUE[c] = c - 87;  // a-f

const escapeMap = Object.create(null);
const s = '"\'`\0';
for (let i = 0; i < s.length; i++) {
	const flag = STRING_ESCAPE << i;
	escapeMap[s.charCodeAt(i)] = flag;
	fill("\\"+s[i], flag);
}

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
 * @param {boolean=false} unescape 启用字符串 unescape 模式
 * @param {boolean=false} yaml 启用 JSON in YAML 解析 (允许裸值，并折叠空白字符)
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
export function createJsonParser(onValue, {emitDelta, json5, jsonl, yaml, unescape } = {}) {
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
		YAML_VALUE = 7,

		STATE_NORM = 8,
		OBJECT_KEY_AFTER = 9,
		OBJECT_BEGIN = 10,
		AFTER = 11,
		ENDED = 12,

		COMMENT_START = 13,
		COMMENT_MULTI_LINE = 16 | (0 << 5),
		COMMENT_SINGLE_LINE = 16 | (2 << 5);

	/** @type {number} */
	let priorCommentState;

	/** @type {string|null} */
	let key;

	let state = STATE_NORM;
	/** @type {string} */
	let buf = '';
	/** @type {number} */
	let bufLastPartialSyncIdx;
	/** @type {number} */
	let index, enterCh;
	let literal;
	/** @type {string} */
	let escapeBuf;

	let diagnosticPos = 0;

	/**
	 * @param {string} expecting
	 * @param {any} [found]
	 * @param {number} [delta]
	 */
	const FAIL = (expecting, found, delta = 0) => {
		diagnosticPos += delta;
		throw new Error((path.length?"pointer /"+path.join("/")+": ":"")+"expecting "+expecting+" but found "+JSON.stringify(found));
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
	const shouldEmitJsonL = () => root === null || typeof root !== 'object';

	if (unescape) {
		enterCh = 0;
		state = STATE_STR;
	}

	/**
	 * @param {string} input
	 */
	const write = input => {
		let i = 0;
		const length = input.length;

		diagnosticPos += length;

		for (; i < length; i++) {
			let ch = input[i];

			if (state >= STATE_NORM) {
				if (state >= COMMENT_MULTI_LINE) {
					//const prevI = i;
					const type = state >>> 5;
					// 单行注释
					if (type === 2) {
						i = input.indexOf('\n', i);
						//const end = i < 0 ? length : i;
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
						//const end = i < 0 ? length : i;
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
					else FAIL("COMMENT", ch, i - length);

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
						enterStringMode(ch.charCodeAt(0));
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
							FAIL('"\\"" or "}"', ch, i - length);
						}
					}
				}
				// {"a":
				//     ^
				// fall through
				case OBJECT_BARE_KEY:
				case OBJECT_KEY_AFTER:
					if (state === OBJECT_BARE_KEY) {
						const prevI = i;
						i = input.indexOf(':', i);
						if (i < 0) {
							buf += input.slice(prevI);
							return;
						}

						buf += input.slice(prevI, i);
						if (!buf) FAIL("KEY", ':', i - length);

						let j = 0;
						while (j < buf.length && !(CHAR_TRAITS[buf.charCodeAt(j)] & (WHITESPACE|BARE_KEY_ILLEGAL))) j++;
						const key = buf.slice(0, j);
						for (; j < buf.length; j++) {
							if (!(CHAR_TRAITS[buf.charCodeAt(j)] & WHITESPACE)) {
								FAIL(j ? '":"' : "KEY", buf[j], i - length);
							}
						}

						pushValue(key);
					} else {
						if (ch !== ':') FAIL('":"', ch, i - length);
					}

					state = STATE_NORM;
					continue;
				case YAML_VALUE:
					const inTrait = CHAR_TRAITS[input.charCodeAt(i)];
					if (inTrait & YAML_KEY_END) {
						pushValue(buf.trim().replace(/  +/g, ' '));
					} else {
						if (!(inTrait & CHAR_TRAITS[buf.charCodeAt(buf.length-1)] & WHITESPACE)) {
							buf += ch;
						}
						break;
					}

				// {"a":1  or [1
				//       ^      ^
				// fall through
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

					if (ch !== ']' && ch !== '}') FAIL("TERM", ch, i - length);
					state = STATE_NORM;
					break;
			}
			switch (state) {
				case ENDED:
					if (!jsonl) FAIL("WHITESPACE", ch, i - length);
					if (shouldEmitJsonL()) onValue(path, root, false);
					root = undefined;
				// fall through
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
							const obj = Object.create(betterObject);
							pushValue(obj, true);
							stack.push(obj);
							state = OBJECT_BEGIN;
						}
						break;
						case '[': {
							const obj = [];
							pushValue(obj, true);
							stack.push(obj);
							path.push(0);
							state = STATE_NORM;
						}
						break;
						case '`':
						case '\'':
							//if (!json5) FAIL("VALUE", ch);
						// fall through
						case '"':
							enterStringMode(ch.charCodeAt(0));
						break;
						case '}':
						case ']': {
							if (key != null) FAIL("VALUE", ch, i - length);

							const last = stack.pop();
							if (!last) FAIL("VALUE", ch, i - length);

							const lastIsArray = Array.isArray(last);
							if (lastIsArray !== (ch === ']')) FAIL(lastIsArray ? '"]"' : '"}"', ch, i - length);

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
							if (!yaml) FAIL("VALUE", ch, i - length);
							state = YAML_VALUE;
							buf += ch;
					}
				}
				break;
				case STATE_LIT: {
					if (ch !== buf[index]) {
						if (!yaml) FAIL(JSON.stringify(buf)+"(index "+index+")", ch, i - length);
						state = YAML_VALUE;
						buf += ch;
						break;
					}

					if (++index === buf.length) {
						pushValue(literal);
						index = 0;
					}
				}
				break;
				case STATE_STR: {
					const prevI = i;
					const flag = escapeMap[enterCh];
					let match, mc;
					for (;;) {
						if ((match = (CHAR_TRAITS[mc = input.charCodeAt(i)] & flag)) || ++i === length) break;
					}

					buf += input.slice(prevI, i);

					// or just i === length
					if (!match) break;
					if (mc === enterCh) {
						pushValue(buf);
					} else {
						state = STATE_STR_ESC;
					}
				}
				break;
				case STATE_STR_ESC: {
					state = STATE_STR;
					switch (ch) {
						default: json5 ? buf += ch : FAIL('ESCAPE', '\\'+ch, i - length); break;
						//case '"': buf += '"'; break;
						//case '\\': buf += '\\'; break;
						//case '/': buf += '/'; break;
						case '\n': break; // 忽略换行符 (\r\n还挺麻烦又要加状态的先只处理\n吧)
						case '0': buf += '\0'; break; // 禁止八进制转义
						case 'n': buf += '\n'; break;
						case 't': buf += '\t'; break;
						case 'r': buf += '\r'; break;
						case 'b': buf += '\b'; break;
						case 'f': buf += '\f'; break;
						case 'v': buf += '\v'; break;
						case 'x': state = STATE_STR_HEX; escapeBuf = ''; break;
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

					if (remainLength < needLength) return;

					let codePoint = 0;
					for (let j = 0; j < escapeBuf.length; j++) {
						const v = HEX_VALUE[escapeBuf.charCodeAt(j)];
						if (!(v >= 0)) FAIL('ESCAPE', '\\'+(state === STATE_STR_HEX ? 'x' : 'u')+escapeBuf, i - length);
						codePoint = (codePoint << 4) | v;
					}
					buf += String.fromCharCode(codePoint);
					state = STATE_STR;

					i += needLength - 1;
				}
				break;
				case STATE_NUM: {
					const prevI = i;
					let match;
					for (;;) {
						if ((match = (CHAR_TRAITS[input.charCodeAt(i)] & NUMBER_END)) || ++i === length) break;
					}

					buf += input.slice(prevI, i);

					// or just i === length
					if (!match) return;

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
							} else if (buf.endsWith("n")) {
								try {
									num = BigInt(buf.slice(0, -1));
									break isOk;
								} catch {}
							}
						}

						FAIL('NUMBER', buf, i - length);
					}

					pushValue(num);
					if (ch !== '\0') i--;
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
					diagnosticPos--;
					// 允许注释持续到文件尾
				} else if (state < 16 || noValue) {
					if (!ignoreUnexpected) FAIL(`next(state=${state})`, "EOF");
					if (noValue) root = buf;
				}
			}
			if (jsonl && shouldEmitJsonL()) onValue(path, root, false);
			return root;
		}
	}
}

const DEFAULT_OPTIONS = {json5: true};

/**
 * 宽容解析JSON（例如用户输入）
 * 默认模式：JSON5
 * @param {string} str
 * @param {StreamJsonParserOptions} [options]
 * @return {any}
 */
export const parseJson5 = (str, options = DEFAULT_OPTIONS) => {
	const parser = createJsonParser(AS_IS, options);
	try {
		parser.write(str);
		return parser.end();
	} catch (e) {
		throw e+"\n"+locate(str, parser.pos());
	}
}
/*
Streaming Markdown Parser and Renderer
MIT License
Copyright 2024 Damian Tarnawski
https://github.com/thetarnav/streaming-markdown

Modified by Roj234
BSD-3 License
Copyright 2026 Roj234
https://github.com/roj234/streaming-markdown
*/

export const VOID_TAGS = /*#__PURE__*/ new Set(["area","base","br","col","embed","hr","img","input","link","meta","source","track","wbr"]);

/**
 *
 * @param {string[]} tags
 * @param tree
 * @return {Map<string, string | 0>}
 */
export const createTrieTree = (tags, tree = new Map) => {
	tree.set("", 0);
	for (let tag of tags) {
		for (let i = 0;;) {
			const end = ++i === tag.length;
			const prefix = tag.slice(0, i);
			if (end) { tree.set(prefix, tag); break; }
			if (!tree.has(prefix)) tree.set(prefix, 0);
		}
	}
	return tree;
};

export const
	DOCUMENT        =  1,
	PARAGRAPH       =  2,
	HEADING_1       =  3,
	HEADING_2       =  4,
	HEADING_3       =  5,
	HEADING_4       =  6,
	HEADING_5       =  7,
	HEADING_6       =  8,
	CODE_BLOCK      =  9,
	CODE_FENCE      = 10,
	CODE_INLINE     = 11,
	ITALIC_AST      = 12,
	STRONG_AST      = 14,
	STRIKE          = 16,
	LINK            = 17,
	RAW_URL         = 18,
	IMAGE           = 19,
	BLOCKQUOTE      = 20,
	LINE_BREAK      = 21,
	RULE            = 22,
	LIST_UNORDERED  = 23,
	LIST_ORDERED    = 24,
	LIST_ITEM       = 25,
	CHECKBOX        = 26,
	TABLE           = 27,
	TABLE_ROW       = 28,
	TABLE_CELL      = 29,
	EQUATION_BLOCK  = 30,
	EQUATION_INLINE = 31,
	NEWLINE         = 101,
	MAYBE_URL       = 102,
	MAYBE_TASK      = 103,
	MAYBE_BR        = 104,
	MAYBE_EQ_BLOCK  = 105,
	HTML_ELEMENT    = 32,
	QUOTE           = 33,
	HTML_ATTR= 34,
	HTML_ATTR_VAL = 35
;

const INLINE_TOKEN_PREFIX = new Map;
INLINE_TOKEN_PREFIX.set(CODE_INLINE, '`');
INLINE_TOKEN_PREFIX.set(ITALIC_AST, '*');
INLINE_TOKEN_PREFIX.set(STRONG_AST, '**');
//INLINE_PREFIX.set(STRIKE, '~~');
INLINE_TOKEN_PREFIX.set(LINK, '[');
INLINE_TOKEN_PREFIX.set(IMAGE, '![');
INLINE_TOKEN_PREFIX.set(EQUATION_INLINE, '$');
INLINE_TOKEN_PREFIX.set(QUOTE, '');

export const
	HREF    = "href",
	SRC     = "src",
	LANG    = "lang",
	CHECKED = "checked",
	START   = "start",
	ALIGN   = "align";

/**
 * Makes a new Parser object.
 * @param {Renderer} renderer
 * @param {ParserOptions=} options
 * @returns {Parser}
 * @constructor
 */
export function createMarkdownParser(renderer, options = {}) {
	return {
		renderer,
		options,

		text       : "",
		pending    : "",
		tokens     : [DOCUMENT],
		token      : DOCUMENT,
		blockquote_idx: 0,

		hr_char    : '',
		hr_chars   : 0,

		fence_start: 0,
		fence_line: 0,

		spaces     : [],
		indent     : "",
		indent_len : 0,

		table_state: 0,

		write(chunk) {
			parser_write(this, chunk);
		},
		end() {
			const p = this;
			p.options = {
				...p.options,
				parseQuotes: false
			};

			if (p.pending) parser_write(p, "\n");

			//*哈`基"米
			for (;;) {
				let prefix = INLINE_TOKEN_PREFIX.get(p.token);
				if (null == prefix) break;
				retractWithPrefix(p, prefix, "");
			}

			if (p.pending) parser_write(p, "\n");

			flush_text(p);

			// 让未结束的代码块能语法高亮，也许还有其它side-effect?
			p.token = p.tokens.at(-1);
			end_tokens_to_len(p, 0);
		}
	}
}

/**
 * @param {Parser} p
 */
const flush_text = p => {
	if (!p.text) return
	console.assert(p.tokens.length > 1, "Never adding text to root")
	p.renderer.add_text(p.text, p);
	p.prev_text = p.text.slice(-1);
	p.text = ""
};

/**
 * @param {Parser} p
 * @return {string}
 */
const get_last_char = p => p.text.slice(-1) || p.prev_text || "";

const URL_VALID_CHARS = /[a-zA-Z0-9%/!@#$&*()_+~=,.?';:-]/;
const SPACE_LIKE = new Set(" \r\n\t，。：、？；’”）】》".split(""));
const DELIMITER = new Set("(（“‘《【".split(""));
const DELIMITER2 = new Set("*(),:".split("")); // no space, only after??
//const regex = /\p{Z}\p{S}\p{P}/u;
const isSpaceLike = char => !char.length || SPACE_LIKE.has(char);
const isValidLatexBegin = char => isSpaceLike(char) || DELIMITER.has(char);
const isValidLatexEnd = char => isValidLatexBegin(char) || DELIMITER2.has(char);

/**
 * @param {Parser} p
 * @param {boolean=} undo_prefix
 */
const end_token = (p, undo_prefix) => {
	const token = p.token;
	p.token = p.tokens[--p.tokens.length - 1];
	return p.renderer.end_token(token, p, undo_prefix);
};

/**
 * @param {Parser} p
 * @param {number} token
 */
const add_token = (p, token, arg3) => {
	const prev = p.tokens.at(-1);
	if ((prev === LIST_ORDERED || prev === LIST_UNORDERED) && token !== LIST_ITEM) {
		end_token(p)
	}

	p.tokens.push(token);
	p.token = token;
	p.renderer.add_token(token, p, arg3);
};

/**
 * End tokens until the parser has the given length.
 * @param {Parser} p
 * @param {number} len
 */
function end_tokens_to_len(p, len) {
	//if (!len) p.skipNextBr = 0;

	// TODO: specific token state should be reset only when the token ends
	p.fence_start = 0

	while ((p.tokens.length - 1) > len) {
		if (p.tokens.at(-1) === HTML_ELEMENT) break;
		end_token(p)
	}
}

/**
 * @param {Parser} p
 * @param {number} indent
 * @returns {number} */
function end_tokens_to_indent(p, indent) {
	if (!indent) p.skipNextBr = 0;

	let i;
	for (i = 0; i < p.tokens.length; i++) {
		if ((p.spaces[i] || 0) >= indent) break;
	}

	while ((p.tokens.length - 1) > i) {
		if (p.tokens.at(-1) === HTML_ELEMENT) break;
		end_token(p);
	}

	//return indent
}

/**
 * @param {Parser} p
 * @param {number} list_token
 * @returns {boolean} added a new list */
function continue_or_add_list(p, list_token) {
	/* will create a new list inside the last item
	   if the amount of spaces is greater than the last one (with prefix)
	   1. foo
		  - bar      <- new nested ul
			 - baz   <- new nested ul
		  12. qux    <- cannot be nested in "baz" or "bar",
						so it's a new list in "foo"
	*/
	let list_idx = -1
	let item_idx = -1

	for (let i = p.blockquote_idx+1; i < p.tokens.length; i++) {
		if (p.tokens[i] === LIST_ITEM) {
			if (p.indent_len < p.spaces[i]) {
				item_idx = -1
				break
			}
			item_idx = i
		} else if (p.tokens[i] === list_token) {
			list_idx = i
		}
	}

	if (item_idx === -1) {
		if (list_idx === -1) {
			end_tokens_to_len(p, p.blockquote_idx)
			add_token(p, list_token)
			return true
		}
		end_tokens_to_len(p, list_idx)
		return false
	}
	end_tokens_to_len(p, item_idx)
	add_token(p, list_token)
	return true
}

/**
 * Create a new list
 * or continue the last one
 * @param {Parser} p
 * @param {number} prefix_length
 * @returns {void} */
function add_list_item(p, prefix_length) {
	p.skipNextBr = 0;
	add_token(p, LIST_ITEM)
	p.spaces[(p.tokens.length - 1)] = p.indent_len + prefix_length
	clear_root_pending(p)
	p.token = MAYBE_TASK
}

/**
 * @param {Parser} p
 */
function clear_root_pending(p) {
	p.indent = ""
	p.indent_len = 0
	p.pending = ""
}

/**
 * @param {Parser} p
 * @param {number} token_id
 */
function ignore(p, token_id) {
	if (!p.ignored) p.ignored = new Set([token_id]);
	else p.ignored.add(token_id);
}

function retractWithPrefix(p, prefix, postfix) {
	flush_text(p);
	p.text = prefix;

	const pend = p.pending;
	p.pending = '';

	const retract = end_token(p, true) + pend + postfix;
	parser_write(p, retract);
}

function closeHtmlTag(p) {
	flush_text(p);
	p.pending = "";
	if (p.tokens.lastIndexOf(HTML_ELEMENT) < 0) return;
	end_tokens_to_len(p, 0);
	return end_token(p);
}

function commitNoValueAttr(p) {
	const tag_attr = p.pending.trim();
	p.pending = '';
	if (tag_attr) p.renderer.set_attr(tag_attr, '');
}

function endElement(p, pending_with_char) {
	commitNoValueAttr(p);

	p.token = HTML_ELEMENT;
	if (pending_with_char.endsWith("/>") || VOID_TAGS.has(p.tag_id)) {
		closeHtmlTag(p);
	}
}

/**
 * Parse and render another chunk of markdown.
 * @param {Parser} p
 * @param {string} chunk
 */
function parser_write(p, chunk) {
	for (let char of chunk) {
		if (p.token === NEWLINE) {
			switch (char) {
				case ' ': p.indent_len += 1; continue
				case '\t': p.indent_len += 4; continue
				case '>':
					if (p.blockquote_depth) {
						p.blockquote_depth--;
						p.indent_len --;
						continue
					}
			}

			let indent = p.indent_len - p.spaces[p.tokens.length-1];//end_tokens_to_indent(p, p.indent_len)

			p.fence_line = 0
			p.indent_len = 0
			p.token = p.tokens.at(-1)

			if (indent > 0) {
				parser_write(p, " ".repeat(indent))
			}
		}

		if (p.token === HTML_ELEMENT) {
			if (char !== '<') {
				// 禁用某些标签中的 markdown 解析
				const tagId = p.tag_id;
				if (p.options.textTags?.has(tagId) || tagId === "style" || tagId === "script") {
					p.text += p.pending;
					p.pending = '';
				}
			} else {
				p.token = MAYBE_BR;
			}
		}

		const pending_with_char = p.pending + char

		/*
		number specific checks
		*/
		big:
		switch (p.token) {
			case HTML_ELEMENT:
				// HTML_ELEMENT only
				if (p.options.stream) flush_text(p);
				if (get_last_char(p)) break;
			// noinspection FallThroughInSwitchStatementJS
			case LINE_BREAK:
			case DOCUMENT:
			case BLOCKQUOTE:
			case LIST_ORDERED:
			case LIST_UNORDERED:
				//if (p.token !== HTML_ELEMENT) console.assert(p.text.length === 0, "Root should not have any text")

				switch (p.pending[0]) {
					case undefined:
						p.pending = char
						continue
					case ' ':
						if (p.token === HTML_ELEMENT) break big;
						console.assert(p.pending.length === 1)
						p.pending = char
						p.indent += ' '
						p.indent_len += 1
						continue
					case '\t':
						if (p.token === HTML_ELEMENT) break big;
						console.assert(p.pending.length === 1)
						p.pending = char
						p.indent += '\t'
						p.indent_len += 4
						continue
					case '\n':
						console.assert(p.pending.length === 1)
						p.prev_text = '\n';
						if (p.token === HTML_ELEMENT) {
							p.token = LINE_BREAK;
							p.pending = char;
							continue;
						}
						/*
						 Lists can have an empty line in between items:
						 1. foo
						 <empty>
						 2. bar
						*/
						if (p.token === LINE_BREAK) {
							switch (p.tokens.at(-1)) {
								case HTML_ELEMENT:
									p.renderer.add_token(LINE_BREAK, p);
									p.renderer.end_token(LINE_BREAK, p);
									break big;

								case LIST_ITEM:
									p.skipNextBr = 1;
									break

								case ITALIC_AST:
								case STRONG_AST:
								case CODE_INLINE:
									retractWithPrefix(p, INLINE_TOKEN_PREFIX.get(p.tokens.at(-1)), char);
									p.pending = char;
									continue;
							}
						}

						/*
						 Exit out of tokens
						 And ignore newlines in root
						*/
						end_tokens_to_len(p, p.blockquote_idx)
						clear_root_pending(p)
						p.blockquote_idx = 0
						p.fence_start = 0
						p.pending = char
						continue
					/* Heading */
					case '#':
						switch (char) {
							case '#':
								if (p.pending.length < 6) {
									p.pending = pending_with_char
									continue
								}
								break // fail
							case ' ':
								end_tokens_to_indent(p, p.indent_len)
								add_token(p, HEADING_1 + p.pending.length - 1)
								clear_root_pending(p)
								continue
						}
						break // fail
					/* Blockquote */
					case '>': {
						let next_blockquote_idx = p.tokens.indexOf(BLOCKQUOTE, p.blockquote_idx + 1)

						/*
						Only when there is no blockquote to the right of blockquote_idx
						a new blockquote can be created
						*/
						if (next_blockquote_idx === -1) {
							if (p.blockquote_idx) end_tokens_to_len(p, p.blockquote_idx);
							else end_tokens_to_indent(p, p.indent_len);

							// 这个数组应该可以复用？
							p.spaces[p.tokens.length - 1] = p.indent_len;
							p.blockquote_idx += 1
							p.fence_start = 0
							add_token(p, BLOCKQUOTE);
						} else {
							// 这个是否需要移到外面？
							if (p.spaces[next_blockquote_idx] > p.indent_len) {
								end_tokens_to_indent(p, p.indent_len);
								p.spaces[p.tokens.length] = p.indent_len;
								add_token(p, BLOCKQUOTE);
							}
							p.blockquote_idx = next_blockquote_idx
						}

						clear_root_pending(p)
						p.pending = char
						continue
					}
					/* Horizontal Rule
					   "-- - --- - --"
					*/
					case '-':
					case '*':
					case '_':
						if (p.hr_chars === 0) {
							console.assert(p.pending.length === 1, "Pending should be one character")
							p.hr_chars = 1
							p.hr_char = p.pending
						}

						if (p.hr_chars > 0) {
							switch (char) {
								case p.hr_char:
									p.hr_chars += 1
									p.pending = pending_with_char
									continue
								case ' ':
									p.pending = pending_with_char
									continue
								case '\n':
									if (p.hr_chars < 3) break
									end_tokens_to_indent(p, p.indent_len)
									p.renderer.add_token(RULE, p)
									p.renderer.end_token(RULE, p);
									clear_root_pending(p)
									p.hr_chars = 0
									continue
							}

							p.hr_chars = 0
						}

						/* Unordered list
						/  * foo
						/  * *bar*
						/  * **baz**
						/*/
						if ('_' !== p.pending[0] &&
							' ' === p.pending[1]
						) {
							continue_or_add_list(p, LIST_UNORDERED)
							add_list_item(p, 2)
							parser_write(p, pending_with_char.slice(2))
							continue
						}

						break // fail
					/* Code Fence */
					case '`':
						/*  ``?
							  ^
						*/
						if (p.pending.length < 3) {
							if ('`' === char) {
								p.pending = pending_with_char
								p.fence_start = pending_with_char.length
								continue
							}
							p.fence_start = 0
							break // fail
						}

						switch (char) {
							case '`':
								/*  ````?
									   ^
								*/
								if (p.pending.length === p.fence_start) {
									p.pending = pending_with_char
									p.fence_start = pending_with_char.length
								}
								/*  ```code`
										   ^
								*/
								else {
									add_token(p, PARAGRAPH)
									clear_root_pending(p)
									p.fence_start = 0
									parser_write(p, pending_with_char)
								}
								continue
							case '\n': {
								if (p.tokens.at(-1) === CODE_INLINE) break;

								/*  ```lang\n
											^
								*/
								end_tokens_to_indent(p, p.indent_len)

								add_token(p, CODE_FENCE)
								p.spaces[p.tokens.length - 1] = p.indent_len;
								if (p.pending.length > p.fence_start) {
									p.renderer.set_attr(LANG, p.pending.slice(p.fence_start))
								}
								clear_root_pending(p)
								p.token = NEWLINE
								p.blockquote_depth = p.blockquote_idx && p.tokens.filter(t => t === BLOCKQUOTE).length;
								continue
							}
							default:
								/*  ```lang\n
										^
								*/
								p.pending = pending_with_char
								continue
						}
					/*
					List Unordered for '+'
					The other list types are handled with HORIZONTAL_RULE
					*/
					case '+':
						if (' ' !== char) break // fail

						continue_or_add_list(p, LIST_UNORDERED)
						add_list_item(p, 2)
						continue
					/* List Ordered */
					case '0': case '1': case '2': case '3': case '4':
					case '5': case '6': case '7': case '8': case '9':
						/*
						12. foo
						   ^
						*/
						if ('.' === p.pending[p.pending.length-1]) {
							if (' ' !== char) break // fail

							if (continue_or_add_list(p, LIST_ORDERED) && p.pending !== "1.") {
								p.renderer.set_attr(START, p.pending.slice(0, -1))
							}
							add_list_item(p, p.pending.length+1)
							continue
						} else {
							if (/[.0-9]/.test(char[0])) {
								p.pending = pending_with_char
								continue
							}
						}
						break // fail
					/* Table */
					case '|':
						/*if (p.blockquote_idx) end_tokens_to_len(p, p.blockquote_idx);
						else */end_tokens_to_indent(p, p.indent_len);

						delete p.table_align;
						add_token(p, TABLE)
						add_token(p, TABLE_ROW)

						p.pending = ""
						parser_write(p, char)

						continue
				}

				let to_write = pending_with_char

				/* Add a line break and continue in previous token */
				if (p.token === LINE_BREAK || p.skipNextBr) {
					if (p.skipNextBr === 1) end_tokens_to_len(p, p.blockquote_idx);

					p.token = p.tokens.at(-1);

					// TODO better latex parse ??
					if (!p.skipNextBr && to_write !== "$$") {
						if ((p.end_with_space || p.options.preserveLineBreaks)) {
							p.renderer.add_token(LINE_BREAK, p);
							p.renderer.end_token(LINE_BREAK, p);
						} else {
							p.text += " ";
						}
					} else {
						p.prev_text = '\n';
					}
					p.skipNextBr = 0;
				}
				/* Code Block */
				else if (p.indent_len >= 4 && p.options.parseCodeBlock) {
					/*
					Case where there are additional spaces
					after the indent that makes the code block
					_________________________
						   code
					^^^^----indent
						^^^-part of code
					_________________________
					 \t   code
					^^-----indent
					   ^^^-part of code
					*/
					let code_start = 0
					for (; code_start < 4; code_start += 1) {
						if (p.indent[code_start] === '\t') {
							code_start = code_start+1
							break
						}
					}
					to_write = p.indent.slice(code_start) + pending_with_char
					add_token(p, CODE_BLOCK)
				}
				/* Paragraph */
				else if (p.token !== HTML_ELEMENT) {
					add_token(p, PARAGRAPH);
				} else {
					break;
				}

				clear_root_pending(p)
				parser_write(p, to_write)
				continue
			case TABLE:
				if (p.table_state === 1) {
					switch (char) {
						case '-':
						case ' ':
						case '|':
						case ':':
							p.pending = pending_with_char
							continue
						case '\n':
							p.table_align = p.pending.split("|").map(t => t.trim()).filter(t => t).map(t => {
								const left = t[0] === ':';
								const right = t[t.length-1] === ':';
								if (left && right) return "center";
								if (right) return "right";
								return "left";
							});
							p.td_index = 0;

							p.table_state = 2
							p.pending = ""
							continue
						default:
							end_token(p)
							p.table_state = 0
							break
					}
				} else {
					const s1 = p.pending.trim();
					if (s1 === '|') {
						add_token(p, TABLE_ROW)
						p.pending = ""
						parser_write(p, char)
						continue
					}
					if (s1) {
						end_token(p)
						clear_root_pending(p)
						//p.token = LINE_BREAK;
						p.pending = ""
						p.table_state = 0
						parser_write(p, s1+char)
						continue
					}

					p.pending = pending_with_char;
					continue;
				}
				break
			case TABLE_ROW:
				switch (p.pending) {
					case "":
						break
					case "|":
						add_token(p, TABLE_CELL)
						end_token(p)
						p.pending = ""
						parser_write(p, char)
						continue
					case "\n":
						p.td_index = 0;
						end_token(p)
						p.table_state = Math.min(p.table_state+1, 2)
						p.pending = ""
						parser_write(p, char)
						continue
					default:
						add_token(p, TABLE_CELL)
						parser_write(p, char)
						continue
				}
				break
			case TABLE_CELL:
				if (p.pending === "|") {
					flush_text(p)
					if (p.table_align)
						p.renderer.set_attr(ALIGN, p.table_align[p.td_index++]);
					end_token(p)
					p.pending = ""
					parser_write(p, char)
					continue
				}
				if (char === "\n") {
					//retractWithPrefix(p, "", "");
					const s = end_token(p, true);
					parser_write(p, s);
				}
				break
			case CODE_BLOCK:
				switch (pending_with_char) {
					case "\n    ":
					case "\n   \t":
					case "\n  \t":
					case "\n \t":
					case "\n\t":
						p.text += "\n"
						p.pending = ""
						continue
					case "\n":
					case "\n ":
					case "\n  ":
					case "\n   ":
						p.pending = pending_with_char
						continue
					default:
						if (p.pending.length !== 0) {
							flush_text(p)
							end_token(p)
							p.pending = char
						} else {
							p.text += char
						}
						continue
				}
			case CODE_FENCE:
				switch (char) {
					case '`':
						/*  ```\n<code>\n``??
						|                 ^
						*/

						// 如果这一行已经有非空格字符了
						if (p.fence_line) break;

						p.pending = pending_with_char
						continue
					default:
						if (p.options.allowNestedCodeFence3 && p.pending && !p.fence_line && p.fence_start === 3) {
							const flag = p.pending.trim().length === p.fence_start;
							if (flag) p.fence_depth = (p.fence_depth || 0) + 1;
						}
						break;
					case '\n':
						/*  ```\n<code>\n```\n
						|                    ^
						*/
						const flag = pending_with_char.trim().length === p.fence_start;
						if (flag) {
							if (!p.fence_depth) {
								flush_text(p)
								end_token(p)
								p.pending = ""
								p.fence_start = 0
								p.fence_line = 0
								p.blockquote_depth = 0;
								p.blockquote_idx = 0;
								p.token = DOCUMENT;
								continue
							}
							p.fence_depth--;
						}
						p.blockquote_depth = p.blockquote_idx && p.tokens.filter(t => t === BLOCKQUOTE).length;
						p.token = NEWLINE
						break
					case ' ':
						/*  ```\n<code>\n ??
						|                ^  (space after newline is allowed)
						*/
						// 好像构成了什么化学反应，但是没出现bug？我看不懂
						if (p.pending[0] === '\n') {
							p.pending = pending_with_char
							p.fence_line += 1
							continue
						}
						break
				}

				// any other char
				p.text   += p.pending
				p.pending = char
				if (char.trim()) p.fence_line = 1
				continue
			case CODE_INLINE:
				let match;
				const backtick_count = p.fence_start;

				// (match = new RegExp(`(?:^|[^\`])\`{${backtick_count}}( )?$`).exec(p.pending))
				const fuckRegexp = () => {
					const s = p.pending;
					let i = s.length - 1;
					let right = 0;
					if (s[i] === ' ') {
						i--;
						right = 1;
					}
					for (let j = 0; j < backtick_count; j++) {
						if (s[i--] !== '`') return false;
					}

					if (s[i] === '`' && p.text) return false;
					return [
						s.substring(0, i),
						s.substring(i + backtick_count + 1)
					];
				};

				if (char === '`' || (match = fuckRegexp())) {
					// `[^`], 但是如果空格再多考虑一个字符
					if (p.pending && char !== '`') {
						const right = match[1];
						p.text += match[0].trimEnd();
						p.pending = "";

						flush_text(p);
						end_token(p);
						p.fence_start = 0;

						parser_write(p, right+char);
					} else {
						p.pending = pending_with_char;
					}

					continue
				}

				switch (char) {
					case '\n':
						p.text += p.pending
						p.pending = ""
						p.token = LINE_BREAK
						p.blockquote_idx = 0
						flush_text(p)
						continue
					/* Trim space before ` */
					case ' ':
						p.text += p.pending
						p.pending = char
						continue
					default:
						p.text += pending_with_char
						p.pending = ""
						continue
				}
			/* Checkboxes */
			case MAYBE_TASK:
				switch (p.pending.length) {
					case 0:
						if ('[' !== char) break // fail
						p.pending = pending_with_char
						continue
					case 1:
						if (' ' !== char && 'x' !== char) break // fail
						p.pending = pending_with_char
						continue
					case 2:
						if (']' !== char) break // fail
						p.pending = pending_with_char
						continue
					case 3:
						if (' ' !== char) break // fail
						p.renderer.add_token(CHECKBOX, p)
						if ('x' === p.pending[1]) {
							p.renderer.set_attr(CHECKED, "")
						}
						p.renderer.end_token(CHECKBOX, p);
						p.pending = " "
						continue
				}

				p.token = p.tokens.at(-1)
				p.pending = ""
				parser_write(p, pending_with_char)
				continue
			case STRONG_AST: {
				if ('*' === p.pending) {
					flush_text(p)
					/* **Bold**
							  ^
					*/
					if ('*' === char) {
						end_token(p)
						p.pending = ""
						continue
					}
					/* **Bold*Bold->Em*
							  ^
					*/
					if (/\S/.test(char)) {
						add_token(p, ITALIC_AST)
						p.pending = char
						continue
					}
				}

				break
			}
			case ITALIC_AST: {
				switch (p.pending) {
					case '*':
						if ('*' === char) {
							/* Decide between ***bold>em**em* and **bold*bold>em***
														 ^                       ^
							   With the help of the next character
							*/
							if (p.tokens.at(-2) === STRONG_AST) {
								p.pending = pending_with_char
							}
							/* *em**bold
								   ^
							*/
							else {
								flush_text(p)
								add_token(p, STRONG_AST)
								p.pending = ""
							}
						}
						/* *em*foo
							   ^
						*/
						else {
							if ('*' === '_' && /\S/.test(char)) {
								retractWithPrefix(p, '_', '');
								p.text = pending_with_char;
								p.pending = "";
							} else {
								flush_text(p)
								end_token(p)
								p.pending = char
							}

						}
						continue
					case '*'+'*':
						const italic = p.token
						flush_text(p)
						end_token(p)
						end_token(p)
						/* ***bold>em**em* or **bold*bold>em***
									   ^                      ^
						*/
						if ('*' !== char) {
							add_token(p, italic)
							p.pending = char
						} else {
							p.pending = ""
						}
						continue
				}
				break
			}
			case STRIKE:
				if ("~~" === pending_with_char) {
					flush_text(p)
					end_token(p)
					p.pending = ""
					continue
				}
				break
			case MAYBE_EQ_BLOCK:
				/*
				 \[?  or  $$?
				   ^        ^
				*/

				// [\n]$$\s?aaa\s?$$ or xx $$aa$$
				if (!get_last_char(p).trim()) {
					flush_text(p)
					add_token(p, EQUATION_BLOCK)
					p.eq_dollar = p.pending[0] === '$';
					p.pending = char;
					continue
				}

				p.text += p.pending;
				ignore(p, MAYBE_EQ_BLOCK);
				p.token = p.tokens.at(-1);
				break;
			case EQUATION_BLOCK:
				if ((p.eq_dollar ? "$$" : "\\]") === pending_with_char) {
					flush_text(p)
					end_token(p)
					p.pending = ""
					p.skipNextBr = 2;
					continue
				}
				break
			case EQUATION_INLINE:
				if (p.eq_dollar ? "$" === p.pending[0] : "\\)" === pending_with_char) {
					// 使用$时，前后都没有空格
					if (!p.eq_dollar || (!isSpaceLike(get_last_char(p)) && isValidLatexEnd(char))) {
						flush_text(p)
						end_token(p)

						p.pending = p.eq_dollar ? char : "";
						continue
					}

					retractWithPrefix(p, '$', '');
					ignore(p, EQUATION_INLINE);
				}
				break
			/* Raw URLs */
			case MAYBE_URL:
				if ("http://"  === pending_with_char ||
					"https://" === pending_with_char
				) {
					flush_text(p)
					add_token(p, RAW_URL)
					p.pending = pending_with_char
					p.text    = pending_with_char
				}
				else
				if ("http:/" [p.pending.length] === char ||
					"https:/"[p.pending.length] === char
				) {
					p.pending = pending_with_char
				}
				else {
					p.token = p.tokens.at(-1)
					parser_write(p, char)
				}
				continue
			case LINK:
			case IMAGE:
				if ("]" === p.pending) {
					/*
					[Link](url)
						 ^
					*/
					flush_text(p)
					if ('(' === char) {
						p.pending = pending_with_char
					} else {
						retractWithPrefix(p, INLINE_TOKEN_PREFIX.get(p.token), char);
					}
					continue
				}
				if (']' === p.pending[0] &&
					'(' === p.pending[1]
				) {
					/*
					[Link](url)
							  ^
					*/
					if (')' === char) {
						const type = p.token === LINK ? HREF : SRC
						const url = p.pending.slice(2)
						p.renderer.set_attr(type, url)
						end_token(p)
						p.pending = ""
					} else {
						if (char === "\n") {
							retractWithPrefix(p, INLINE_TOKEN_PREFIX.get(p.token), char);
						} else {
							p.pending += char
						}
					}
					continue
				}
				break
			case RAW_URL:
				/* http://example.com?
									 ^
				*/
				if (!URL_VALID_CHARS.test(char)) {
					p.renderer.set_attr(HREF, p.pending)
					flush_text(p)
					end_token(p)
					p.pending = char
				} else {
					p.text   += char
					p.pending = pending_with_char
				}
				continue
			case HTML_ATTR_VAL:
				if (p.tag_st === 2) {
					p.tag_st = 1;
					// escape
					switch (char) {
						case 'b': char = '\b'; break;
						case 'f': char = '\f'; break;
						case 'n': char = '\n'; break;
						case 'r': char = '\r'; break;
						case 't': char = '\t'; break;
					}
					p.pending += char;
					continue;
				} else {
					// noinspection FallThroughInSwitchStatementJS
					switch (char) {
						case '\\':
							const orig = p.tag_st;
							p.tag_st = 2;
							if (orig === 1) continue;
							// fallthrough: 强行结束不合法的属性

						case '"':
							if (!p.tag_st) {
								p.tag_st = 1;
								continue;
							}
							else p.tag_st = 0;

						case ' ':
						case '>':
							if (!p.tag_st) {
								p.renderer.set_attr(p.tag_attr, p.pending);
								p.pending = "";
								if (char === '>') endElement(p, pending_with_char);
								else p.token = HTML_ATTR;
								continue;
							}
					}
				}
				p.pending = pending_with_char;
				continue;
			case HTML_ATTR:
				switch (char) {
					default: p.pending = pending_with_char; break;
					case ' ': commitNoValueAttr(p); break;
					case '=':
						p.tag_attr = p.pending.trim();
						p.pending = '';
						p.token = HTML_ATTR_VAL;
						break;
					case '>':
						endElement(p, pending_with_char);
						break;
				}
				continue;
			case MAYBE_BR:
				let htmlTags = p.options.allowedTags;
				const pending = p.pending;
				if (htmlTags) {
					if (!(htmlTags instanceof Map)) {
						p.options.allowedTags = htmlTags = createTrieTree(htmlTags);
					}

					const END = pending[1] === "/" ? "/" : "";
					if (END) {
						const rest = pending.slice(2);
						if (htmlTags.has(rest)) {
							p.pending = pending_with_char;
							if (htmlTags.get(rest) && char === '>') {
								let nodeName;
								do {
									nodeName = closeHtmlTag(p);
								} while (nodeName && nodeName !== rest.toUpperCase());
								p.skipNextBr = 2;
								//end_tokens_to_len(p, 0);
							}
							continue;
						}
					} else {
						const rest = pending.slice(1);
						if (!pending || pending[0] === '<' && htmlTags.has(rest)) {
							p.pending = pending_with_char;

							const tag = htmlTags.get(rest);
							if (tag && /[ />]/.test(char)) {
								flush_text(p);
								p.pending = "";

								if (tag[0] === "!") {
									end_tokens_to_len(p, 0);
								} else {
									add_token(p, HTML_ELEMENT, tag);
									p.skipNextBr = 2;
									p.tag_id = tag;
									if (char !== '>') {
										p.token = HTML_ATTR;
									} else if (VOID_TAGS.has(tag)) {
										closeHtmlTag(p);
									}
								}
							}
							continue;
						}
					}
				}

				// Fail
				p.token = p.tokens.at(-1)
				p.text += p.pending[0];
				p.pending = p.pending.slice(1)
				parser_write(p, char)
				continue
		}

		/*
		Common checks
		*/
		switch (p.pending[0]) {
			/* Escape character */
			case '\\':
				if (p.token === IMAGE ||
					p.token === EQUATION_BLOCK ||
					p.token === EQUATION_INLINE)
					break

				switch (char) {
					case '(':
						flush_text(p)
						add_token(p, EQUATION_INLINE)
						p.eq_dollar = false;
						p.pending = ""
						continue
					case '[':
						p.token = MAYBE_EQ_BLOCK
						p.pending = pending_with_char
						continue
					case '\n':
						// Escaped newline has the same affect as unescaped one
						p.pending = char
						continue
					default:
						p.pending = ""
						//p.text +=  /[0-9A-Za-z]/.test(char) ? pending_with_char : char;
						p.text +=  /[$\\*]/.test(char) ? char : pending_with_char;
						continue
				}
			/* Newline */
			case '\n':
				delete p.ignored;

				switch (p.token) {
					case EQUATION_BLOCK:
						break
					case HEADING_1:
					case HEADING_2:
					case HEADING_3:
					case HEADING_4:
					case HEADING_5:
					case HEADING_6:
						flush_text(p)
						end_tokens_to_len(p, p.blockquote_idx)
						p.blockquote_idx = 0
						p.pending = char
						continue
					case EQUATION_INLINE:
						retractWithPrefix(p, p.eq_dollar ? '$' : '\\(', char);
						continue;
					case LINK:
					case IMAGE:
						retractWithPrefix(p, INLINE_TOKEN_PREFIX.get(p.token), char);
						continue;
					default:
						flush_text(p)
						p.pending = char
						p.token = LINE_BREAK;
						p.blockquote_idx = 0

						//delete p.prev_text;
						p.prev_text = "\n";
						continue
				}
				break
			/* <br> */
			case '<':
				if (p.token !== IMAGE &&
					p.token !== EQUATION_BLOCK &&
					p.token !== EQUATION_INLINE
				) {
					flush_text(p)
					p.pending = pending_with_char
					p.token = MAYBE_BR
					continue
				}
				break
			/* `Code Inline` */
			case '`':
				if (p.token === IMAGE) break

				if ('`' === char) {
					p.fence_start += 1
					p.pending = pending_with_char
				} else {
					p.fence_start += 1 // started at 0, and first wasn't counted
					flush_text(p)

					if (p.token === EQUATION_INLINE) {
						const pend = p.pending;
						p.pending = '';
						retractWithPrefix(p, '$', char);
						p.pending = pend;
					}

					add_token(p, CODE_INLINE)
					p.text = /\s/.test(char) ? "" : char // trim leading space
					p.pending = ""
				}
				continue
			case '"':
			case '“':
			case '”':
				if (p.token !== EQUATION_INLINE && p.token !== EQUATION_BLOCK && p.options.parseQuotes) {
					if (p.token === QUOTE) {
						p.text += p.pending;
						p.pending = "";
						flush_text(p);
						end_token(p);
					} else {
						flush_text(p);
						p.text += p.pending;
						p.pending = "";
						add_token(p, QUOTE);
					}
				}

				break;
			case '*': {
				if (p.token === IMAGE ||
					p.token === EQUATION_BLOCK ||
					p.token === EQUATION_INLINE ||
					p.token === STRONG_AST)
					break

				if (p.pending.length === 1) {
					/* **Strong**
						^
					*/
					if ('*' === char) {
						p.pending = pending_with_char
						continue
					}
					/* *Em*
						^
					*/
					if ('\n' !== char && ' ' !== char) {
						flush_text(p)
						add_token(p, ITALIC_AST);
						p.pending = char
						continue
					}
				} else {
					/* ***Strong->Em***
						 ^
					*/
					if ('*' === char) {
						flush_text(p)
						add_token(p, STRONG_AST)
						add_token(p, ITALIC_AST)
						p.pending = ""
						continue
					}
					/* **Strong**
						 ^
					*/
					if ('\n' !== char && ' ' !== char) {
						flush_text(p)
						add_token(p, STRONG_AST)
						p.pending = char
						continue
					}
				}

				break
			}
			case '~':
				if (p.token !== IMAGE &&
					p.token !== STRIKE
				) {
					if ("~" === p.pending) {
						/* ~~Strike~~
							^
						*/
						if ('~' === char) {
							p.pending = pending_with_char
							continue
						}
					} else {
						/* ~~Strike~~
						|    ^
						*/
						if (' ' !== char && '\n' !== char) {
							flush_text(p)
							add_token(p, STRIKE)
							p.pending = char
							continue
						}
					}
				}
				break
			/* $eq$ | $$eq$$ */
			case '$':
				if (p.token !== IMAGE &&
					p.token !== STRIKE &&
					"$" === p.pending &&
					!p.ignored?.has(EQUATION_INLINE)
				) {
					/* $$\sEQUATION_BLOCK\s$$
						^
					*/
					if ('$' === char && !p.ignored?.has(MAYBE_EQ_BLOCK) && ['\n', ''].includes(get_last_char(p))) {
						p.token = MAYBE_EQ_BLOCK
						p.pending = pending_with_char
						continue
					}
						/* $123
							^
						*/
						/*else if (/[0-9\p{P}]/u.test(char)) {
							break; // number check have been moved
						}*/
					/* $EQUATION_INLINE$
						^
					*/
					else if (isValidLatexBegin(get_last_char(p))/* && (!p.options.requiredSpaceAfterDollar || /\S/.test(char))*/) {
						flush_text(p)
						add_token(p, EQUATION_INLINE)
						p.eq_dollar = true;
						p.pending = char
						continue
					}
				}

				// 仅一次？
				p.ignored?.delete(EQUATION_INLINE);
				p.ignored?.delete(MAYBE_EQ_BLOCK);
				break
			/* [Image](url) */
			case '[':
				if (p.token !== IMAGE &&
					p.token !== LINK &&
					p.token !== EQUATION_BLOCK &&
					p.token !== EQUATION_INLINE &&
					']' !== char
				) {
					flush_text(p)
					add_token(p, LINK)
					p.pending = char
					continue
				}
				break
			/* ![Image](url) */
			case '!':
				if (p.token !== IMAGE && '[' === char) {
					flush_text(p)
					add_token(p, IMAGE)
					p.pending = ""
					continue
				}
				break
			/* Trim spaces */
			case ' ':
				if (p.pending.length === 1 && ' ' === char) {
					p.end_with_space = true;
					continue
				}
				if (char !== "\n") p.end_with_space = false;
				//else p.prev_text = '\n';
				break
			case '|':
				if (p.tokens.lastIndexOf(TABLE_ROW) > 0)
					retractWithPrefix(p, INLINE_TOKEN_PREFIX.get(p.token), char);
				break
		}

		/* foo http://...
		|      ^
		*/
		if (p.token !== IMAGE &&
			p.token !== LINK &&
			p.token !== EQUATION_BLOCK &&
			p.token !== EQUATION_INLINE &&
			p.token !== HTML_ELEMENT &&
			'h' === char &&
			(isSpaceLike(p.pending))
		) {
			p.text   += p.pending
			p.pending = char

			p.token = MAYBE_URL
			continue
		}

		/*
		No check hit
		*/
		p.text += p.pending
		p.pending = char
	}

	if (p.options.stream) flush_text(p)
}

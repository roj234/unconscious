import postcss from "postcss";
import picomatch from "picomatch";
import {createMatcher} from "../src/index.js";

const WORD = /[A-Za-z0-9:/_-]+(?<!:)/g;

// 选择器列表 → [{ selector, tokens }]，selector 是原文片段，便于按逗号删改。顶层逗号分叉；
// :not(...) 及"参数不是选择器"的伪类整段丢弃。
const IDENT = /(?:[-\w\u0080-\uffff]|\\[0-9a-fA-F]{1,6}[ \t\n\r\f]?|\\[\s\S])+/y;
const STRING = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/sy;
const NAME = 0, AFTER_NAME = 1, AFTER_OP = 2, AFTER_VALUE = 3;   // 属性选择器状态
// 参数是值/An+B/名字而非选择器的伪类：整段丢弃。否则 :nth-child(2n+1) 会要求构建里存在 "2n" "1"
const VALUE_ARG = new Set(['not', 'lang', 'dir', 'state', 'part', 'highlight', 'nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type', 'nth-col', 'nth-last-col']);

const isSpace = (c) => ' \t\n\r\f'.includes(c);
const isName = (c) => /[-\w\u0080-\uffff]/.test(c);
const read = (re, s, i) => (re.lastIndex = i, re.exec(s))?.[0] ?? '';
const unesc = (s) => s.replace(/\\(\r\n|[\n\r\f])|\\([0-9a-fA-F]{1,6})\s?|\\([\s\S])/g,
	(m, nl, hex, ch) => nl !== undefined ? '' : hex ? String.fromCodePoint(Math.min(parseInt(hex, 16) || 0xfffd, 0x10ffff)) : ch);

/**
 *
 * @param {string} list
 * @return {{ selector: string, tokens: string[] }[]}
 */
function parseSelector(list) {
	const out = [], frames = [];       // frames: 每一层 '(' 是否属于 DROP 类伪类
	let cur = [], start = 0, depth = 0, skip = 0, attr = -1, i = 0;
	const flush = (end) => {                                  // end = 逗号位置（或末尾）
		const selector = list.slice(start, end).trim();
		if (selector) out.push({selector, tokens: cur});
		cur = [];
		start = end + 1;
	};

	while (i < list.length) {
		const c = list[i];
		const str = c === '"' || c === "'" ? read(STRING, list, i) : '';

		if (str) {
			if (!skip && attr === AFTER_OP) {
				const retokenized = [...unesc(str.slice(1, -1)).matchAll(WORD)].flat();
				cur.push(...retokenized);
				attr = AFTER_VALUE;
			}
			i += str.length;
		} else if (c === '(') {
			frames.push(false);
			depth++;
			i++;
		} else if (c === ')') {
			if (frames.pop()) skip--;
			depth = Math.max(0, depth - 1);
			i++;
		} else if (skip) {
			i++;                                 // :not() 内部：连 ')' 以外的字符都不要
		} else if (c === ',') {
			if (depth === 0) flush(i);                            // 只有顶层逗号才分叉
			i++;
		} else if (c === '[') {
			attr = NAME;
			i++;
		} else if (attr >= 0) {                                 // ---- 属性选择器 ----
			if (isSpace(c)) i++;
			else if (c === ']') {
				attr = -1;
				i++;
			} else if (c === '|' && attr <= AFTER_NAME) {
				attr = NAME;
				i++;
			} else if (c === '=') {
				attr = AFTER_OP;
				i++;
			} else if ('~^$*'.includes(c) && list[i + 1] === '=') {
				attr = AFTER_OP;
				i += 2;
			} else if (isName(c) || c === '\\') {
				const id = read(IDENT, list, i);
				i += id.length;
				if (attr === NAME) {
					cur.push(unesc(id));
					attr = AFTER_NAME;
				} else if (attr === AFTER_OP) {
					cur.push(unesc(id));
					attr = AFTER_VALUE;
				}
				// AFTER_VALUE 的 i / s flag 直接丢掉
			} else i++;
		} else if (c === ':') {                                 // ---- 伪类 / 伪元素 ----
			i += list[i + 1] === ':' ? 2 : 1;
			const name = read(IDENT, list, i).toLowerCase();
			i += name.length;
			if (list[i] === '(') {
				const drop = VALUE_ARG.has(name);
				frames.push(drop);
				depth++;
				if (drop) skip++;
				i++;
			}
		} else if (isName(c) || c === '\\') {                   // ---- 类型/class/id ----
			const id = read(IDENT, list, i);
			cur.push(unesc(id));
			i += id.length;
		} else i++;                                             // . # > + ~ * | & 等
	}
	flush(list.length);
	return out;
}

/**
 * Removes every selector that is not used in `words`.
 * @param {string} css
 * @param {Set<string>} words
 * @param {function(string): boolean} safelist
 * @param {string} filenameForDebug
 * @returns {string}
 */
export function purgeCSS(css, words, safelist, filenameForDebug) {
	const root = postcss.parse(css);
	let ignore = false;

	root.walk((node) => {
		if (node.type === "comment") {
			if (node.text.includes("purgecss start ignore")) {
				ignore = true;
				node.remove();
			} else if (node.text.includes("purgecss end ignore")) {
				ignore = false;
				node.remove();
			}
			return;
		}
		if (node.type !== "rule" || ignore) return;
		const previous = node.prev();
		if (previous && previous.type === "comment" && previous.text.includes("purgecss ignore")) {
			previous.remove();
			return;
		}
		const parent = node.parent;
		// keyframe steps (`from`, `50%`) are never purged
		if (parent && parent.type === "atrule" && parent.name.endsWith("keyframes")) return;
		let frozen = false;
		node.walkComments((comment) => {
			if (comment.text.includes("purgecss ignore current")) {
				frozen = true;
				comment.remove();
			}
		});
		if (frozen) return;

		let changed = false;
		const kept = [];
		for (const {tokens, selector} of parseSelector(node.selector)) {
			let all = true;
			for (const token of tokens) {
				if (!words.has(token)) all = false;
				if (safelist(token)) {
					all = true;
					break;
				}
			}

			if (!all) changed = true;
			else kept.push(selector);
		}
		if (!changed) return;

		if (filenameForDebug && !node.selector.startsWith(".ri-")) console.log(`[purgecss] ${filenameForDebug}: ${node.selector} =>`, kept);

		const container = node.parent;

		if (kept.length) node.selector = kept.join(",");
		else node.remove();

		if (container && container.type !== "root" && !container.nodes?.length) container.remove();
	});
	return root.toString();
}

const TD = new TextDecoder('utf8', {fatal: true});
const toText = (source) => typeof source === "string" ? source : source ? TD.decode(source) : "";

/**
 * @param {{includes?: string|string[], excludes?: string|string[], safelist?: (string|RegExp)[], debug?: boolean}} [options]
 * @returns {import("rollup").Plugin}
 */
export default (options = {}) => {
	const {includes = "**", excludes = [], safelist = [], debug} = options;
	const include = picomatch(includes);
	const excluded = excludes.length ? picomatch(excludes) : () => false;
	let html = "";

	return {
		name: "@roj234/purgecss",
		enforce: "post",
		transformIndexHtml(content) {
			html += content;
		},
		generateBundle(_options, bundle) {
			const entries = Object.entries(bundle);

			let content = html;
			html = "";

			for (const [file, chunk] of entries) {
				if (/\.(css|woff2?|ttf)$/i.test(file) || !include(file) || excluded(file)) continue;
				try {
					content += "\n" + (typeof chunk.code === "string" ? chunk.code : toText(chunk.source));
				} catch {
				}
			}

			const sl = createMatcher(safelist ?? []);
			const words = new Set();
			WORD.lastIndex = 0;
			let exec;
			while ((exec = WORD.exec(content))) words.add(exec[0]);

			for (const [file, chunk] of entries) {
				if (!file.endsWith(".css") || excluded(file)) continue;
				chunk.source = purgeCSS(toText(chunk.source), words, sl, debug ? file : null);
			}
		},
	};
};

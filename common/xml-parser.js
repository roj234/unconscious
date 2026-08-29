/*
 * Standalone Streaming XML Parser
 */

const VOID_TAGS = /*#__PURE__*/ new Set(["area","base","br","col","embed","hr","img","input","link","meta","source","track","wbr"]);
const TEXT_TAGS = /*#__PURE__*/ new Set(["style","script","textarea"]);

// ── Node type constants ──────────────────────────────────────────
export const ELEMENT = 'element';
export const TEXT    = 'text';
export const COMMENT = 'comment';
export const CDATA   = 'cdata';
export const PI      = 'pi';

// ── Internal state constants ─────────────────────────────────────
const $TEXT           = 0;
const $LT             = 1;   // saw '<'
const $TAG_NAME       = 2;   // reading opening tag name
const $CLOSE_TAG      = 3;   // reading closing tag name (after '</')
const $ATTR_NAME      = 4;   // reading attribute name
const $ATTR_BEFORE_VAL= 5;   // saw '=', waiting for quote
const $ATTR_VAL       = 6;   // reading quoted attribute value
const $COMMENT        = 7;   // inside <!-- -->
const $CDATA          = 8;   // inside <![CDATA[
const $PI             = 9;   // inside <?...?>
const $DOCTYPE        = 10;  // inside <!DOCTYPE...>
const $SELF_CLOSING   = 11;  // saw '/' in tag, waiting for '>'
const $TEXT_TAG_END   = 12;

// Character classification
const isWhitespace = c => c === ' ' || c === '\t' || c === '\r' || c === '\n';
const isNameStart  = c => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === ':';
const isNameChar   = c => isNameStart(c) || (c >= '0' && c <= '9') || c === '-' || c === '.';

// ── Entity decoding ──────────────────────────────────────────────
const ENTITIES = {
	'amp':  '&',
	'lt':   '<',
	'gt':   '>',
	'quot': '"',
	'apos': "'",
};

function decodeEntity(src, start, end) {
	const body = src.slice(start, end);
	if (body[0] === '#') {
		const codepoint = body[1] === 'x' || body[1] === 'X'
			? parseInt(body.slice(2), 16)
			: parseInt(body.slice(1), 10);
		return String.fromCodePoint(codepoint);
	}
	const c = ENTITIES[body];
	return c !== undefined ? c : src.slice(start - 1, end + 1);
}

function decodeText(text) {
	let i = -1, out = '', last = 0;
	while ((i = text.indexOf('&', i + 1)) !== -1) {
		const semi = text.indexOf(';', i + 1);
		if (semi === -1) break;
		out += text.slice(last, i);
		out += decodeEntity(text, i + 1, semi);
		last = semi + 1;
		i = semi;
	}
	return out + text.slice(last);
}

// ── State machine ────────────────────────────────────────────────

/**
 * Create a streaming XML parser.
 *
 * @param {Object} handlers
 * @param {Function} handlers.onOpenTag  - (name, attrs, isSelfClosing) => void
 * @param {Function} handlers.onCloseTag - (name) => void
 * @param {Function} handlers.onText     - (text) => void
 * @param {Function} handlers.onComment  - (text) => void
 * @param {Function} handlers.onPI       - (target, data) => void
 * @param {Function} handlers.onCData    - (text) => void
 * @param {Object}  [options]
 * @param {boolean} [options.decodeEntities=true]
 * @param {boolean} [options.html=false]
 * @param {Set<string>} [options.voidTags]
 * @param {Set<string>} [options.textTags]
 * @returns {{ write: Function, end: Function }}
 */
export function createXmlParser(handlers, options = {}) {
	const decode = options.decodeEntities !== false;
	const isHTML = options.html;
	const voidTags = isHTML ? VOID_TAGS : options.voidTags;
	const textTags = isHTML ? TEXT_TAGS : options.textTags;

	let pos = 0;

	const FAIL = (exc, char) => {
		throw new Error("Excepting "+exc+" but got "+JSON.stringify(char)+" at index "+pos);
	}

	// State
	let state      = $TEXT;
	let pending    = '';       // accumulated partial token
	let tagName    = '';       // current tag name
	let attrName   = '';       // current attribute name
	let attrVal    = '';       // current attribute value
	let attrs      = null;     // Object.create(null) for current tag
	let quoteChar  = '';       // quote character for attr value (' or ")
	let selfClosing= false;    // is current tag self-closing?
	let textBuf    = '';       // accumulated text content
	let textBufLength            = 0;

	// Stack for nested tags (to validate close tag names if needed)
	let tagStack   = [];

	const emitText = () => {
		if (textBuf) {
			const t = decode ? decodeText(textBuf) : textBuf;
			handlers.onText(t);
			textBuf = '';
		}
	};

	const openTag = () => {
		emitText();
		if (tagName[0] === '!') {
			// DOCTYPE — silently skip
		} else {
			if (isHTML) tagName = tagName.toLowerCase();
			if (voidTags?.has(tagName)) selfClosing = true;

			handlers.onOpenTag(tagName, attrs || createAttrs(), selfClosing);
			if (selfClosing) {
				handlers.onCloseTag(tagName);
			} else {
				tagStack.push(tagName);
			}
		}
		attrs = null;
		tagName = '';
		selfClosing = false;
	};

	const closeTag = () => {
		emitText();
		if (tagName) {
			// Pop stack to find matching open tag
			for (let i = tagStack.length - 1; i >= 0; i--) {
				if (tagStack[i] === tagName) {
					// Close all tags up to and including this one
					while (tagStack.length > i) {
						handlers.onCloseTag(tagStack.pop());
					}
					break;
				}
			}
		}
		tagName = '';
	};

	const commitAttr = () => {
		if (!attrs) attrs = createAttrs();
		if (isHTML) attrName = attrName.toLowerCase();
		attrs[attrName] = decode ? decodeText(attrVal) : attrVal;
		attrName = '';
		attrVal = '';
	};

	const commitBooleanAttr = () => {
		if (attrName) {
			if (!attrs) attrs = createAttrs();
			if (isHTML) attrName = attrName.toLowerCase();
			attrs[attrName] = true;
			attrName = '';
		}
	};

	const processChar = (char) => {
		switch (state) {

			// ── TEXT ──────────────────────────────────────────
			case $TEXT:
				const closeTagName = tagStack.at(-1);
				const b = textTags?.has(closeTagName);
				if (!b && char === '<') {
					state = $LT;
				} else {
					textBuf += char;
					let ss;
					if (b && textBuf.endsWith(ss = "</"+closeTagName)) {
						state = $TEXT_TAG_END;
						textBufLength = textBuf.length - ss.length;
					}
				}
				break;
			case $TEXT_TAG_END:
				if (isWhitespace(char)) {
					textBuf += char;
				} else {
					if (char === '>') {
						textBuf = textBuf.slice(0, textBufLength);
						tagName = tagStack.at(-1);
						closeTag();
					}
					state = $TEXT;
				}
				break;

			// ── LT (just saw '<') ─────────────────────────────
			case $LT:
				if (char === '/') {
					state = $CLOSE_TAG;
					tagName = '';
				} else if (char === '!') {
					pending = '<!';
					state = $DOCTYPE; // tentative; will re-dispatch
				} else if (char === '?') {
					state = $PI;
					tagName = '?';
					pending = '';
				} else if (isNameStart(char)) {
					state = $TAG_NAME;
					tagName = char;
				} else {
					// Not a valid tag — treat as text
					textBuf += '<' + char;
					state = $TEXT;
				}
				break;

			// ── TAG_NAME ──────────────────────────────────────
			case $TAG_NAME:
				if (isNameChar(char)) {
					tagName += char;
				} else if (isWhitespace(char)) {
					state = $ATTR_NAME;
				} else if (char === '>') {
					openTag();
					state = $TEXT;
				} else if (char === '/') {
					selfClosing = true;
					state = $SELF_CLOSING;
				} else {
					FAIL("NAME", char);
				}
				break;

			// ── CLOSE_TAG ─────────────────────────────────────
			case $CLOSE_TAG:
				if (isNameChar(char)) {
					tagName += char;
				} else if (isWhitespace(char)) {
					// skip whitespace inside </tag >
				} else if (char === '>') {
					closeTag();
					state = $TEXT;
				} else {
					FAIL("NAME", char);
				}
				break;

			// ── ATTR_NAME ─────────────────────────────────────
			case $ATTR_NAME:
				if (isNameChar(char)) {
					attrName += char;
				} else if (char === '=') {
					state = $ATTR_BEFORE_VAL;
				} else if (isWhitespace(char)) {
					commitBooleanAttr();
				} else if (char === '>') {
					commitBooleanAttr();
					openTag();
					state = $TEXT;
				} else if (char === '/') {
					commitBooleanAttr();
					selfClosing = true;
					state = $SELF_CLOSING;
				} else {
					FAIL("NAME", char);
				}
				break;

			// ── ATTR_BEFORE_VAL ───────────────────────────────
			case $ATTR_BEFORE_VAL:
				if (char === '"' || char === "'") {
					quoteChar = char;
					attrVal = '';
					state = $ATTR_VAL;
				} else if (!isWhitespace(char)) {
					// Unquoted attribute value
					attrVal = char;
					quoteChar = '';
					state = $ATTR_VAL;
				}
				// skip whitespace between = and value
				break;

			// ── ATTR_VAL ──────────────────────────────────────
			case $ATTR_VAL:
				if (quoteChar) {
					// Quoted value
					if (char === quoteChar) {
						commitAttr();
						state = $ATTR_NAME;
					} else {
						attrVal += char;
					}
				} else {
					// Unquoted value
					if (isWhitespace(char)) {
						commitAttr();
						state = $ATTR_NAME;
					} else if (char === '>') {
						commitAttr();
						openTag();
						state = $TEXT;
					} else if (char === '/') {
						commitAttr();
						selfClosing = true;
						state = $SELF_CLOSING;
					} else {
						attrVal += char;
					}
				}
				break;

			// ── SELF_CLOSING ──────────────────────────────────
			case $SELF_CLOSING:
				if (char === '>') {
					openTag();
					state = $TEXT;
				}
				// ignore other chars (whitespace)
				break;

			// ── DOCTYPE / COMMENT / CDATA dispatch ────────────
			case $DOCTYPE:
				pending += char;
				if (pending === '<!--') {
					emitText();
					state = $COMMENT;
					pending = '';
				} else if (pending === '<![CDATA[') {
					emitText();
					state = $CDATA;
					pending = '';
				} else if (pending.length >= 9 && pending.startsWith('<!DOCTYPE')) {
					// DOCTYPE — read until '>'
					if (char === '>') {
						// Emit nothing (or could emit doctype event)
						pending = '';
						state = $TEXT;
					}
				} else if (char === '>') {
					// Unknown <!...> — skip
					pending = '';
					state = $TEXT;
				}
				break;

			// ── COMMENT ───────────────────────────────────────
			case $COMMENT:
				pending += char;
				if (pending.endsWith('-->')) {
					const comment = pending.slice(0, -3);
					handlers.onComment?.(comment);
					pending = '';
					state = $TEXT;
				}
				break;

			// ── CDATA ─────────────────────────────────────────
			case $CDATA:
				pending += char;
				if (pending.endsWith(']]>')) {
					const cdata = pending.slice(0, -3);
					handlers.onCData?.(cdata);
					pending = '';
					state = $TEXT;
				}
				break;

			// ── PI (processing instruction) ───────────────────
			case $PI:
				pending += char;
				if (pending.endsWith('?>')) {
					const content = pending.slice(0, -2).trim();
					// Split into target and data
					const spaceIdx = content.indexOf(' ');
					let target, data;
					if (spaceIdx === -1) {
						target = content;
						data = '';
					} else {
						target = content.slice(0, spaceIdx);
						data = content.slice(spaceIdx + 1);
					}
					handlers.onPI?.(target, data);
					pending = '';
					state = $TEXT;
				}
				break;

			default:
				FAIL("VALUE", char);
		}
	};

	return {
		/**
		 * Feed a chunk of XML text to the parser.
		 * @param {string} chunk
		 */
		write(chunk) {
			for (let i = 0; i < chunk.length; i++) {
				processChar(chunk[i]);
				pos++;
			}
		},

		/**
		 * Signal end of input. Flushes any pending text.
		 */
		end() {
			emitText();
			// Close any remaining open tags (tolerant)
			while (tagStack.length) {
				handlers.onCloseTag(tagStack.pop());
			}
		},

		/**
		 * Returns current open tag stack (for debugging).
		 * @returns {string[]}
		 */
		getStack() {
			return tagStack.slice();
		},
	};
}

// ── Tree builder ─────────────────────────────────────────────────

const proto = Object.create(null);
proto.toString = function() {return JSON.stringify(this)};

const createAttrs = () => Object.create(proto);

/** @typedef {{ type:'element', name:string, attrs:Record<string,string>, children:Node[] }} ElementNode */
/** @typedef {{ type:'text', content:string }} TextNode */
/** @typedef {{ type:'comment', content:string }} CommentNode */
/** @typedef {{ type:'cdata', content:string }} CDataNode */
/** @typedef {{ type:'pi', target:string, data:string }} PINode */
/** @typedef {ElementNode|TextNode|CommentNode|CDataNode|PINode} XmlNode */

/**
 * Parse an XML string into a tree of plain-object nodes.
 *
 * @param {string} xml
 * @param {Object} [options]
 * @param {boolean} [options.decodeEntities=true]
 * @param {boolean} [options.includePI=false]    - include <?...?> nodes
 * @param {boolean} [options.includeComments=false]
 * @returns {ElementNode} root element
 */
export function parseXmlToTree(xml, options = {}) {
	const root = { type: ELEMENT, name: '#root', attrs: createAttrs(), children: [] };
	const stack = [root];
	const includePI = options.includePI;
	const includeComments = options.includeComments;

	const parser = createXmlParser({
		onOpenTag(name, attrs, isSelfClosing) {
			const el = { type: ELEMENT, name, attrs: attrs, children: [] };
			stack[stack.length - 1].children.push(el);
			if (!isSelfClosing) {
				stack.push(el);
			}
		},
		onCloseTag(name) {
			// Only pop if the closing tag matches the current stack top.
			// Self-closing tags emit onCloseTag but were never pushed,
			// so this guard prevents over-popping.
			if (stack.length > 1 && stack[stack.length - 1].name === name) {
				stack.pop();
			}
		},
		onText(text) {
			if (text) {
				stack[stack.length - 1].children.push({ type: TEXT, content: text });
			}
		},
		onComment(text) {
			if (includeComments) {
				stack[stack.length - 1].children.push({ type: COMMENT, content: text });
			}
		},
		onPI(target, data) {
			if (includePI) {
				stack[stack.length - 1].children.push({ type: PI, target, data });
			}
		},
		onCData(text) {
			stack[stack.length - 1].children.push({ type: CDATA, content: text });
		},
	}, options);

	parser.write(xml);
	parser.end();

	// If there's exactly one child element, return it; otherwise return root
	if (root.children.length === 1 && root.children[0].type === ELEMENT) {
		return root.children[0];
	}
	return root;
}

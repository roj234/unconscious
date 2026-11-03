import {immutableObjectMap} from "@roj234/shared/objects";
import {ANSI_SEQ} from "./seq.js";


const fg = 0, bg = 1, bold = 2, dim = 3, italic = 4;
const underline = 5, blink = 6, inverse = 7, hidden = 8;
const strike = 9;

// 16-color palette
const palette16 = [
	'#000000', '#ff5454', '#7ed321', '#ffd54f',
	'#5b9bd5', '#9b6ba3', '#42d4d4', '#e0e0e0',
	'#7f7f7f', '#ff7777', '#a5e85b', '#ffe066',
	'#7fbdf3', '#b388c4', '#6ee6e6', '#f5f5f5',
];

// 256-color palette (16 + 6x6x6 cube + 24 grayscale).
const palette256 = (() => {
	const p = new Array(256);
	for (let i = 0; i < 16; i++) p[i] = palette16[i];
	const v = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff];
	for (let i = 0; i < 216; i++) {
		const r = v[Math.floor(i / 36)];
		const g = v[Math.floor((i % 36) / 6)];
		const b = v[i % 6];
		p[16 + i] = `rgb(${r},${g},${b})`;
	}
	for (let i = 0; i < 24; i++) {
		const g = 8 + i * 10;
		p[232 + i] = `rgb(${g},${g},${g})`;
	}
	return p;
})();

const map = immutableObjectMap({
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;'
});
const escapeHtml = s => s.replace(/[&<>"]/gm, (str) => map[str]);

// Strip trailing punctuation that almost certainly isn't part of the URL.
// Handles balanced brackets so URLs like wiki/C_(lang)) keep their `)`.
function stripTrailingPunct(url) {
	let s = url;
	while (/[.,;:!?]+$/.test(s)) s = s.slice(0, -1);
	const pairs = [['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']];
	for (const [open, close] of pairs) {
		while (s.endsWith(close)) {
			const inner = s.slice(0, -1);
			let bal = 0;
			for (const ch of inner) {
				if (ch === open) bal++;
				else if (ch === close) bal--;
			}
			if (bal > 0) break; // opener is present, keep closer
			s = inner;
		}
	}
	while (/["']$/.test(s)) s = s.slice(0, -1);
	return s;
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'\x00-\x1f]+/gi;

const renderLinks = text => {
	let out = '';
	let last = 0;
	URL_RE.lastIndex = 0;
	let m;
	while ((m = URL_RE.exec(text)) !== null) {
		const full = m[0];
		const start = m.index;
		const url = stripTrailingPunct(full);
		if (url.length === 0) {
			// pathologically stripped; treat the whole match as plain text
			last = start + full.length;
			continue;
		}
		if (start > last) out += escapeHtml(text.slice(last, start));
		out += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`;
		last = start + url.length;
		// Trailing punctuation between `last` and the end of `full` will be
		// emitted as text on the next iteration (or the final slice below).
	}
	if (last < text.length) out += escapeHtml(text.slice(last));
	return out;
};

// Read a complete ANSI escape sequence starting at index i.
// Returns the sequence string, or null if the sequence is incomplete
// (e.g. truncated at end of input). Recognises CSI, OSC, DCS/SOS/PM/APC,
// and 2-byte / intermediate escape sequences.
function readEscape(s, i) {
	ANSI_SEQ.lastIndex = i;
	return ANSI_SEQ.exec(s)?.[0];
}

/**
 * Apply SGR (Select Graphic Rendition) parameter string to `state`.
 * @param params
 * @param {Array} state
 */
function applySGR(params, state) {
	let parts;
	if (params === '' || params == null) parts = [0];
	else parts = params.split(';').map((x) => parseInt(x, 10) || 0);

	let i = 0;
	while (i < parts.length) {
		const code = parts[i];
		switch (code) {
			case 0: state.fill(null); break;
			case 1: state[bold] = true; break;
			case 2: state[dim] = true; break;
			case 3: state[italic] = true; break;
			case 4: state[underline] = true; break;
			case 5: state[blink] = true; break;
			case 7: state[inverse] = true; break;
			case 8: state[hidden] = true; break;
			case 9: state[strike] = true; break;
			case 22: state[bold] = false; state[dim] = false; break;
			case 23: state[italic] = false; break;
			case 24: state[underline] = false; break;
			case 25: state[blink] = false; break;
			case 27: state[inverse] = false; break;
			case 28: state[hidden] = false; break;
			case 29: state[strike] = false; break;
			case 30: case 31: case 32: case 33: case 34: case 35: case 36: case 37:
				state[fg] = palette16[code - 30]; break;
			case 38:
				if (parts[i + 1] === 5) {
					state[fg] = palette256[parts[i + 2]] || palette256[0];
					i += 2;
				} else if (parts[i + 1] === 2) {
					state[fg] = `rgb(${parts[i + 2]},${parts[i + 3]},${parts[i + 4]})`;
					i += 4;
				}
				break;
			case 39: state[fg] = null; break;
			case 40: case 41: case 42: case 43: case 44: case 45: case 46: case 47:
				state[bg] = palette16[code - 40]; break;
			case 48:
				if (parts[i + 1] === 5) {
					state[bg] = palette256[parts[i + 2]] || palette256[0];
					i += 2;
				} else if (parts[i + 1] === 2) {
					state[bg] = `rgb(${parts[i + 2]},${parts[i + 3]},${parts[i + 4]})`;
					i += 4;
				}
				break;
			case 49: state[bg] = null; break;
			case 90: case 91: case 92: case 93: case 94: case 95: case 96: case 97:
				state[fg] = palette16[8 + code - 90]; break;
			case 100: case 101: case 102: case 103: case 104: case 105: case 106: case 107:
				state[bg] = palette16[8 + code - 100]; break;
			default: break; // ignore unknown
		}
		i++;
	}
}

/**
 *
 * @param {Array} state
 * @return {string}
 */
const styleString = state => {
	const parts = [];
	if (state[bold]) parts.push('font-weight:bold');
	if (state[dim]) parts.push('opacity:0.6');
	if (state[italic]) parts.push('font-style:italic');
	const deco = [];
	if (state[underline]) deco.push('underline');
	if (state[strike]) deco.push('line-through');
	if (state[blink]) deco.push('blink');
	if (deco.length) parts.push('text-decoration:'+deco.join(' '));
	let fg_ = state[fg], bg_ = state[bg];
	if (state[inverse]) { const t = fg_; fg_ = bg_; bg_ = t; }
	if (fg_) parts.push('color:' + fg_);
	if (bg_) parts.push('background-color:' + bg_);
	if (state[hidden]) parts.push('visibility:hidden');
	return parts.join(';');
};

/**
 * Convert a string containing ANSI escape sequences to HTML.
 * - Only process SGR part.
 */
export function ansiToHtml(s) {
	const state = Array(strike+1);

	let out = '';
	let pending = '';
	let spanOpen = false;

	const openTag = () => {
		const st = styleString(state);
		if (st) { out += `<span style="${st}">`; spanOpen = true; }
	};
	const closeTag = () => {
		if (pending) {
			out += renderLinks(pending);
			pending = '';
		}
		if (spanOpen) { out += '</span>'; spanOpen = false; }
	};

	let i = 0;
	while (true) {
		const next = s.indexOf('\x1b', i);
		let seq;

		// silently remove incomplete ANSI seq
		if (next === -1 || (seq = readEscape(s, next)) == null) {
			pending += s.slice(i);
			break;
		}

		pending += s.slice(i, next);

		// Only handle SGR
		if (seq.charCodeAt(1) === 0x5b /* [ */ &&
			seq.charCodeAt(seq.length - 1) === 0x6d /* m */) {
			applySGR(seq.slice(2, -1), state);
			closeTag();
			openTag();
		}

		i = next + seq.length;
	}

	closeTag();
	return out;
}

export default ansiToHtml;

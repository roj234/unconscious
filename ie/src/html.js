const TAG_RE = /<(script|link)\b([^>]*?)\/?>/gi;

/**
 * 替换 html 里的 <script> / <link> 标签
 */
export function transformTags(html, cb) {
	let out = '';
	let last = 0;
	let m;
	TAG_RE.lastIndex = 0;
	while ((m = TAG_RE.exec(html))) {
		const r = cb(m[1].toLowerCase(), m[2], m[0]);
		if (r == null) continue;
		out += html.slice(last, m.index) + r;
		last = m.index + m[0].length;
		if (m[1].toLowerCase() === 'script' && !m[0].endsWith("/>")) {
			const closing = html.indexOf("</script>", last);
			if (closing >= 0) TAG_RE.lastIndex = last = closing+9;
		}
	}
	return out + html.slice(last);
}

export function attr(attrs, name) {
	const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
	const m = attrs.match(re);
	return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

export const hasAttr = (attrs, name) => new RegExp(`(?:^|\\s)${name}(?:\\s*=|\\s|$)`, 'i').test(attrs);

export async function applyHtmlTransforms(plugins, html, ctx) {
	for (const p of plugins) {
		const r = await p.transformIndexHtml?.call(p, html, ctx);
		if (r != null) html = r;
	}
	return html;
}

import path from 'node:path';
import fsp from 'node:fs/promises';
import postcss from 'postcss';
import {isFile} from './utils.js';
import {getContentType} from "../utils/mimeTypes.js";

const URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/g;
const IMPORT_RE = /@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)')(?:\s*\))?\s*;/g;

async function inlineImports(code, file, ctx, depth = 0) {
	if (depth > 8) return code;
	const parts = [];
	let last = 0;
	let m;
	IMPORT_RE.lastIndex = 0;
	while ((m = IMPORT_RE.exec(code))) {
		const raw = m[1] ?? m[2];
		const clean = raw.split(/[?#]/)[0];
		const abs = clean.startsWith('/') ? path.join(ctx.root, clean) : path.resolve(path.dirname(file), clean);
		if (!abs.endsWith('.css') || !isFile(abs)) continue;
		const inner = await inlineImports(await fsp.readFile(abs, 'utf8'), abs, ctx, depth + 1);
		parts.push(code.slice(last, m.index), `\n${inner}\n`);
		last = m.index + m[0].length;
	}
	return last === 0 ? code : parts.join('') + code.slice(last);
}

/** 把 CSS 里的 url() 换成构建产物地址（构建期），并把小文件内联成 data URL */
async function rewriteUrls(code, file, ctx, pluginCtx) {
	const inlineLimit = ctx.config.build.assetsInlineLimit ?? 4096;
	const jobs = [];
	let m;
	URL_RE.lastIndex = 0;
	while ((m = URL_RE.exec(code))) {
		const raw = m[1] ?? m[2] ?? m[3];
		if (!raw || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|data:)/i.test(raw)) continue;
		const [clean, qs] = raw.split(/(?=[?#])/);
		const abs = clean.startsWith('/') ? path.join(ctx.root, clean) : path.resolve(path.dirname(file), clean);
		if (!isFile(abs)) continue;
		jobs.push({start: m.index, end: m.index + m[0].length, abs, suffix: qs || ''});
	}
	if (!jobs.length) return code;

	let out = '';
	let last = 0;
	for (const job of jobs) {
		const source = await fsp.readFile(job.abs);
		const url = source.length <= inlineLimit
			? `data:${getContentType(job.abs)};base64,${source.toString('base64')}`
			: ctx.assetUrl(pluginCtx, job.abs, source);
		out += code.slice(last, job.start) + `url(${JSON.stringify(url + job.suffix)})`;
		last = job.end;
	}
	return out + code.slice(last);
}

/**
 * @param {string} code
 * @param {string} file 绝对路径
 * @param {object} ctx 构建上下文
 * @param {object} [pluginCtx] 只有构建期需要（emitFile）
 */
export async function processCss(code, file, ctx, pluginCtx) {
	const build = !!pluginCtx;
	if (build) code = await inlineImports(code, file, ctx);

	const plugins = ctx.config.css?.postcss?.plugins;
	if (plugins?.length) {
		const result = await postcss(plugins).process(code, {from: file, map: false});
		code = result.css;
	}
	if (build) code = await rewriteUrls(code, file, ctx, pluginCtx);
	return code;
}


import fs from 'node:fs';
import crypto from 'node:crypto';
import {isPureObject} from "@roj234/shared";

export const toPosix = p => p.replace(/\\/g, '/');
export const cleanUrl = u => u.replace(/[?#].*$/, '');

export function splitQuery(id) {
	const i = id.indexOf('?');
	return i < 0 ? [id, ''] : [id.slice(0, i), id.slice(i + 1)];
}

export function withQuery(url, key, value) {
	const sep = url.includes('?') ? '&' : '?';
	return `${url}${sep}${key}=${encodeURIComponent(value)}`;
}

export const hash = (s, len = 8) => crypto.createHash('sha1').update(s).digest('base64url').slice(0, len);

export function isFile(p) {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

export function isDir(p) {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

export const flatten = list => list.flat(Infinity).filter(Boolean);

export function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
	if (res.writableEnded) return;
	res.writeHead(status, {'Content-Type': type, 'Cache-Control': 'no-store'});
	res.end(text);
}

/** Vite 风格的 alias 归一化：{find: replacement} | [{find, replacement}] */
export function normalizeAlias(alias) {
	if (!alias) return [];
	const list = [];
	if (Array.isArray(alias)) list.push(...alias);
	else for (const [find, replacement] of Object.entries(alias)) list.push({find, replacement});
	return list.map(({find, replacement}) => ({find, replacement: toPosix(String(replacement))}));
}

/** 深度合并配置，数组按 vite 语义拼接 */
export function mergeConfig(a, b) {
	if (a == null) return b;
	if (b == null) return a;
	if (Array.isArray(a) || Array.isArray(b)) return [...(a || []), ...(b || [])];
	if (!isPureObject(a) || !isPureObject(b)) return b;
	const out = {...a};
	for (const key of Object.keys(b)) {
		const av = a[key], bv = b[key];
		if (av === undefined) out[key] = bv;
		else if (Array.isArray(av) && Array.isArray(bv)) out[key] = [...av, ...bv];
		else if (isPureObject(av) && isPureObject(bv)) out[key] = mergeConfig(av, bv);
		else out[key] = bv;
	}
	return out;
}

/**
 *
 * @param {string} prefix
 * @return {ie.Logger}
 */
export function createLogger(prefix = 'ie') {
	const paint = (c, m) => `\x1b[${c}m${m}\x1b[0m`;
	return {
		info: m => console.log(`${paint(36, prefix)} ${m}`),
		warn: m => console.warn(`${paint(33, prefix)} ${m}`),
		error: m => console.error(`${paint(31, prefix)} ${m}`),
		clear: () => process.stdout.write('\x1b[2J\x1b[0f'),
	};
}

/** 是否是构建期的 JS 模块（需要 babel / define 处理） */
export const isJsFile = f => /\.[cm]?[jt]sx?$/.test(f);

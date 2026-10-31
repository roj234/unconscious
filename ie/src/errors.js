import path from 'node:path';
import {toPosix} from './utils.js';

/**
 * 把 esbuild / rollup / 普通 Error 统一成能发给浏览器的结构
 * @returns {{message: string, stack: string, id: string, frame: string, loc: {line: number, column: number}|null, plugin: string|undefined}}
 */
export function formatError(error, options = {}) {
	const root = options.root;
	const info = {
		message: String(error.message ?? error),
		stack: '',
		id: options.id || error.id || error.loc?.file || '',
		frame: '',
		loc: null,
		plugin: error.plugin,
	};

	// esbuild: {errors: [{text, location: {file, line, column, lineText}}]}
	const detail = error.errors?.[0];
	if (detail) {
		if (detail.text) info.message = detail.text;
		if (detail.pluginName) info.plugin = detail.pluginName;
		const loc = detail.location;
		if (loc) {
			if (loc.file) info.id = loc.file;
			info.loc = {line: loc.line, column: loc.column};
			if (loc.lineText) {
				const pad = ' '.repeat(Math.max(0, (loc.column || 1) - 1));
				info.frame = `${loc.lineText}\n${pad}^`;
			}
		}
	} else {
		// rollup: {loc: {file, line, column}, frame}
		if (error.frame) info.frame = error.frame;
		if (error.loc?.line) {
			info.loc = {line: error.loc.line, column: error.loc.column};
			if (error.loc.file) info.id = error.loc.file;
		}
	}

	if (typeof error.stack === 'string') {
		const lines = error.stack.split('\n');
		if (info.frame) {
			// 有 code frame 时 stack 头部是重复的 message，只留调用栈
			info.stack = lines.filter(line => /^\s+at /.test(line)).slice(0, 12).join('\n');
		} else {
			info.stack = lines.slice(0, 14).join('\n');
		}
	}

	if (root && info.id) {
		const rel = path.relative(root, info.id);
		if (!rel.startsWith('..') && !path.isAbsolute(rel)) info.id = toPosix(rel);
	}
	return info;
}


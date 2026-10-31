/**
 * vite 插件 API 兼容层。
 * 构建配置文件时 vite 会指到这里。
 * 这只是临时方案。之后我会在这里设计我自己的API
 */
import picomatch from 'picomatch';
import {normalizePath as myNormalize} from "@roj234/shared/path";

export const defineConfig = config => config;
export const loadEnv = () => ({});
export const resolveConfig = async c => c;
export const mergeConfig = (a, b) => ({...a, ...b});

export const normalizePath = p => myNormalize(p).join('/');

function toMatcher(pattern, options) {
	if (pattern == null) return null;
	if (pattern instanceof RegExp) return id => pattern.test(id);
	if (typeof pattern === 'string') {
		const isMatch = picomatch(pattern, {dot: true, ...options});
		return id => isMatch(id);
	}
	if (Array.isArray(pattern)) {
		const ms = pattern.map(p => toMatcher(p, options)).filter(Boolean);
		return id => ms.some(m => m(id));
	}
	if (typeof pattern === 'function') return pattern;
	return null;
}

/**
 * 创建路径过滤器
 * @param {string|RegExp|Array<string|RegExp>|null} [include]
 * @param {string|RegExp|Array<string|RegExp>|null} [exclude]
 * @param {{resolve?: string|false, dot?: boolean}} [options]
 */
export function createFilter(include, exclude, options = {}) {
	const getMatcher = p => toMatcher(p, options) || (() => false);
	const includeMatcher = include == null ? () => true : getMatcher(include);
	const excludeMatcher = exclude == null ? () => false : getMatcher(exclude);
	const resolve = options.resolve;
	return id => {
		if (typeof id !== 'string') return false;
		if (id[0] === '\0') return false;
		let target = normalizePath(id);
		if (typeof resolve === 'string' && resolve !== '') {
			const root = normalizePath(resolve);
			if (target.startsWith(root)) target = target.slice(root.length + 1);
		}
		return includeMatcher(target) && !excludeMatcher(target);
	};
}

/**
 * @param {(string | RegExp)[]} items
 * @return {(function(string): (boolean))}
 */
export function createMatcher(items) {
	const groups = Object.create(null);
	const literals = new Set(); // exact 模式下字面串走 Set，比正则快

	for (const item of items) {
		if (typeof item === 'string') {
			literals.add(item);
			continue;
		}
		(groups[item.flags.replace(/[gy]/g, '')] ??= []).push(item.source);
	}

	const regexes = Object.entries(groups).map(([flags, srcs]) => new RegExp(`(?:${srcs.join('|')})`, flags));

	return function match(s) {
		if (literals.has(s)) return true;
		for (let i = 0; i < regexes.length; i++) if (regexes[i].test(s)) return true;
		return false;
	};
}

export default {defineConfig, normalizePath, createFilter, createMatcher, loadEnv};

import path from 'node:path';
import {isDir, isFile, normalizeAlias, splitQuery, toPosix} from './utils.js';
import {packageResolve} from "../utils/packageResolve.js";

/**
 * 解析 specifier -> 绝对路径。
 * @param {{
 *     root: string,
 *     resolve?: {
 *         alias: Record<string, string> | Record<string, string>[],
 *         extentions: string[]
 *     }
 * }} config
 */
export function createResolver(config) {
	const root = config.root;
	const aliases = normalizeAlias(config.resolve?.alias);
	const exts = config.resolve?.extensions || ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'];

	const tryExact = file => isFile(file) ? file : null;
	const tryFile = file => {
		const hit = tryExact(file);
		if (hit) return hit;
		for (const ext of exts) {
			const candidate = tryExact(file + ext);
			if (candidate) return candidate;
		}
		// FIXME 这个需要吗？
		if (isDir(file)) {
			for (const ext of exts) {
				const candidate = path.join(file, 'index' + ext);
				if (isFile(candidate)) return candidate;
			}
		}
		return null;
	};

	return {
		root, config,
		/**
		 * @param {string} id 被导入的模块
		 * @param {string} [importer] 导入者的绝对路径
		 * @returns {{id: string, query: string, external?: boolean}|null}
		 */
		resolveId(id, importer) {
			let [spec, query] = splitQuery(id);

			for (const {find, replacement} of aliases) {
				if (typeof find === 'string') {
					if (spec === find || spec.startsWith(find + '/')) {
						spec = replacement + spec.slice(find.length);
						break;
					}
				} else if (find.test(spec)) {
					spec = spec.replace(find, replacement);
					break;
				}
			}

			let file = null;
			const first = spec[0];
			if (first === '/') file = tryFile(path.join(root, spec)) ?? (process.platform !== 'win32' ? tryFile(spec) : null);
			else if (first === '.') file = tryFile(path.resolve(importer ? path.dirname(importer) : root, spec));
			else {
				if (spec.startsWith('node:')) return {id: spec, query, external: true};

				if (path.isAbsolute(spec)) file = tryFile(spec);
				if (!file) {
					const pkg = packageResolve(id, importer);
					if (pkg) file = pkg.id;
				}
			}

			if (!file) return null;
			return {id: toPosix(file), query};
		}
	};
}

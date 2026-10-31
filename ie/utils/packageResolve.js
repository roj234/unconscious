import {fileURLToPath} from "node:url";
import path from 'node:path';
import fs from 'node:fs';
import {LRUCache} from "@roj234/lru-cache";

const keyCache = new LRUCache(200);
const valueCache = new LRUCache(200);

const resolvePackage = (pkg, parent) => {
	const fileUrl = new URL(import.meta.resolve(pkg, parent));
	if (fileUrl.protocol === 'node:') return;
	return fileURLToPath(fileUrl);
};

/**
 *
 * @param {string} p
 * @return {string}
 */
const resolveNodeModulePath = (p) => {
	const history = [];
	while (true) {
		p = path.dirname(p);
		history.push(p);

		const cached = keyCache.get(p);
		if (cached) return cached;

		const dir = path.join(p, "node_modules");
		if (fs.existsSync(dir)) {
			for (const h of history) {
				keyCache.set(h, dir);
			}
			return dir;
		}
	}
};

/**
 *
 * @param {string} id
 * @param {string} [parent]
 * @return {{ id: string, external?: boolean }}
 */
export const packageResolve = (id, parent) => {
	let end = id.indexOf('/');
	if (end > 0 && id.startsWith('@')) end = id.indexOf('/', end+1);
	if (end < 0) end = id.length;

	const pkg = id.slice(0, end);
	if (pkg) {
		const par = parent ? resolveNodeModulePath(parent) : undefined;
		const cacheKey = (par || '')+'\0'+pkg;
		let value = valueCache.get(cacheKey);
		if (value == null) {
			try {
				const result = resolvePackage(pkg, par);
				value = result ? true : 'external';
			} catch (e) {
				value = false;
			}
			valueCache.set(cacheKey, value);
		}

		if (value) return value === 'external'
			? { id, external: true }
			: { id: resolvePackage(id, par) }
	}
}
import path from 'path';
import {readFile} from 'node:fs/promises';

const resolvePackage = pkg => {
	const fileUrl = new URL(import.meta.resolve(pkg));
	if (fileUrl.protocol === 'node:') return;
	return path.normalize(fileUrl.pathname.slice(process.platform === 'win32' ? 1 : 0));
};

/**
 * 删除JS代码中的注释
 * @param {string} code
 * @return {string}
 */
export function stripComments(code) {
	let output = '';

	let escaped, inQuotes, inComment;

	let prev = 0;
	for (let i = 0; i < code.length; i++) {
		if (escaped) {
			escaped = false;
			continue;
		}

		const char = code[i];
		if (inComment) {
			if (inComment === '/') {
				if (char === '\n') {
					inComment = null;
				}
			} else if (char === '*' && code[i + 1] === '/') {
				inComment = null;
				i++;
			}

			prev = i + 1;
			continue;
		}

		if (char === '"' || char === "'" || char === '`') {
			if (inQuotes == null) {
				inQuotes = char;
			} else if (inQuotes === char) {
				inQuotes = null;
			}
		} else if (inQuotes) {
			if (char === '\\') {
				escaped = true;
			}
		} else if (char === '/') {
			const next = code[i + 1];
			if (next === '/' || next === '*') {
				let j = i;
				while (j > 0 && (code[j - 1] === ' ' || code[j - 1] === '\t')) j--;
				output += code.slice(prev, j);
				prev = i + 2;

				inComment = next;
				i++;
			}
		}
	}

	output += code.slice(prev);
	return output;
}

/**
 * 简单正则解析导出（按你的需求，只支持命名导出和默认导出）
 */
function parseExports(code) {
	const names = new Set();

	const namedExports = /export\s+(const|let|var|function|class|default|\{)\s+([a-zA-Z_$][\w$]*)/g;
	let match;
	while ((match = namedExports.exec(code))) {
		if (match[1] === 'default' || match[1] === '{')
			throw new Error(`[config-proxy] export { ... } and/or export default are not supported yet`);

		names.add(match[2]);
	}

	names.delete("reload");
	return Array.from(names);
}

export function configProxy(options = {}) {
	const {include, exclude} = options;

	return {
		name: 'my-config-proxy',
		async load(id) {
			if (exclude?.test(id)) return;
			if (!include?.test(id)) return;

			const code = stripComments(await readFile(id, 'utf8'));

			let exportNames;
			try {
				exportNames = parseExports(code, id);
			} catch (err) {
				this.error(err.message);
			}

			return `
// ======== Auto-generated proxy module for ${id} ========
${exportNames.map(n => `export let ${n};`).join('\n')}
async function _reload(path) {
  const mod = await import(path);
  if (mod.reload) reload = mod.reload;
${exportNames.map(n => `${n} = mod.${n};`).join('\n')}
  return mod;
}
export let reload = _reload;
`;
		}
	};
}

export function nodeResolve({removeComment = true} = {}) {
	const availPackage = new Map;

	return {
		name: 'my-node-resolve',
		resolveId(id, importer) {
			// node 自带模块
			if (id.startsWith('node:')) return { id, external: true };
			// 导入的
			if (id.startsWith('.')) return;

			let end = id.indexOf('/');
			if (end < 0) end = id.length;
			const pkg = id.slice(0, end);
			if (pkg) {
				let value = availPackage.get(pkg);
				if (value == null) {
					try {
						const result = resolvePackage(pkg);
						value = result ? true : 'external';
					} catch (e) {
						value = false;
					}
					availPackage.set(pkg, value);
				}

				if (value) return value === 'external'
					? { id, external: true }
					: { id: resolvePackage(id) }
			}
		},
		/**
		 *
		 * @param {string} code
		 * @param {string} id
		 * @return {Promise<{code: string, map: null}>}
		 */
		async transform(code, id) {
			code = code
				.replaceAll('\r\n', '\n')
				.replaceAll('\r', '\n')
				.replaceAll(
				/!import\.meta\.env\?\.MODE/g,
				'true'
			);

			if (!removeComment) return { code, map: null };
			return { code: '// '+id+"\n"+stripComments(code).replaceAll(/\n\n\n+/g, '\n\n').trim(), map: null };
		}
	};
}
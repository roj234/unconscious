import path from 'path';

const resolvePackage = pkg => {
	const fileUrl = new URL(import.meta.resolve(pkg));
	return path.normalize(fileUrl.pathname.slice(process.platform === 'win32' ? 1 : 0));
};

export function nodeResolve({removeComment = true} = {}) {
	const availPackage = new Map;

	return {
		name: 'my-node-resolve',
		resolveId(id, importer) {
			// node 自带模块
			if (!id.includes('.')) return { id, external: true };
			// 导入的
			if (id.startsWith('.')) return;

			const pkg = id.slice(0, id.indexOf('/'));
			if (pkg) {
				let value = availPackage.get(pkg);
				if (value == null) {
					try {
						resolvePackage(pkg);
						value = true;
					} catch (e) {
						value = false;
					}
					availPackage.set(pkg, value);
				}

				if (value) return {
					id: resolvePackage(id)
				}
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

			let output = '';
			let escaped;
			let inQuotes;
			let inComment;
			let prev = 0;
			for (let i = 0; i < code.length; i++) {
				if (escaped) { escaped = false; continue; }

				const char = code[i];
				if (inComment) {
					if (inComment === '/') {
						if (char === '\n') {
							inComment = null;
						}
					} else if (char === '*' && code[i+1] === '/') {
						inComment = null;
						i++;
					}

					prev = i+1;
					continue;
				}

				if (char === '"' || char === "'" || char === '`') {
					if (inQuotes == null) {
						inQuotes = char;
					} else if (inQuotes === char) {
						inQuotes = null;
					}
				} else if (inQuotes) {
					if (char === '\\') { escaped = true; }
				} else if (char === '/') {
					const next = code[i+1];
					if (next === '/' || next === '*') {
						let j = i;
						while (j > 0 && (code[j-1] === ' ' || code[j-1] === '\t')) j--;
						output += code.slice(prev, j);
						prev = i+2;

						inComment = next;
						i++;
					}
				}
			}
			output += code.slice(prev);

			return { code: '// '+id+"\n"+output.replaceAll(/\n\n\n+/g, '\n\n').trim(), map: null };
		}
	};
}
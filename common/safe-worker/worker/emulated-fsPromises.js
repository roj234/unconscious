
if (!Uint8Array.prototype.toHex) {
	const HEX_CHARS = '0123456789abcdef';
	Object.defineProperties(Uint8Array.prototype, {
		toHex: {
			value: function () {
				let hex = '';
				for (let i = 0; i < this.length; i++) {
					const byte = this[i];
					hex += HEX_CHARS[(byte >>> 4)] + HEX_CHARS[(byte & 0xf)];
				}
				return hex;
			},
		},
		/*toBase64: {
			value: () => {

			}
		}*/
	})
}

const FALSE = () => false;
/**
 * Parse fs.stat string output into an object resembling fs.Stats
 */
const parseStat = text => {
	const stats = {};
	const lines = text.trim().split('\n');
	for (const line of lines) {
		const idx = line.indexOf(':');
		if (idx < 0) continue;
		const key = line.slice(0, idx).trim();
		const val = line.slice(idx + 1).trim();
		switch (key) {
			case 'type':
				stats._type = val;
				break;
			case 'size':
				stats.size = parseInt(val, 10) || 0;
				break;
			case 'mode':
				stats.mode = val;
				break;
			case 'mtime':
				stats.mtimeMs = new Date(val).getTime();
				break;
			case 'atime':
				stats.atimeMs = new Date(val).getTime();
				break;
			case 'ctime':
				stats.ctimeMs = new Date(val).getTime();
				break;
			case 'nlink':
				stats.nlink = parseInt(val, 10) || 0;
				break;
		}
	}
	stats.isFile = () => stats._type === 'file';
	stats.isDirectory = () => stats._type === 'dir';
	stats.isBlockDevice = FALSE;
	stats.isCharacterDevice = FALSE;
	stats.isSymbolicLink = FALSE;
	stats.isFIFO = FALSE;
	stats.isSocket = FALSE;
	return stats;
};

export const emulateFsPromises = (RPC) => {
	const fsPromises = {
		/**
		 * Read the entire contents of a file.
		 * @param {string} path
		 * @param {{encoding?: string}|string} [options]
		 * @returns {Promise<string|Uint8Array>}
		 */
		async readFile(path, options) {
			const encoding = typeof options === 'string' ? options : options?.encoding;
			if (encoding == null || encoding === 'binary' || encoding === 'hex') {
				const blob = await RPC('readRaw', [path]);
				const uint8Array = new Uint8Array(await blob.arrayBuffer());
				if (encoding === 'hex') return uint8Array.toHex();
				return uint8Array;
			}

			return RPC('read', [path, encoding || 'utf-8']);
		},

		/**
		 * Write data to a file.
		 * @param {string} path
		 * @param {string|Uint8Array} data
		 * @param {{encoding?: string, mode?: number, flag?: string}|string} [options]
		 * @returns {Promise<void>}
		 */
		writeFile(path, data, options) {
			if (data instanceof Uint8Array) {
				return RPC('writeRaw', [path, data, options], options?.transfer && [data.buffer]);
			}
			return RPC('write', [path, data]);
		},

		/**
		 * Append data to a file.
		 * @param {string} path
		 * @param {string|Uint8Array} data
		 * @param {{encoding?: string, mode?: number, flag?: string}|string} [options]
		 * @returns {Promise<void>}
		 */
		appendFile(path, data, options) {
			if (data instanceof Uint8Array) {
				return RPC('appendRaw', [path, data, options], options?.transfer && [data.buffer]);
			}
			return RPC('append', [path, data]);
		},

		/**
		 * Create a directory.
		 * @param {string} path
		 * @param {{recursive?: boolean, mode?: number}} [options]
		 * @returns {Promise<void>}
		 */
		mkdir(path, options) {
			return RPC('mkdir', [path]);
		},

		/**
		 * Remove a file or directory.
		 * @param {string} path
		 * @param {{recursive?: boolean, force?: boolean}} [options]
		 * @returns {Promise<void>}
		 */
		rm(path, options) {
			return RPC('delete', [path]);
		},
		unlink(path) {return this.rm(path);},

		/**
		 * Remove a directory.
		 * @param {string} path
		 * @param {{recursive?: boolean}} [options]
		 * @returns {Promise<void>}
		 */
		rmdir(path, options) {return this.rm(path);},

		/**
		 * Read the contents of a directory.
		 * @param {string} path
		 * @param {{encoding?: string, withFileTypes?: boolean}|string} [options]
		 * @returns {Promise<string[]|Dirent[]>}
		 */
		async readdir(path, options) {
			const withFileTypes = options?.withFileTypes || false;
			const files = await RPC('list', [path, true, null]);
			if (!Array.isArray(files)) return [];

			if (withFileTypes) {
				return files.map(([name, type]) => ({
					name,
					isFile: () => type === 'file',
					isDirectory: () => type === 'dir',
					isBlockDevice: () => false,
					isCharacterDevice: () => false,
					isSymbolicLink: () => false,
					isFIFO: () => false,
					isSocket: () => false,
				}));
			}
			return files.map(f => f[0]);
		},

		/**
		 * Get file/directory status.
		 * @param {string} path
		 * @param {{bigint?: boolean}} [options]
		 * @returns {Promise<object>}
		 */
		async stat(path, options) {
			try {
				const result = await RPC('stat', [path]);
				return parseStat(result);
			} catch (e) {
				const err = new Error("ENOENT: no such file or directory, access '" + path + "'");
				err.code = 'ENOENT';
				throw err;
			}
		},

		/**
		 * Like stat but doesn't follow symlinks (same as stat in this env).
		 * @param {string} path
		 * @param {{bigint?: boolean}} [options]
		 * @returns {Promise<object>}
		 */
		lstat(path, options) {
			return this.stat(path, options);
		},

		/**
		 * Test user's permissions for a file.
		 * @param {string} path
		 * @param {number} [mode]
		 * @returns {Promise<void>}
		 */
		async access(path, mode) {
			await this.stat(path);
		},

		/**
		 * Copy src to dest.
		 * @param {string} src
		 * @param {string} dest
		 * @param {number} [mode]
		 * @returns {Promise<void>}
		 */
		copyFile(src, dest, mode) {
			return RPC('copy', [src, dest, false]);
		},

		/**
		 * Rename/move a file or directory.
		 * @param {string} oldPath
		 * @param {string} newPath
		 * @returns {Promise<void>}
		 */
		rename(oldPath, newPath) {
			return RPC('copy', [oldPath, newPath, true]);
		},

		/**
		 * Open a directory as an async iterable.
		 * @param {string} path
		 * @param {{encoding?: string, bufferSize?: number}} [options]
		 * @returns {Promise<AsyncIterable<Dirent>>}
		 */
		async opendir(path, options) {
			const files = await RPC('list', [path, true, null]);
			if (!Array.isArray(files)) return [];

			let idx = 0;
			const entries = files.map(([name, type]) => ({
				name,
				isFile: () => type === 'file',
				isDirectory: () => type === 'dir',
				isBlockDevice: () => false,
				isCharacterDevice: () => false,
				isSymbolicLink: () => false,
				isFIFO: () => false,
				isSocket: () => false,
			}));

			return {
				[Symbol.asyncIterator]() {
					return {
						async next() {
							if (idx >= entries.length) return {done: true};
							return {done: false, value: entries[idx++]};
						}
					};
				},
				async close() { idx = entries.length; },
			};
		},

		/**
		 * Match files using glob patterns.
		 * @param {string|string[]} pattern
		 * @param {{cwd?: string, exclude?: string[], nodir?: boolean}|string} [options]
		 * @returns {Promise<string[]>}
		 */
		async glob(pattern, options) {
			const cwd = (options && typeof options === 'object' ? options.cwd : null) || '.';
			const patterns = Array.isArray(pattern) ? pattern : [pattern];
			const allResults = [];

			for (const pat of patterns) {
				const result = await RPC('list', [cwd, true, pat]);
				if (Array.isArray(result)) {
					for (const [name, type] of result) {
						allResults.push(name);
					}
				}
			}

			if (options?.nodir) {
				// We'd need to filter dirs, but list only returns files when pattern is specified
			}
			return allResults;
		},
	};

	// Also expose as fs.promises for Node.js compatibility
	return {
		...fsPromises,
		promises: fsPromises,
		constants: {
			F_OK: 0,
			R_OK: 4,
			W_OK: 2,
			X_OK: 1,
			COPYFILE_EXCL: 1,
			COPYFILE_FICLONE: 2,
			COPYFILE_FICLONE_FORCE: 4,
		}
	};
};
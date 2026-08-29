import {UTF8_TEXT_DECODER} from "../../../shared.js";

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

const getTransfer = (data, options) => {
	const transfer = options?.transfer;
	if (transfer) {
		const setting = { value: data.length };
		const buf = data.buffer;
		Object.defineProperty(data, 'length', setting);
		Object.defineProperty(buf, 'length', setting);
		return [buf];
	}
}
/**
 * 在 Worker 中模拟 fs.promises.FileHandle
 * 底层基于 FileSystemFileHandle
 */
class RAF {
	/**
	 * @type {FileSystemFileHandle}
	 */
	#handle;
	#mode;
	#position;
	#closed;

	constructor(handle, path, mode) {
		this.#handle = handle;
		this.#mode = mode;
		this.#position = 0;
		this.#closed = false;
	}

	/** 根据打开模式初始化文件位置，w 模式需要截断文件 */
	async _init() {
		if (this.#mode.includes('a')) {
			const file = await this.#handle.getFile();
			this.#position = file.size;
		} else if (this.#mode.includes('w')) {
			await this.truncate(0);
		} else {
			this.#position = 0;
		}
	}

	#assertOpen() {
		if (this.#closed) throw new Error('FileHandle is closed');
	}

	#canRead() {
		return this.#mode.includes('r') || this.#mode.includes('+') || this.#mode.includes('a');
	}

	#canWrite() {
		return this.#mode.includes('w') || this.#mode.includes('a') || this.#mode.includes('+');
	}

	/** 读取文件内容，模仿 fs.promises.FileHandle.read */
	async read(buffer, offset = 0, length = buffer.byteLength, position = null) {
		await this.#assertOpen();

		if (!this.#canRead()) throw new Error('File not opened for reading');
		this.#flush();

		let positionProvided = position != null;
		if (position == null) position = this.#position;

		offset = offset || 0;
		length = length || buffer.byteLength - offset;

		if (!(buffer instanceof Uint8Array)) {
			throw new TypeError('buffer must be a Uint8Array');
		}

		const file = await this.#handle.getFile();
		if (position >= file.size) return { bytesRead: 0, buffer };

		const end = Math.min(position + length, file.size);
		const blob = file.slice(position, end);
		const data = new Uint8Array(await blob.arrayBuffer());

		buffer.set(data, offset);

		if (!positionProvided) {
			this.#position = end;
		}

		return { bytesRead: data.length, buffer };
	}

	#ws;

	/**
	 *
	 * @return {Promise<FileSystemWritableFileStream>}
	 */
	#forWrite() {
		this.#assertOpen();
		if (!this.#canWrite()) throw new Error('File not opened for writing');
		return this.#ws || (this.#ws = this.#handle.createWritable({ keepExistingData: true }));
	}
	#flush() {
		if (!this.#ws) return;
		const p = this.#ws.then(ws => ws.close());
		this.#ws = null;
		return p;
	}

	/** 写入内容 */
	async write(buffer, offset = 0, length = buffer.byteLength, position = null) {
		await this.#assertOpen();
		if (!this.#canWrite()) throw new Error('File not opened for writing');

		if (!(buffer instanceof Uint8Array)) buffer = Buffer.from(buffer);

		// append 模式下，忽略传入 position，总是写文件末尾
		let positionProvided = position != null;
		if (this.#mode.startsWith('a')) position = undefined;
		else if (position == null) position = this.#position;

		const os = await this.#forWrite();
		await os.write({
			type: "write",
			data: buffer,
			position
		});

		if (!positionProvided) this.#position = position + buffer.length;
		return { bytesWritten: buffer.length, buffer };
	}

	/** 截断文件 */
	async truncate(len) {
		if (len < 0) len = 0;

		const os = await this.#forWrite();
		await os.truncate(len);
		if (this.#position > len) this.#position = len;
	}

	/** 读整个文件 */
	async readFile(options = {}) {
		this.#flush();

		const file = await this.#handle.getFile();
		const arrayBuffer = await file.arrayBuffer();

		if (options.encoding === 'utf8' || options.encoding === 'utf-8') {
			return UTF8_TEXT_DECODER.decode(arrayBuffer);
		}
		return new Uint8Array(arrayBuffer);
	}

	/** 写整个文件（会覆盖并截断） */
	async writeFile(data, options = {}) {
		if (!(data instanceof Uint8Array)) data = Buffer.from(data);
		const len = data.length;

		const writable = await this.#forWrite();
		await writable.write({
			type: "write",
			position: 0,
			data
		});
		await writable.truncate(len);
		this.#position = len;
	}

	/** 追加内容到文件末尾 */
	async appendFile(data) {
		const file = await this.#handle.getFile();
		await this.write(data, 0, undefined, file.size);
	}

	/** 获取文件状态 */
	async stat() {
		await this.#assertOpen();
		const file = await this.#handle.getFile();
		return {
			size: file.size,
			lastModified: file.lastModified,
			isFile: () => true,
			isDirectory: () => false,
		};
	}

	/** 关闭句柄（浏览器 FileSystemFileHandle 本身没有 close，这里只做标记） */
	async close() {
		this.#closed = true;
		return this.#flush();
	}

	/** 同步：浏览器中每次写入已即时 close，无需额外操作 */
	async sync() {return this.#flush();}
	async datasync() {return this.#flush();}
}

export const emulateFsPromises = (RPC) => {
	const fsPromises = {
		async open(path, mode, options) {
			if (!/[rwa]/.test(mode)) throw new Error("Mode must be r, w or a");
			const handle = await RPC('open', [path, mode !== 'r']);
			const fh = new RAF(handle, path, mode);
			await fh._init();
			return fh;
		},

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
				const uint8Array = new Buffer(await blob.arrayBuffer());
				if (encoding === 'hex') return uint8Array.toString('hex');
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
				return RPC('writeRaw', [path, data, options], getTransfer(data, options));
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
				return RPC('appendRaw', [path, data, options], getTransfer(data, options));
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
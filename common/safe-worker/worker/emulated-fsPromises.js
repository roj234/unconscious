import {UTF8_TEXT_DECODER} from "../../../shared.js";
import {emulatedPath} from "./emulated-path.js";
import {immutableObjectMap} from "../../Utils.js";

const FALSE = () => false;

const Dirent = immutableObjectMap({
	isBlockDevice: FALSE,
	isCharacterDevice: FALSE,
	isSymbolicLink: FALSE,
	isFIFO: FALSE,
	isSocket: FALSE,
	isFile() {return this._type === 'file';},
	isDirectory() {return this._type === 'dir';},
	get path() {return this.parentPath}
});

const badTime = new Date(0);
const Stats = Object.assign(Object.create(Dirent), {
	dev: 0, ino: 0, mode: 0, nlink: 1, uid: 0, gid: 0, rdev: 0,
	blksize: 4096, size: 0,
	atime: badTime, ctime: badTime, mtime: badTime, birthtime: badTime,
	atimeMs: 0, ctimeMs: 0, mtimeMs: 0, birthtimeMs: 0
});

/**
 * Parse fs.stat string output into an object resembling fs.Stats
 */
const parseStat = text => {
	const stats = Object.create(Stats);
	const lines = text.trim().split('\n');
	for (const line of lines) {
		const idx = line.indexOf(':');
		if (idx < 0) continue;
		const key = line.slice(0, idx).trim();
		const val = line.slice(idx + 1).trim();
		switch (key) {
			case 'type':stats._type = val;break;
			case 'size':
				stats.size = parseInt(val, 10);
				stats.blocks = Math.ceil(stats.size / 512);
			break;
			case 'mode':stats.mode = val;break;
			case 'mtime':stats.mtimeMs = (stats.mtime = new Date(val)).getTime();break;
			case 'atime':stats.atimeMs = (stats.atime = new Date(val)).getTime();break;
			case 'ctime':stats.ctimeMs = (stats.ctime = new Date(val)).getTime();break;
			case 'nlink':stats.nlink = parseInt(val, 10);break;
		}
	}
	return stats;
};

const BIGINT_FIELDS = ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'blksize', 'blocks', 'atimeMs', 'mtimeMs', 'ctimeMs', 'birthtimeMs'];

/**
 * 转换为相对路径
 * @param {string|Uint8Array|URL} path
 * @returns {string}
 */
const toHostPath = (path) => {
	if (path instanceof URL) {
		if (path.protocol !== 'file:') throw new TypeError('path must be a file: URL');
		path = decodeURIComponent(path.pathname);
	} else if (typeof path !== 'string') {
		if (path instanceof Uint8Array) path = UTF8_TEXT_DECODER.decode(path);
		else throw new TypeError('path must be a string, Buffer, or URL');
	}
	return emulatedPath.resolve(path).slice(1) || '.';
};

/**
 * 带parentPath的Dirent
 * @param {string} parentPath cwd
 */
const mapToDirent = (parentPath) => ([relPath, type]) => {
	const idx = relPath.lastIndexOf('/');
	const pp = idx < 0 ? parentPath : parentPath+'/'+relPath.slice(0, idx);
	const isDir = type.startsWith('dir');
	return immutableObjectMap({
		parentPath: pp,
		name: idx < 0 ? relPath : relPath.slice(idx + 1),
		_type: isDir ? 'dir' : type
	}, Dirent);
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
		await this.#flush();

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
		await this.#flush();

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
		await this.#flush();
		const file = await this.#handle.getFile();
		return immutableObjectMap({
			_type: 'file',
			size: file.size,
			blocks: Math.ceil(file.size / 512),
			mtimeMs: file.lastModified,
			mtime: new Date(file.lastModified),
		}, Stats);
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
		async open(path, mode = 'r', options) {
			if (!/[rwa]/.test(mode)) throw new DOMException("Mode must be r, w or a", "InvalidAccessError");
			const handle = await RPC('open', [toHostPath(path), mode !== 'r']);
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
			path = toHostPath(path);
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
			path = toHostPath(path);
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
			path = toHostPath(path);
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
			return RPC('mkdir', [toHostPath(path)]);
		},

		/**
		 * Remove a file or directory.
		 * @param {string} path
		 * @param {{recursive?: boolean, force?: boolean}} [options]
		 * @returns {Promise<void>}
		 */
		rm(path, {force, recursive} = {}) {
			return RPC('delete', [toHostPath(path), {force, recursive}]);
		},
		unlink(path) {return this.rm(path);},

		/**
		 * Remove a directory.
		 * @param {string} path
		 * @param {{recursive?: boolean}} [options]
		 * @returns {Promise<void>}
		 */
		rmdir(path, options) {return this.rm(path, options);},

		/**
		 * Read the contents of a directory.
		 * @param {string} path
		 * @param {{encoding?: string, withFileTypes?: boolean, recursive?: boolean}|string} [options]
		 * @returns {Promise<string[]|Dirent[]>}
		 */
		async readdir(path, options) {
			path = toHostPath(path);
			const withFileTypes = options?.withFileTypes;
			const recursive = options?.recursive;
			const files = await RPC('list', [path, true, recursive ? "**" : null]);
			if (!withFileTypes) return files.map(f => f[0]);
			return files.map(mapToDirent(path));
		},

		/**
		 * Get file/directory status.
		 * @param {string} path
		 * @param {{bigint?: boolean}} [options]
		 * @returns {Promise<object>}
		 */
		async stat(path, options) {
			const result = await RPC('stat', [toHostPath(path)]);
			const stats = parseStat(result);
			if (options?.bigint) {
				for (const key of BIGINT_FIELDS) stats[key] = BigInt(stats[key]);
			}
			return stats;
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
		 * 解析为沙箱内绝对路径（以 '/' 为根）。没有符号链接，即规范化 + 存在性检查。
		 * @param {string} path
		 * @param options
		 * @returns {Promise<string>}
		 */
		async realpath(path, options) {
			const resolved = emulatedPath.resolve(toHostPath(path));
			await this.stat(resolved, options);
			return resolved;
		},

		/**
		 * Test user's permissions for a file.
		 * @param {string} path
		 * @param {number} [mode]
		 * @returns {Promise<void>}
		 */
		access(path, mode) {
			return this.stat(path);
		},

		/**
		 * Copy src to dest.
		 * @param {string} src
		 * @param {string} dest
		 * @param {number} [mode]
		 * @returns {Promise<void>}
		 */
		copyFile(src, dest, mode) {
			return RPC('copy', [toHostPath(src), toHostPath(dest), false]);
		},

		/**
		 * Rename/move a file or directory.
		 * @param {string} oldPath
		 * @param {string} newPath
		 * @returns {Promise<void>}
		 */
		rename(oldPath, newPath) {
			return RPC('copy', [toHostPath(oldPath), toHostPath(newPath), true]);
		},

		/**
		 * Open a directory as an async iterable.
		 * @param {string} path
		 * @param {{encoding?: string, bufferSize?: number}} [options]
		 * @returns {Promise<AsyncIterable<Dirent>>}
		 */
		async opendir(path, options) {
			path = toHostPath(path);
			const files = await RPC('list', [path, true, null]);
			const toDirent = mapToDirent(path);
			let idx = 0;

			return {
				[Symbol.asyncIterator]() {
					return {
						async next() {
							if (idx >= files.length) return {done: true};
							return {done: false, value: toDirent(files[idx++])};
						}
					};
				},
				async close() { idx = files.length; },
			};
		},

		/**
		 * Match files using glob patterns.
		 * @param {string|string[]} pattern
		 * @param {{cwd?: string, exclude?: string[], nodir?: boolean, withFileTypes?: boolean}} [options]
		 * @returns {Promise<string[]|Dirent[]>}
		 */
		async glob(pattern, options) {
			const withFileTypes = options?.withFileTypes;
			const cwd = toHostPath(options?.cwd || '.');
			const exclude = options?.exclude;
			const nodir = options?.nodir;
			const convert = withFileTypes ? mapToDirent(cwd) : f => f[0];

			if (!Array.isArray(pattern)) {
				let files = await RPC('list', [cwd, true, pattern, exclude]);
				if (nodir) files = files.filter(f => f[1] === 'file');
				return files.map(convert);
			} else {
				const all = new Set;
				for (const pat of pattern) {
					const result = await RPC('list', [cwd, true, pat, exclude]);
					if (Array.isArray(result)) {
						for (const arr of result) {
							if (!nodir || arr[1] === 'file')
								all.add(arr);
						}
					}
				}
				return [...all].map(convert);
			}
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
// duck type 真是太赞了！
import {debugSymbol, UTF8_TEXT_DECODER, UTF8_TEXT_ENCODER} from "../shared.js";

const ZIP_READER_SYMBOL = debugSymbol("ZipReaderId");

const isNode = !import.meta.env?.MODE;
let zlib;
if (isNode) {
	zlib = await import('node:zlib');
}

const CRC32 = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
	let c = i;
	for (let j = 0; j < 8; j++) {
		c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
	}
	CRC32[i] = c;
}

// 计算 CRC32
/**
 *
 * @param {Uint8Array} data
 * @returns {number}
 */
export function crc32(data) {
	let crc = 0xFFFFFFFF;
	for (let i = 0; i < data.length; i++) {
		crc = (crc >>> 8) ^ CRC32[(crc ^ data[i]) & 0xFF];
	}
	return (crc ^ 0xFFFFFFFF) >>> 0;
}

// 将 JS Date 转换为 MS-DOS 时间格式
function getDosTime(date) {
	const y = date.getFullYear();
	const m = date.getMonth() + 1;
	const d = date.getDate();
	const hh = date.getHours();
	const mm = date.getMinutes();
	const ss = date.getSeconds();

	const datePart = ((y - 1980) << 9) | (m << 5) | d;
	const timePart = (hh << 11) | (mm << 5) | (ss >> 1);
	return { date: datePart, time: timePart };
}

/**
 * @param {string | Uint8Array} data
 * @return {Uint8Array | Buffer}
 */
async function compressData(data) {
	if (isNode) return zlib.deflateRawSync(data);

	const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'));
	const response = new Response(stream);
	return new Uint8Array(await response.arrayBuffer());
}

export function ZipWriter() {
	let offset = 0;
	let cenSize = 0;
	const locs = [];
	const cens = [];

	const BUF_SIZE = 1024;
	let ptr = BUF_SIZE;
	let buf;
	let view;

	return {
		fileCount() {
			return cens.length >> 1;
		},

		/**
		 * 添加文件
		 * @param {string} name
		 * @param {Uint8Array|string|ZipReaderInstance} content
		 * @param {AddOptions|ZipEntry} options
		 */
		async add(name, content, options = {}) {
			/** @type {Uint8Array} */
			let nameData = UTF8_TEXT_ENCODER.encode(name), compressedData;
			/** @type {number} */
			let crc, size, compression, compressedSize;

			if (content[ZIP_READER_SYMBOL]) {
				crc = options.crc32;
				size = options.compressedSize;
				compression = options.compression;
				compressedData = await content.getRaw(options);
				compressedSize = options.compressedSize;
			} else {
				const fileData = typeof content === 'string' ? UTF8_TEXT_ENCODER.encode(content) : content;
				crc = crc32(fileData);
				size = fileData.length;
				compression = options.compression || 0;
				compressedData = fileData;

				// 处理压缩
				if (compression) {
					compression = typeof compression === 'number' ? compression : 8; // 8 = Deflate

					if (compression === 8) {
						compressedData = await compressData(fileData);
					} else if (compression === 92 && isNode) {
						compression = 92;
						// 构建静态资源用。
						compressedData = await new Promise((resolve, reject) => {
							zlib.brotliCompress(fileData, {
								params: {
									[zlib.constants.BROTLI_PARAM_QUALITY]: 11,
									[zlib.constants.BROTLI_PARAM_SIZE_HINT]: fileData.length,
								},
							}, (error, compressed) => {
								if (error) reject(error);
								resolve(compressed);
							});
						});
					} else {
						throw new Error("Unsupported method");
					}

					// 如果无法压缩
					if (compressedData.length >= fileData.length) {
						compressedData = fileData;
						compression = 0;
					}
				}
				compressedSize = compressedData.length;
			}

			const { time, date } = getDosTime(new Date(options.lastModified));

			if (BUF_SIZE - ptr < 128) {
				buf = new ArrayBuffer(BUF_SIZE);
				view = new DataView(buf);
				ptr = 0;
			}

			// LOC parts
			{
				let p = ptr;

				view.setUint32(p, 0x04034b50, true); p += 4;
				view.setUint16(p, 20, true); p += 2;
				view.setUint16(p, 2048, true); p += 2;  // General purpose bit flag
				view.setUint16(p, compression, true); p += 2; // compression
				view.setUint16(p, time, true); p += 2;
				view.setUint16(p, date, true); p += 2;
				view.setUint32(p, crc, true); p += 4;
				view.setUint32(p, compressedSize, true); p += 4;     // Compressed size
				view.setUint32(p, size, true); p += 4;     // Uncompressed size
				view.setUint16(p, nameData.length, true); p += 2;
				p += 2;          // Extra field length

				locs.push(new Uint8Array(buf, ptr, p - ptr));
				locs.push(nameData);
				locs.push(compressedData);

				ptr = p;
			}

			// CEN parts
			{
				let p = ptr;

				view.setUint32(p, 0x02014b50, true); p += 4; // Signature
				view.setUint16(p, 20, true); p += 2;
				view.setUint16(p, 20, true); p += 2;
				view.setUint16(p, 2048, true); p += 2;
				view.setUint16(p, compression, true); p += 2;
				view.setUint16(p, time, true); p += 2;
				view.setUint16(p, date, true); p += 2;
				view.setUint32(p, crc, true); p += 4;
				view.setUint32(p, compressedSize, true); p += 4;
				view.setUint32(p, size, true); p += 4;
				view.setUint16(p, nameData.length, true); p += 2;
				p += 2;          // Extra length
				p += 2;          // Comment length
				p += 2;          // Disk number start
				p += 2;          // Internal attr
				p += 4;          // External attr
				view.setUint32(p, offset, true); p += 4; // Offset to local header

				cens.push(new Uint8Array(buf, ptr, p - ptr));
				cens.push(nameData);

				cenSize += 46 + nameData.length;
				ptr = p;
			}

			offset += 30 + nameData.length + compressedSize;
		},

		finish(type = 'application/zip') {
			const cenStart = offset;
			const cenEnd = offset + cenSize;
			const entriesCount = cens.length >> 1;

			if (!buf) {
				buf = new ArrayBuffer(22);
				view = new DataView(buf);
				ptr = 0;
			}

			let p = ptr;

			// 4. End of central directory record (EOCD)
			view.setUint32(p, 0x06054b50, true); p += 4;
			p += 2; // Disk number
			p += 2; // Central dir disk
			view.setUint16(p, entriesCount, true); p += 2; // Total entries this disk
			view.setUint16(p, entriesCount, true); p += 2; // Total entries total
			view.setUint32(p, cenEnd - cenStart, true); p += 4; // Size of central dir
			view.setUint32(p, cenStart, true); p += 4; // Offset to central dir
			view.setUint16(p, 0, true); p += 2; // Comment length

			return new Blob([...locs, ...cens, buf.byteLength === 22 ? buf : new Uint8Array(buf, ptr, 22)], { type });
		}
	}
}

/**
 * 将 MS-DOS 时间格式转换为 JS Date
 * @param {number} datePart
 * @param {number} timePart
 * @return {Date}
 */
function parseDosTime(datePart, timePart) {
	const y = ((datePart >> 9) & 0x7F) + 1980;
	const m = (datePart >> 5) & 0x0F;
	const d = datePart & 0x1F;
	const hh = (timePart >> 11) & 0x1F;
	const mm = (timePart >> 5) & 0x3F;
	const ss = (timePart & 0x1F) << 1;
	return new Date(y, m - 1, d, hh, mm, ss);
}

/**
 * 使用 DecompressionStream 解压数据
 * @param {Blob | Buffer} data
 * @return {Uint8Array | Buffer}
 */
async function decompressData(data) {
	if (isNode) return zlib.inflateRawSync(data);

	const stream = data.stream().pipeThrough(new DecompressionStream('deflate-raw'));
	const response = new Response(stream);
	return new Uint8Array(await response.arrayBuffer());
}

/**
 * @param {Blob | Buffer} blob
 * @param {boolean} [verify=false]
 */
export async function ZipReader(blob, {verify} = {}) {
	if (!isNode && !(blob instanceof Blob)) throw new Error("Input must be Blob");
	if (isNode && !Buffer.isBuffer(blob)) throw new Error("Input must be Buffer");
	const entries = new Map();

	/**
	 * 读取指定范围的小段数据并返回 DataView
	 */
	const _readChunk = async (offset, size) => {
		if (isNode) {
			/** @type {Buffer} */
			const chunk = blob.subarray(offset, offset + size);
			return { view: new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength), buffer: chunk };
		}

		const slice = blob.slice(offset, offset + size);
		const buffer = await slice.arrayBuffer();
		return { buffer, view: new DataView(buffer) };
	};

	/**
	 * @type {number}
	 */
	let eocdOffset, entryCount, centralDirOffset, centralDirSize;

	findEOCD: {
		const size = isNode ? blob.length : blob.size;
		// EOCD 最小 22 字节，注释最大 65535 字节
		const maxSearch = Math.min(size, 65535 + 22);
		const startPos = size - maxSearch;

		const { view } = await _readChunk(startPos, maxSearch);

		for (let i = maxSearch - 22; i >= 0; i--) {
			if (view.getUint32(i) === 0x504b0506) {
				const commentLen = view.getUint16(i + 20, true);
				if (startPos + i + 22 + commentLen === size) {
					eocdOffset = startPos + i;
					entryCount = view.getUint16(i + 10, true);
					centralDirSize = view.getUint32(i + 12, true);
					centralDirOffset = view.getUint32(i + 16, true);
					break findEOCD;
				}
			}
		}

		throw new Error("Not a valid ZIP file (EOCD not found)");
	}

	// 处理 Zip64
	checkZip64:
	if (entryCount === 0xFFFF || centralDirOffset === 0xFFFFFFFF || centralDirSize === 0xFFFFFFFF) {
		const locatorPos = eocdOffset - 20;
		if (locatorPos < 0) break checkZip64;

		const { view } = await _readChunk(locatorPos, 20);
		if (view.getUint32(0, true) !== 0x07064b50) break checkZip64;

		const zip64EocdPos = Number(view.getBigUint64(8, true));
		const { view: z64View } = await _readChunk(zip64EocdPos, 56);

		if (z64View.getUint32(0, true) !== 0x06064b50) break checkZip64;

		entryCount = Number(z64View.getBigUint64(32, true));
		centralDirSize = Number(z64View.getBigUint64(40, true));
		centralDirOffset = Number(z64View.getBigUint64(48, true));
	}

	const { view, buffer } = await _readChunk(centralDirOffset, centralDirSize);

	let prevObj;
	let p = 0;
	for (let i = 0; i < entryCount; i++) {
		if (p + 46 > centralDirSize) break;

		const sig = view.getUint32(p, true);
		if (sig !== 0x02014b50) break;

		const method = view.getUint16(p + 10, true);
		const time = view.getUint16(p + 12, true);
		const date = view.getUint16(p + 14, true);
		const crc32 = view.getUint32(p + 16, true);
		const compressedSize = view.getUint32(p + 20, true);
		const uncompressedSize = view.getUint32(p + 24, true);
		const nameLen = view.getUint16(p + 28, true);
		const extraLen = view.getUint16(p + 30, true);
		const commentLen = view.getUint16(p + 32, true);
		const localHeaderOffset = view.getUint32(p + 42, true);

		const name = UTF8_TEXT_DECODER.decode(buffer.slice(p + 46, p + 46 + nameLen));
		if (entries.has(name)) throw new Error("Duplicate file "+name);

		if (prevObj) prevObj.dataOffset = localHeaderOffset - prevObj.compressedSize;

		entries.set(name, prevObj = {
			compression: method,
			crc32,
			compressedSize,
			uncompressedSize,
			localHeaderOffset,
			lastModified: parseDosTime(date, time)
		});

		p += 46 + nameLen + extraLen + commentLen;
	}
	if (p !== centralDirSize) throw new Error("invalid END header (bad central directory size)");

	return {
		[ZIP_READER_SYMBOL]: blob,

		async getText(name) {
			const data = await this.get(name);
			if (!data) return;
			return UTF8_TEXT_DECODER.decode(data);
		},

		async getRaw(entry) {
			let dataOffset = entry.dataOffset;
			if (null == dataOffset) {
				// 读取 Local Header 来确定确切的数据起始位置
				// Local Header 定长 30 字节，后面跟着变长的文件名和额外字段
				const { view: locView } = await _readChunk(entry.localHeaderOffset, 30);
				if (locView.getUint32(0, true) !== 0x04034b50) throw new Error("Invalid Local Header signature");

				const locNameLen = locView.getUint16(26, true);
				const locExtraLen = locView.getUint16(28, true);
				dataOffset = entry.dataOffset = entry.localHeaderOffset + 30 + locNameLen + locExtraLen;
			}

			// 仅对该文件的数据部分进行 slice
			return blob.slice(dataOffset, dataOffset + entry.compressedSize);
		},

		/**
		 * 获取文件内容并解压，不验证CRC32
		 * @return {Promise<Uint8Array | Buffer>}
		 */
		async get(name) {
			const entry = entries.get(name);
			if (!entry) return null;

			const rawData = await this.getRaw(entry);

			const compression = entry.compression;
			if (compression === 8) { // Deflate
				const buf = decompressData(rawData);
				if (verify && crc32(buf) !== entry.crc32) throw new Error("Checksum error: "+name);
				return buf;
			} else if (compression === 0) { // Store
				const buf = isNode ? rawData : new Uint8Array(await rawData.arrayBuffer());
				if (verify && crc32(buf) !== entry.crc32) throw new Error("Checksum error: "+name);
				return buf;
			} else if (compression === 92 && isNode) {
				return new Promise((resolve, reject) => {
					zlib.brotliDecompress(rawData, (error, decompressed) => {
						if (error) reject(error);
						resolve(decompressed);
					});
				});
			} else {
				throw new Error(`Unsupported compression method: ${compression}`);
			}
		},

		entries() {return entries;}
	}
}

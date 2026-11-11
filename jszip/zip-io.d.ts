/**
 * Type definitions for zip-io
 * A modern ZIP reading/writing utility using Streams and native APIs.
 */

/**
 * Compute CRC32 checksum of binary data.
 */
export function crc32(data: Uint8Array): number;

/**
 * Options for adding a file via ZipWriter.
 */
export interface AddOptions {
    /**
     * Last modification time as a UNIX timestamp (milliseconds).
     * Defaults to the current time if omitted.
     */
    lastModified?: number;
    /**
     * Compression method for the file content.
     *
     * - `0` / `false` / omitted → Store
     * - `8` / `true` → Deflate
     * - `92` → Brotli (Node.js only)
     *
     * Note: if the compressed data is not smaller than the raw data,
     * the entry silently falls back to Store (`0`).
     *
     * @default 0 (Store)
     */
    compression?: number | boolean;
}

/**
 * A ZIP writer instance created by `ZipWriter()`.
 */
interface BaseZipWriterInstance {
    /**
     * Returns the number of files added so far.
     */
    fileCount(): number;

    /**
     * Finalize the archive and return a `Blob` representing the complete ZIP file.
     * @param [mimeType='application/zip']
     */
    finish(mimeType?: string): Blob;
}

export interface ZipWriterInstance extends BaseZipWriterInstance {
    /**
     * Add a file to the ZIP archive.
     * @param name - File path inside the archive.
     * @param content - File content as a UTF-8 string or raw bytes.
     * @param options - Optional settings (timestamp, compression).
     */
    add(
        name: string,
        content: string | Uint8Array,
        options?: AddOptions
    ): Promise<void>;

    /**
     * Copy an already-compressed entry from another archive into this one.
     * @param name - File path inside the new archive.
     * @param reader - Reader that owns `entry`.
     * @param entry - Entry from `reader.entries()`.
     */
    add(
        name: string,
        reader: ZipReaderInstance,
        entry: ZipEntry
    ): Promise<void>;
}

/**
 * A ZIP writer instance created by `ZipWriter(?writable)`.
 */
export interface StreamZipWriterInstance extends BaseZipWriterInstance {
    /**
     * Add a file to the ZIP archive.
     * @param name - File path inside the archive.
     * @param content - File content as a UTF-8 string or raw bytes.
     * @param options - Optional settings (timestamp, compression).
     * @returns a function to actually write file
     */
    add(
        name: string,
        content: string | Uint8Array,
        options?: AddOptions
    ): Promise<() => Promise<void>>;

    /**
     * Copy an already-compressed entry from another archive into this one.
     * @returns a function to actually write the file
     */
    add(
        name: string,
        reader: ZipReaderInstance,
        entry: ZipEntry
    ): Promise<() => Promise<void>>;
}

/**
 * Create a new ZIP writer.
 */
export function ZipWriter(): ZipWriterInstance;

/**
 * Create a new stream ZIP writer.
 */
export function ZipWriter(writable: WritableStreamDefaultWriter): StreamZipWriterInstance;

/**
 * Metadata about a file entry inside a ZIP archive.
 */
export interface ZipEntry {
    /**
     * Compression method: 0 = Store, 8 = Deflate, 92 = Brotli (Node.js only).
     */
    compression: number;
    /**
     * CRC32 checksum of the uncompressed content.
     */
    crc32: number;
    /**
     * Size of the compressed data in bytes.
     */
    compressedSize: number;
    /**
     * Size of the uncompressed content in bytes.
     */
    uncompressedSize: number;
    /**
     * Byte offset to the local file header.
     */
    localHeaderOffset: number;
    /**
     * Last modification time (derived from MS-DOS date/time fields).
     */
    lastModified: Date;
}

/**
 * A ZIP reader instance returned by `ZipReader()`.
 */
export interface ZipReaderInstance {
    /**
     * Retrieve an entry’s content and decode it as UTF-8 text.
     * @returns The string content, or `undefined` if the entry does not exist.
     */
    getText(name: string): Promise<string | undefined>;

    /**
     * Get the raw (still compressed) data for an entry.
     * In a browser environment this is a `Blob`;
     * in Node.js it is a `Buffer`.
     */
    getRaw(entry: ZipEntry): Promise<Blob | Buffer>;

    /**
     * Get the fully decompressed content of an entry.
     * @returns `Uint8Array` (browser) / `Buffer` (Node.js), or `null` if not found.
     */
    get(name: string): Promise<Uint8Array | Buffer | null>;

    /**
     * Return a `Map` of all entries (keyed by filename).
     */
    entries(): Map<string, ZipEntry>;
}

/**
 * Options for `ZipReader()`.
 */
export interface ZipReaderOptions {
    /**
     * Verify the CRC32 of every entry when it is decompressed.
     * @default false
     */
    verify?: boolean;
}

/**
 * Open a ZIP archive for reading.
 *
 * In a browser, pass a `Blob` object.
 * In Node.js, pass a `Buffer`.
 *
 * 注意：若传入的ZIP数据不符合规范（Unsorted_CD），会导致性能损失，并可能有bug。
 *
 * @returns A promise that resolves to a reader instance.
 */
export function ZipReader(
    blob: Blob | Buffer,
    options?: ZipReaderOptions
): Promise<ZipReaderInstance>;
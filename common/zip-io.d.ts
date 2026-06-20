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
    timestamp?: number;
    /**
     * Whether the file content should be Deflate-compressed.
     * Defaults to `false` (Store).
     * Use `8` or `true` for Deflate.
     * Use `92` for Brotli (Node.js Only)
     */
    compress?: boolean | number;
}

/**
 * A ZIP writer instance created by `ZipWriter()`.
 */
export interface ZipWriterInstance {
    /**
     * Returns the number of files added so far.
     */
    fileCount(): number;

    /**
     * Add a file to the ZIP archive.
     * @param name - File path inside the archive.
     * @param content - File content as an UTF-8 string or raw bytes.
     * @param options - Optional settings (timestamp, compression).
     */
    add(
        name: string,
        content: string | Uint8Array,
        options?: AddOptions
    ): Promise<void>;

    /**
     * Finalize the archive and return a `Blob` representing the complete ZIP file.
     */
    finish(): Blob;
}

/**
 * Create a new ZIP writer.
 */
export function ZipWriter(): ZipWriterInstance;

/**
 * Metadata about a file entry inside a ZIP archive.
 */
export interface ZipEntry {
    /**
     * Compression method: 0 = Store, 8 = Deflate.
     */
    method: number;
    /**
     * CRC32 checksum of the uncompressed content.
     */
    crc: number;
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
 * Open a ZIP archive for reading.
 *
 * In a browser, pass a `Blob` object.
 * In Node.js, pass a `Buffer`.
 *
 * @returns A promise that resolves to a reader instance.
 */
export function ZipReader(
    blob: Blob | Buffer
): Promise<ZipReaderInstance>;
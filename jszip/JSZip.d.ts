// Type definitions for the @roj234/jszip shim
// Original JSZip definitions by: mzeiher <https://github.com/mzeiher>, forabi <https://github.com/forabi>

/// <reference types="node" />

interface JSZipSupport {
    arraybuffer: boolean;
    uint8array: boolean;
    blob: boolean;
    nodebuffer: boolean;
}

type Compression = 'STORE' | 'DEFLATE';

interface InputByType {
    base64: string;
    string: string;
    text: string;
    binarystring: string;
    array: number[];
    uint8array: Uint8Array;
    arraybuffer: ArrayBuffer;
    blob: Blob;
}

interface OutputByType {
    base64: string;
    string: string;
    text: string;
    binarystring: string;
    array: number[];
    uint8array: Uint8Array;
    arraybuffer: ArrayBuffer;
    blob: Blob;
    nodebuffer: Buffer;
}

type InputFileFormat = InputByType[keyof InputByType] | Promise<InputByType[keyof InputByType]>;

declare class JSZip {
    files: {[key: string]: JSZip.JSZipObject};

    /**
     * Get a file from the archive
     *
     * @param path relative path to file
     * @return File matching path, null if no file found
     */
    file(path: string): JSZip.JSZipObject | null;

    /**
     * Get files matching a RegExp from archive
     *
     * @param path RegExp to match
     * @return Return all matching files or an empty array
     */
    file(path: RegExp): JSZip.JSZipObject[];

    /**
     * Add a file to the archive
     *
     * @param path Relative path to file
     * @param data Content of the file
     * @param options Optional information about the file
     * @return JSZip object
     */
    file<T extends JSZip.InputType>(path: string, data: InputByType[T], options?: JSZip.JSZipFileOptions): this;
    file(path: string, data: null, options?: JSZip.JSZipFileOptions & { dir: true }): this;

    /**
     * Returns an new JSZip instance with the given folder as root
     *
     * @param name Name of the folder
     * @return New JSZip object with the given folder as root
     */
    folder(name: string): JSZip;

    /**
     * Returns new JSZip instances with the matching folders as root
     *
     * @param name RegExp to match
     * @return New array of JSZipFile objects which match the RegExp
     */
    folder(name: RegExp): JSZip.JSZipObject[];

    /**
     * Call a callback function for each entry at this folder level.
     *
     * @param callback function
     */
    forEach(callback: (relativePath: string, file: JSZip.JSZipObject) => void): void;

    /**
     * Get all files which match the given filter function
     *
     * @param predicate Filter function
     * @return Array of matched elements
     */
    filter(predicate: (relativePath: string, file: JSZip.JSZipObject) => boolean): JSZip.JSZipObject[];

    /**
     * Removes the file or folder from the archive
     *
     * @param path Relative path of file or folder
     * @return Returns the JSZip instance
     */
    remove(path: string): JSZip;

    /**
     * Generates a new archive asynchronously
     *
     * @param options Options for the generator. `type` is required by this shim.
     * @param onUpdate The optional function called on each internal update.
     * @return The serialized archive
     */
    generateAsync<T extends JSZip.OutputType>(options: JSZip.JSZipGeneratorOptions<T>, onUpdate?: JSZip.OnUpdateCallback): Promise<OutputByType[T]>;

    /**
     * Deserialize zip file asynchronously
     *
     * @param data Serialized zip file
     * @param options Options for deserializing
     * @return Returns promise
     */
    loadAsync(data: InputFileFormat, options?: JSZip.JSZipLoadOptions): Promise<JSZip>;

    static version: string;
    static support: JSZipSupport;
    static loadAsync(data: InputFileFormat, options?: JSZip.JSZipLoadOptions): Promise<JSZip>;
}

declare namespace JSZip {
    type InputType = keyof InputByType;

    type OutputType = keyof OutputByType;

    /**
     * Called by `generateAsync` after each file was written.
     * Note: this shim passes plain values, not a metadata object.
     *
     * @param percent Progress in percent
     * @param currentFile Name of the file that was just added
     */
    type OnUpdateCallback = (percent: number, currentFile: string) => void;

    interface JSZipObject {
        name: string;
        dir: boolean;
        date: Date;
        comment?: string;
        options: JSZipObjectOptions;

        /**
         * Prepare the content in the asked type.
         * @param type the type of the result.
         * @return Promise the promise of the result.
         */
        async<T extends OutputType>(type: T): Promise<OutputByType[T]>;
    }

    interface JSZipFileOptions {
        /** Set to `true` if the data is `base64` encoded. */
        base64?: boolean;
        /**
         * The last modification date, defaults to the current date.
         */
        date?: Date;
        /**
         * Sets per file compression.
         */
        compression?: Compression;
        /** Set to `true` if folders in the file path should be automatically created. */
        createFolders?: boolean;
        /** Set to `true` if this is a directory and content should be ignored. */
        dir?: boolean;
    }

    interface JSZipObjectOptions {
        compression?: Compression;
    }

    interface JSZipGeneratorOptions<T extends OutputType = OutputType> {
        /** Output type of the generated archive. Required by this shim. */
        type: T;
        /**
         * Sets compression option for all entries that have not specified their own `compression` option
         */
        compression?: Compression;
        /**
         * mime-type for the generated file.
         * @default 'application/zip'
         */
        mimeType?: string;
    }

    interface JSZipLoadOptions {
        base64?: boolean;
        checkCRC32?: boolean;
    }
}

export = JSZip;
/**
 * Type definitions for msgpack.js – a MsgPack encode & decode library.
 */

/**
 * A MsgPack schema: an ordered list of field names.
 * Each element can be either a string (field name) or a tuple `[fieldName, subSchema, valueSchema?]`.
 *
 * After being processed by `bakeSchema`, the array gains a `locate` method for fast key lookup.
 */
export type MsgpackSchema = (string | [string, MsgpackSchema?, MsgpackSchema?])[] & {
    /**
     * Look up the index of a field name. Returns -1 if not found.
     */
    locate(key: string): number;
};

/**
 * Prepare a schema for encoding/decoding by adding a `locate` method to it.
 * The schema is mutated in place.
 */
export function bakeSchema(
    schema: (string | [string, MsgpackSchema?, MsgpackSchema?])[]
): void;

/**
 * Options for decoding a MsgPack message.
 */
export interface MsgpackDecodeOptions {
    /**
     * If true, use `bigint` for integers larger than `Number.MAX_SAFE_INTEGER`.
     * Otherwise convert them to `number` (may lose precision).
     * @default false
     */
    bigint?: boolean;
    /**
     * Schema that allows using integer keys for object fields (reduces output size).
     * Should be prepared via `bakeSchema` beforehand.
     * @default null
     */
    schema?: MsgpackSchema | null;
    /**
     * Custom extension type decoder.
     * Receives (dataView, extType, offset, length) and must return the decoded value.
     * If not provided, unknown extension types throw an Error.
     */
    decodeExt?: (
        dataView: DataView,
        type: number,
        offset: number,
        length: number
    ) => any;
    /**
     * If true, decode multiple consecutive objects until the end of the input.
     * @default false
     */
    multiple?: boolean;
}

/** Supported input types for decoding. */
export type MsgpackInput = number[] | ArrayBufferView | DataView | Buffer;

/**
 * Decode a MsgPack‑encoded message.
 *
 * When `options.multiple` is true, returns an array of consecutive decoded values.
 * Otherwise returns a single decoded value.
 */
export function decodeMsg(
    input: MsgpackInput,
    options?: MsgpackDecodeOptions & { multiple: true }
): any[];
export function decodeMsg(
    input: MsgpackInput,
    options?: MsgpackDecodeOptions
): any;

/**
 * Low‑level decoder that reads a single MsgPack value starting at a given offset.
 * Returns a tuple `[value, newOffset]`.
 */
export function decodeRawMsg(
    buf: DataView,
    offset: number,
    options?: MsgpackDecodeOptions
): [any, number];

/**
 * Low‑level streaming encoder that writes encoded chunks via a callback.
 *
 * @param data      The value to encode.
 * @param onChunk   Callback invoked with each encoded chunk (`Uint8Array`).
 *                  The second argument (`shared`) is `true` for internal shared buffer,
 *                  如果需要在异步函数中使用，请先复制一份.
 * @param schema    Optional schema for integer‑key encoding of objects.
 * @param replacer  Hook to transform objects before encoding.
 *                  Receives the object and must return the (possibly modified) object.
 *                  If not provided, the identity function is used.
 */
export function encodeRawMsg(
    data: any,
    onChunk: (chunk: Uint8Array, shared?: boolean) => void,
    schema?: MsgpackSchema,
    replacer?: (obj: object) => object
): void;

/**
 * Encode a value into a single MsgPack `Uint8Array`.
 *
 * @param data      The value to encode.
 * @param schema    Optional schema for integer‑key encoding of objects.
 * @param replacer  Hook to transform objects before encoding.
 *                  Receives the object and must return the (possibly modified) object.
 *                  If not provided, the identity function is used.
 * @returns         The complete MsgPack‑encoded data as `Uint8Array`.
 */
export function encodeMsg(
    data: any,
    schema?: MsgpackSchema,
    replacer?: (obj: object) => object
): Uint8Array;
/**
 * 流式 Base64 编码器实例
 *
 * 用于分块输入二进制数据、逐步产出 Base64 编码片段，
 * 最后调用 `finish()` 获取尾部（含 padding）的编码结果。
 */
export interface StreamBase64EncoderInstance {
    /**
     * 对输入数据块进行 Base64 编码。
     *
     * 这是一个生成器函数，每次调用 `next()` 会 yield 一个
     * `Uint8Array` 视图（共享内部缓冲区），包含本次编码产出的完整片段。
     * 不满 3 字节的尾部会被保留，等待下一次 `encode()` 或 `finish()` 处理。
     *
     * @param input - 待编码的原始字节
     * @yields 编码后的 Base64 字节
     */
    encode(input: Uint8Array): Generator<Uint8Array, void>;

    /**
     * 结束编码，处理剩余的尾部字节并补齐填充。
     * 调用后编码器状态重置，可继续用于新的编码流程。
     *
     * @returns 尾部编码结果（含 padding），可能为空
     */
    finish(): Uint8Array;
}

/**
 * 流式 Base64 解码器实例
 *
 * 用于分块输入 Base64 字符串、逐步产出解码后的二进制数据片段，
 * 最后调用 `finish()` 处理尾部残留字节并重置解码器。
 */
export interface StreamBase64DecoderInstance {
    /**
     * 对输入的 Base64 字符串进行解码。
     *
     * 这是一个生成器函数，每次调用 `next()` 会 yield 一个
     * `Uint8Array` 视图（共享内部缓冲区），包含本次解码所产出的完整字节。
     * 解码过程中遇到的不完整组或尾部填充会被保留，等待下一次 `decode()` 或 `finish()` 处理。
     *
     * @param input - Base64 编码的字符串
     * @yields 解码后的原始字节
     */
    decode(input: string): Generator<Uint8Array, void>;

    /**
     * 结束解码，处理剩余的残留字节。
     * 调用后解码器状态重置，可继续用于新的解码流程。
     *
     * @returns 尾部解码结果，可能为空
     */
    finish(): Uint8Array;
}

/**
 * 创建一个流式 Base64 编码器。
 *
 * - 注意：yield的是共享切片
 *
 * @param [urlSafe=false]
 * @param [bufferCapacity=1024] - 内部缓冲区容量
 *        解码器每次 `yield` 的字节片段大小大约为该值向下取整到 3 的倍数。
 *        调大可以减少 `yield` 频次，调小可降低内存占用。
 * @returns 编码器实例，包含 `encode()` 生成器和 `finish()` 方法。
 *
 * @example
 * ```typescript
 * const encoder = createBase64Encoder();
 * for (const chunk of encoder.encode(someUint8Array)) {
 *   // chunk 是 Uint8Array，可直接转为字符串或写入流
 *   process.stdout.write(chunk);
 * }
 * const tail = encoder.finish();
 * process.stdout.write(tail);
 * ```
 */
export function createBase64Encoder(
    urlSafe?: boolean,
    bufferCapacity?: number,
): StreamBase64EncoderInstance;

/**
 * 创建一个流式 Base64 解码器。
 *
 * - 注意：yield的是共享切片
 *
 * @param [bufferCapacity=1024] - 内部缓冲区容量
 *        解码器每次 `yield` 的字节片段大小大约为该值向下取整到 3 的倍数。
 *        调大可以减少 `yield` 频次，调小可降低内存占用。
 *
 * @example
 * ```typescript
 * const decoder = createBase64Decoder();
 * for (const bytes of decoder.decode("SGVsbG8gV29ybGQ=")) {
 *   // bytes 是一段解码后的 Uint8Array，可以继续拼接或写入流
 *   process.stdout.write(bytes);
 * }
 * const tail = decoder.finish();
 * process.stdout.write(tail);
 * ```
 */
export function createBase64Decoder(
    bufferCapacity?: number,
): StreamBase64DecoderInstance;

/**
 * 将输入数据编码为 Base64 字符串。
 *
 * @param input - 要编码的原始数据，可以是字符串（UTF-8 编码）或 Uint8Array
 * @param [urlSafe=false] - 使用 URL 安全的 Base64 字符集（将 +/ 替换为 -_，并省略末尾的 `=` 填充）
 * @param [bufferCapacity=1024] - 编码缓冲区容量，适当调大可能提高性能。
 *
 * @example
 * ```typescript
 * base64Encode("Hello World"); // "SGVsbG8gV29ybGQ="
 * base64Encode(new Uint8Array([72, 101, 108, 108, 111])); // "SGVsbG8="
 * base64Encode("test", true); // "dGVzdA"  (urlSafe, no padding)
 * ```
 */
export function base64Encode(
    input: string | Uint8Array,
    urlSafe?: boolean,
    bufferCapacity?: number
): string;

/**
 * 将 Base64 字符串或二进制数据解码为 Uint8Array。
 *
 * @param input
 * @param [bufferCapacity=4096] - 解码缓冲区容量。适当调大可能提高性能。
 *
 * @example
 * ```typescript
 * const bytes = base64DecodeToUint8Array("SGVsbG8="); // Uint8Array([72, 101, 108, 108, 111])
 * ```
 */
export function base64DecodeToUint8Array(
    input: string | Uint8Array,
    bufferCapacity?: number
): Uint8Array;

/**
 * 将 Base64 数据解码为指定字符集的字符串。
 *
 * @param input
 * @param [charset="utf-8"] - 输出字符串的编码。
 * @param [bufferCapacity=4096] - 解码缓冲区容量。适当调大可能提高性能。
 *
 * @example
 * ```typescript
 * const text = base64DecodeToString("SGVsbG8gV29ybGQ="); // "Hello World"
 * const text = base64DecodeToString("5L2g5aW9", 'utf-8'); // "你好"
 * ```
 */
export function base64DecodeToString(
    input: string | Uint8Array,
    charset?: string,
    bufferCapacity?: number
): string;
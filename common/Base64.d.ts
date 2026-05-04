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
     * @yields 编码后的 Base64 字节（不含尾部残留）
     */
    encode(input: Uint8Array): Generator<Uint8Array, void, unknown>;

    /**
     * 结束编码，处理剩余的 1~2 个尾部字节并补齐 `=` 填充。
     *
     * 调用后编码器状态重置，可继续用于新的编码流程。
     *
     * @returns 尾部编码结果（含 padding），可能为空 `Uint8Array`
     */
    finish(): Uint8Array;
}

/**
 * 创建一个流式 Base64 编码器。
 *
 * @param bufferCapacity - 内部缓冲区容量（字节），默认 `1024`。
 *                         编码器产出片段的大小大约为 `bufferCapacity` 向下取整到 4 的倍数。
 *                         调大可以减少 `yield` 频次，调小可降低内存占用。
 * @returns 编码器实例，包含 `encode()` 生成器和 `finish()` 方法。
 *
 * @example
 * ```typescript
 * const encoder = Base64Encoder(256);
 * for (const chunk of encoder.encode(someUint8Array)) {
 *   // chunk 是 Uint8Array，可直接转为字符串或写入流
 *   process.stdout.write(chunk);
 * }
 * const tail = encoder.finish();
 * process.stdout.write(tail);
 * ```
 */
export function createBase64Encoder(
    bufferCapacity?: number,
): StreamBase64EncoderInstance;
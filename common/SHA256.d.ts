/**
 * 高性能 SHA256 计算，吞吐量(>=100K)可达 subtleCrypto 的三分之一
 */
export class SHA256 {
    /**
     * 追加数据
     */
    update(data: string | Uint8Array): this;
    /**
     * 完成哈希计算并返回结果
     */
    digest(format?: 'hex' | 'arraybuffer' = 'arraybuffer'): string | ArrayBuffer;
    /**
     * 直接进行计算
     */
    static hash(data: string | Uint8Array, format?: 'hex' | 'arraybuffer' = 'arraybuffer'): string | ArrayBuffer;
}
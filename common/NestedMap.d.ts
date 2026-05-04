export class NestedMap<K = any, V = any> {
    /**
     * @param entries 可选的初始 [键, 值] 对迭代器。
     * 键可以是单值，也可以是数组（复合键）。
     */
    constructor(entries?: Iterable<readonly [K | K[], V]> | null);

    /**
     * 设置值。
     * @param keys 单键或复合键（数组）。
     * @param value
     * @returns 当前实例（支持链式调用）。
     */
    set(keys: K | K[], value: V): this;

    /**
     * 获取值。
     * @param keys 单键或复合键（数组）。
     * @returns 对应的值，不存在则返回 `undefined`。
     */
    get(keys: K | K[]): V | undefined;

    /**
     * 判断键是否存在。
     * @param keys 单键或复合键（数组）。
     */
    has(keys: K | K[]): boolean;

    /**
     * 删除键值对。
     * @param keys 单键或复合键（数组）。
     * @returns 删除成功返回 `true`，键不存在则返回 `false`。
     */
    delete(keys: K | K[]): boolean;

    /** 储存的键值对总数。 */
    readonly size: number;

    /**
     * 深度优先遍历所有条目。
     * 迭代时返回的键对于复合键是数组路径，对于简单键是原始单值。
     */
    [Symbol.iterator](): IterableIterator<[K | K[], V]>;

    /** 清空所有键值对。 */
    clear(): void;
}
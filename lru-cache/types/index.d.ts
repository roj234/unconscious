

export const TYPE_EVICT: 1;
export const TYPE_REMOVE: 2;

type LRUCacheEvictCallback = (value: V, key: K, reason: TYPE_EVICT | TYPE_REMOVE) => void;
type ArrayLike = ArrayConstructor | Int8ArrayConstructor | Uint8ArrayConstructor | Int16ArrayConstructor | Uint16ArrayConstructor | Int32ArrayConstructor | Uint32ArrayConstructor;

type LRUCacheOptions = {
    onEvict?: LRUCacheEvictCallback,
    keyType?: ArrayLike,
    valueType?: ArrayLike,
    ttlMode?: 'update' | 'access' | 'livetime',
}

export class LRUCache<K, V> extends Map<K, V> {
    constructor(capacity: number, options?: LRUCacheOptions | LRUCacheEvictCallback);

    get capacity(): number;

    set(key: K, value: V, ttlMs?: number): LRUCache<K, V>;
}

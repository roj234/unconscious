

export const TYPE_EVICT = 1 as const;
export const TYPE_REMOVE = 2 as const;

export type EvictReason = typeof TYPE_EVICT | typeof TYPE_REMOVE;

type LRUCacheEvictCallback<K, V> = (value: V, key: K, reason: EvictReason) => void;
type ArrayLike = ArrayConstructor | Int8ArrayConstructor | Uint8ArrayConstructor | Int16ArrayConstructor | Uint16ArrayConstructor | Int32ArrayConstructor | Uint32ArrayConstructor;

type LRUCacheOptions<K, V> = {
    onEvict?: LRUCacheEvictCallback<K, V>,
    keyType?: ArrayLike,
    valueType?: ArrayLike,
    ttlMode?: 'update' | 'access' | 'livetime',
}

export class LRUCache<K, V> extends Map<K, V> {
    constructor(capacity: number, options?: LRUCacheOptions<K, V> | LRUCacheEvictCallback<K, V>);

    get capacity(): number;

    set(key: K, value: V, ttlMs?: number): LRUCache<K, V>;
}

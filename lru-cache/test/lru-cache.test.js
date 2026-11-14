import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LRUCache, TYPE_EVICT, TYPE_REMOVE} from '../index.js';

const keys = cache => [...cache.keys()];

test('构造函数校验容量', () => {
	assert.throws(() => new LRUCache(0), RangeError);
	assert.throws(() => new LRUCache(-1), RangeError);
	assert.throws(() => new LRUCache(65536), RangeError);
	assert.throws(() => new LRUCache(2.5), TypeError);
	assert.throws(() => new LRUCache(NaN), TypeError);
	assert.throws(() => new LRUCache('3'), TypeError);
});

test('capacity 边界值可用', () => {
	for (const capacity of [1, 255, 256, 65535]) {
		const cache = new LRUCache(capacity);
		assert.equal(cache.capacity, capacity);
		assert.equal(cache.size, 0);
	}
});

test('非法 ttlMode 报错，合法值正常工作', () => {
	assert.throws(() => new LRUCache(2, {ttlMode: 'nope'}), TypeError);
	for (const ttlMode of ['update', 'access', 'livetime']) {
		assert.equal(new LRUCache(2, {ttlMode}).capacity, 2);
	}
});

test('基本 set / get / size / has', () => {
	const cache = new LRUCache(4);
	assert.equal(cache.set('a', 1), cache, 'set 应返回自身以便链式调用');
	cache.set('b', 2);
	assert.equal(cache.size, 2);
	assert.equal(cache.get('a'), 1);
	assert.equal(cache.get('missing'), undefined);
	assert.equal(cache.has('b'), true);
	assert.equal(cache.has('missing'), false);
});

test('覆盖已有 key 不会增长也不触发驱逐', () => {
	const events = [];
	const cache = new LRUCache(2, {onEvict: (v, k, r) => events.push([k, v, r])});
	cache.set('a', 1).set('b', 2);
	cache.set('a', 3);
	assert.equal(cache.size, 2);
	assert.equal(cache.get('a'), 3);
	assert.deepEqual(events, []);
	assert.deepEqual(keys(cache), ['a', 'b'], '覆盖已有 key 应把该 key 提到最前');
});

test('迭代顺序：最近使用 → 最久未用', () => {
	const cache = new LRUCache(4);
	cache.set('a', 1).set('b', 2).set('c', 3);
	assert.deepEqual(keys(cache), ['c', 'b', 'a']);
	assert.deepEqual([...cache.values()], [3, 2, 1]);
	assert.deepEqual([...cache.entries()], [['c', 3], ['b', 2], ['a', 1]]);
	assert.deepEqual([...cache], [['c', 3], ['b', 2], ['a', 1]], '默认迭代器应等价于 entries()');
	assert.deepEqual(keys(cache), ['c', 'b', 'a'], '迭代不应改变顺序');
});

test('get 会把命中的 key 提到最前', () => {
	const cache = new LRUCache(3);
	cache.set('a', 1).set('b', 2).set('c', 3);
	assert.equal(cache.get('a'), 1);
	assert.deepEqual(keys(cache), ['a', 'c', 'b']);
	cache.get('a');
	assert.deepEqual(keys(cache), ['a', 'c', 'b'], '已是最前时再 get 不改变顺序');
});

test('forEach 回调参数与顺序', () => {
	const cache = new LRUCache(2);
	cache.set('a', 1).set('b', 2);
	const seen = [];
	cache.forEach(function (value, key, self) {
		seen.push([key, value, self === cache, this?.tag]);
	}, {tag: 'ctx'});
	assert.deepEqual(seen, [['b', 2, true, 'ctx'], ['a', 1, true, 'ctx']]);
});

test('容量满时按 LRU 顺序驱逐并回调 TYPE_EVICT', () => {
	const events = [];
	const cache = new LRUCache(2, {onEvict: (v, k, r) => events.push([k, v, r])});
	cache.set('a', 1).set('b', 2);
	cache.get('a'); // a 变为最新
	cache.set('c', 3); // 应驱逐 b
	assert.deepEqual(keys(cache), ['c', 'a']);
	assert.deepEqual(events, [['b', 2, TYPE_EVICT]]);
	assert.equal(cache.has('b'), false);
});

test('onEvict 可以直接传函数', () => {
	const events = [];
	const cache = new LRUCache(1, (v, k, r) => events.push([k, v, r]));
	cache.set('a', 1).set('b', 2);
	assert.deepEqual(events, [['a', 1, TYPE_EVICT]]);
});

test('delete 返回是否命中，并回调 TYPE_REMOVE', () => {
	const events = [];
	const cache = new LRUCache(2, {onEvict: (v, k, r) => events.push([k, v, r])});
	cache.set('a', 1).set('b', 2);
	assert.equal(cache.delete('a'), true);
	assert.equal(cache.delete('a'), false);
	assert.deepEqual(keys(cache), ['b']);
	assert.deepEqual(events, [['a', 1, TYPE_REMOVE]]);
});

test('删除后空出的槽位可以复用', () => {
	const cache = new LRUCache(2);
	cache.set('a', 1).set('b', 2);
	cache.delete('a');
	cache.set('c', 3).set('d', 4); // 只应驱逐 b
	assert.deepEqual(keys(cache), ['d', 'c']);
	assert.equal(cache.size, 2);
});

test('clear 清空并逐个回调 TYPE_REMOVE', () => {
	const events = [];
	const cache = new LRUCache(4, {onEvict: (v, k, r) => events.push([k, v, r])});
	cache.set('a', 1).set('b', 2);
	cache.clear();
	assert.equal(cache.size, 0);
	assert.deepEqual([...cache], []);
	assert.deepEqual(events, [['a', 1, TYPE_REMOVE], ['b', 2, TYPE_REMOVE]]);
	cache.set('c', 3);
	assert.deepEqual(keys(cache), ['c']);
});

test('值为 undefined 的 key 仍然存在', () => {
	const cache = new LRUCache(2);
	cache.set('a', undefined);
	assert.equal(cache.has('a'), true);
	assert.equal(cache.get('a'), undefined);
	assert.deepEqual([...cache.entries()], [['a', undefined]]);
});

test('支持 undefined 作为 key', () => {
	const cache = new LRUCache(2);
	cache.set(undefined, 'x');
	assert.equal(cache.get(undefined), 'x');
	assert.equal(cache.delete(undefined), true);
});

test('keyType / valueType 支持 TypedArray', () => {
	const cache = new LRUCache(3, {keyType: Uint32Array, valueType: Int32Array});
	cache.set(1, 100).set(2, 200);
	assert.deepEqual([...cache.entries()], [[2, 200], [1, 100]]);
	cache.get(1);
	assert.deepEqual(keys(cache), [1, 2]);
	assert.equal(cache.get(2), 200);
	cache.delete(2);
	cache.set(3, 300);
	assert.deepEqual([...cache.entries()], [[3, 300], [1, 100]]);
});

test('容量 255/256 使用不同索引宽度的边界', () => {
	for (const capacity of [255, 256]) {
		const cache = new LRUCache(capacity);
		for (let i = 0; i < capacity; i++) cache.set(i, i);
		assert.equal(cache.size, capacity);
		assert.equal(cache.get(capacity - 1), capacity - 1, '最新的值可读');
		cache.set(capacity, capacity); // 触发驱逐最久未用的 0
		assert.equal(cache.size, capacity);
		assert.equal(cache.has(0), false, '最久未用的 0 应被驱逐');
		assert.equal(cache.get(capacity), capacity);
	}
});

test('LRUCache 的 toStringTag', () => {
	const cache = new LRUCache(1);
	assert.equal(Object.prototype.toString.call(cache), '[object LRUCache]');
});

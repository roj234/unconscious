import {test} from 'node:test';
import assert from 'node:assert/strict';

// ── 虚拟时钟 ──────────────────────────────────────────────────────────────
// lru-cache 在模块求值时捕获全局 setTimeout / clearTimeout，所以必须
// 在导入前替换。导入完成后立刻还原全局，避免影响 node:test 自身。
let now = 0;
let seq = 0;
const timers = new Map();

const fakeSetTimeout = (fn, delay) => {
	const handle = {
		__id: ++seq,
		fn,
		delay,
		time: now + delay,
		refresh() { this.time = now + this.delay; },
		unref() { return this; },
		ref() { return this; },
	};
	timers.set(handle.__id, handle);
	return handle;
};
const fakeClearTimeout = handle => {
	if (handle) timers.delete(handle.__id);
};

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = fakeSetTimeout;
globalThis.clearTimeout = fakeClearTimeout;
const {LRUCache, TYPE_EVICT, TYPE_REMOVE} = await import('../index.js?virtual-timers');
globalThis.setTimeout = realSetTimeout;
globalThis.clearTimeout = realClearTimeout;

/** 推进虚拟时钟，按到期时间顺序执行回调。 */
function advance(ms) {
	const target = now + ms;
	for (;;) {
		let next = null;
		for (const task of timers.values()) {
			if (task.time <= target && (!next || task.time < next.time)) next = task;
		}
		if (!next) break;
		now = next.time;
		timers.delete(next.__id);
		next.fn();
	}
	now = target;
}

/** 每个 test 开始时重置时钟。 */
function fresh(capacity, options) {
	now = 0;
	timers.clear();
	return new LRUCache(capacity, options);
}

test('ttlMode=update：到期后自动删除，并回调 TYPE_REMOVE', () => {
	const events = [];
	const cache = fresh(2, {ttlMode: 'update', onEvict: (v, k, r) => events.push([k, v, r])});
	cache.set('a', 1, 10);
	advance(9);
	assert.equal(cache.get('a'), 1);
	advance(2);
	assert.equal(cache.get('a'), undefined);
	assert.equal(cache.size, 0);
	assert.deepEqual(events, [['a', 1, TYPE_REMOVE]]);
});

test('ttlMode=update：重新 set 会重置到期时间', () => {
	const cache = fresh(2, {ttlMode: 'update'});
	cache.set('a', 1, 10);
	advance(5);
	cache.set('a', 2, 10);
	advance(8); // 相对第二次 set 才过 8ms
	assert.equal(cache.get('a'), 2);
	advance(3); // 累计 11ms
	assert.equal(cache.get('a'), undefined);
});

test('ttlMode=update：重设时不传 ttl 会清掉旧 TTL', () => {
	const cache = fresh(2, {ttlMode: 'update'});
	cache.set('a', 1, 10);
	advance(5);
	cache.set('a', 2);
	advance(100);
	assert.equal(cache.get('a'), 2, '没有 TTL 的条目不应过期');
});

test('ttlMode=update：get 不会延长 TTL', () => {
	const cache = fresh(2, {ttlMode: 'update'});
	cache.set('a', 1, 10);
	advance(8);
	cache.get('a');
	advance(3); // 距 set 已 11ms
	assert.equal(cache.get('a'), undefined);
});

test('ttlMode=access：get 会按原 ttl 续期', () => {
	const cache = fresh(2, {ttlMode: 'access'});
	cache.set('a', 1, 10);
	advance(8);
	assert.equal(cache.get('a'), 1); // 续期到 now+10
	advance(8);
	assert.equal(cache.get('a'), 1);
	advance(11); // 距最后一次 get 11ms
	assert.equal(cache.get('a'), undefined);
});

test('ttlMode=access：set 也会重置 TTL', () => {
	const cache = fresh(2, {ttlMode: 'access'});
	cache.set('a', 1, 10);
	advance(9);
	cache.set('a', 2, 10);
	advance(9);
	assert.equal(cache.get('a'), 2);
});

test('ttlMode=livetime：值不变时保留旧 TTL', () => {
	const cache = fresh(2, {ttlMode: 'livetime'});
	cache.set('a', 1, 10);
	advance(5);
	cache.set('a', 1); // 同值，不传 ttl
	assert.equal(cache.get('a'), 1);
	advance(6); // 距首次 set 已 11ms
	assert.equal(cache.get('a'), undefined);
});

test('ttlMode=livetime：值变化时按新 ttl（含未传=清除）重设', () => {
	const cache = fresh(2, {ttlMode: 'livetime'});
	cache.set('a', 1, 10);
	advance(5);
	cache.set('a', 2, 10); // 值变了，续期到 15
	advance(8);
	assert.equal(cache.get('a'), 2);
	advance(3);
	assert.equal(cache.get('a'), undefined);

	const cache2 = fresh(2, {ttlMode: 'livetime'});
	cache2.set('a', 1, 10);
	cache2.set('a', 2); // 值变了但不传 ttl → 清掉 TTL
	advance(100);
	assert.equal(cache2.get('a'), 2);
});

test('delete 会取消 pending 的过期定时器', () => {
	const events = [];
	const cache = fresh(2, {ttlMode: 'update', onEvict: (v, k, r) => events.push([k, v, r])});
	cache.set('a', 1, 10);
	cache.delete('a');
	advance(50);
	assert.deepEqual(events, [['a', 1, TYPE_REMOVE]], '只应有 delete 产生的一次回调');
});

test('clear 会取消所有 pending 定时器', () => {
	const events = [];
	const cache = fresh(3, {ttlMode: 'update', onEvict: (v, k, r) => events.push([k, v, r])});
	cache.set('a', 1, 10);
	cache.set('b', 2, 20);
	cache.clear();
	advance(100);
	assert.equal(cache.size, 0);
	assert.deepEqual(
		events.sort(),
		[['a', 1, TYPE_REMOVE], ['b', 2, TYPE_REMOVE]],
	);
});

test('TTL 驱逐后槽位复用不会误删新值', () => {
	const cache = fresh(1, {ttlMode: 'update'});
	cache.set('a', 1, 10);
	cache.set('b', 2, 100); // 驱逐 a，复用同一个槽位
	advance(10); // a 的旧定时器此时到期
	assert.equal(cache.get('b'), 2, 'b 不应被 a 的旧定时器删掉');
	assert.equal(cache.size, 1);
});

test('TTL 条目被容量驱逐时只回调一次 TYPE_EVICT', () => {
	const events = [];
	const cache = fresh(1, {ttlMode: 'update', onEvict: (v, k, r) => events.push([k, v, r])});
	cache.set('a', 1, 10);
	cache.set('b', 2, 100);
	assert.deepEqual(events, [['a', 1, TYPE_EVICT]]);
	advance(10);
	assert.deepEqual(events, [['a', 1, TYPE_EVICT]], '旧定时器不应再触发');
});

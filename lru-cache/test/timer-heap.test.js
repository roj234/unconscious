import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TimerHeap} from '../TimerHeap.js';

const task = (time, name) => ({time, name});

test('push / peek / shift 保持按时间升序', () => {
	const heap = new TimerHeap();
	for (const t of [task(5, 'e'), task(1, 'a'), task(3, 'c'), task(2, 'b'), task(4, 'd')]) {
		heap.push(t);
	}
	assert.equal(heap.peek().name, 'a');
	const order = [];
	while (heap.peek()) {
		order.push(heap.peek().name);
		heap.shift();
	}
	assert.deepEqual(order, ['a', 'b', 'c', 'd', 'e']);
	assert.equal(heap.peek(), undefined);
});

test('空堆 peek / shift 是安全的', () => {
	const heap = new TimerHeap();
	assert.equal(heap.peek(), undefined);
	heap.shift();
	assert.equal(heap.peek(), undefined);
});

test('cancel 堆顶任务会立即移除并返回 true', () => {
	const heap = new TimerHeap();
	const a = task(1, 'a');
	const b = task(2, 'b');
	heap.push(b);
	heap.push(a);
	assert.equal(heap.cancel(a), true);
	assert.equal(heap.peek().name, 'b');
});

test('cancel 非堆顶任务只是标记，peek 时会清理', () => {
	const heap = new TimerHeap();
	const a = task(1, 'a');
	const b = task(2, 'b');
	const c = task(3, 'c');
	heap.push(a);
	heap.push(b);
	heap.push(c);
	assert.notEqual(heap.cancel(c), true, '非堆顶任务不应要求重新调度');
	assert.equal(c.cancelled, true);
	assert.equal(heap.peek().name, 'a');
	heap.shift();
	heap.shift();
	assert.equal(heap.peek(), undefined, '被取消的任务不应被取出');
});

test('取消堆顶后，下一个被取消的堆顶会连续跳过', () => {
	const heap = new TimerHeap();
	const a = task(1, 'a');
	const b = task(2, 'b');
	heap.push(a);
	heap.push(b);
	heap.cancel(a);
	heap.cancel(b); // b 现在是堆顶
	assert.equal(heap.peek(), undefined);
});

test('init 能把手工打乱的数据重新堆化', () => {
	const heap = new TimerHeap();
	heap.heap = [task(9, 'i'), task(1, 'a'), task(5, 'e'), task(3, 'c'), task(7, 'g')];
	heap.init();
	const order = [];
	while (heap.peek()) {
		order.push(heap.peek().name);
		heap.shift();
	}
	assert.deepEqual(order, ['a', 'c', 'e', 'g', 'i']);
});

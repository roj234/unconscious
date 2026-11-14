
export const EMPTY = Symbol('NestedMap.empty');

// 固定字段列表方便优化
/**
 *
 * @return {{c: null | Map, v: symbol | any}}
 * @constructor
 */
const Empty = () => ({ v: EMPTY, c: null });

export class NestedMap {
	#root = Empty();
	#size = 0;

	constructor(entries) {
		if (entries) for (const [keys, value] of entries) {
			this.set(keys, value);
		}
	}

	get size() {return this.#size;}

	set(keys, value) {
		let node = this.#root;

		if (Array.isArray(keys)) {
			for (let i = 0, len = keys.length; i < len; i++) {
				const c = node.c ??= new Map();
				const k = keys[i];
				const next = c.get(k);
				if (!next) c.set(k, node = Empty());
				else node = next;
			}
		} else {
			const c = node.c ??= new Map();
			const next = c.get(keys);
			if (!next) c.set(keys, node = Empty());
			else node = next;
		}

		if (node.v === EMPTY) this.#size++;
		node.v = value;
		return this;
	}

	get(keys) {
		const v = this.getChildren(keys)?.v;
		return v === EMPTY ? undefined : v;
	}

	has(keys) {
		const node = this.getChildren(keys);
		return node && node.v !== EMPTY;
	}

	getChildren(keys) {
		let node = this.#root;

		if (Array.isArray(keys)) {
			for (let i = 0, len = keys.length; i < len; i++) {
				node = node.c?.get(keys[i]);
				if (!node) return;
			}
		} else {
			node = node.c?.get(keys);
		}

		return node;
	}

	delete(keys, includeDescents) {
		const stack = [];
		let node = this.#root;

		if (Array.isArray(keys)) {
			for (let i = 0, len = keys.length; i < len; i++) {
				const key = keys[i];
				const child = node.c?.get(key);
				if (!child) return false;
				stack.push(node, key);
				node = child;
			}
		} else {
			const child = node.c?.get(keys);
			if (!child) return false;
			stack.push(node, keys);
			node = child;
		}

		if (includeDescents) {
			const descents = this.#countDescents(node);
			if (node.v === EMPTY && !descents) return false;
			this.#size -= descents;
			node.v = EMPTY;
			node.c = null;

			// 自底向上回收空节点；某层非空则祖先一定非空
			for (let i = stack.length - 2; i >= 0; i -= 2) {
				const parent = stack[i];
				const key = stack[i + 1];
				parent.c.delete(key);

				if (parent.c.size || parent.v !== EMPTY) break;
			}
		} else {
			if (node.v === EMPTY) return false;
			this.#size--;
			node.v = EMPTY;
		}

		return true;
	}

	#countDescents(root) {
		let n = 0;
		const stack = [ root ];
		while (stack.length) {
			const node = stack.pop();
			if (node.v !== EMPTY) n++;
			if (node.c !== null) for (const child of node.c.values()) stack.push(child);
		}
		return n;
	}

	/**
	 * 迭代器实现 (DFS)
	 */
	*[Symbol.iterator]() {
		const root = this.#root;
		if (root.c === null) return;

		const path = [];
		const stack = [ root.c.entries() ];

		while (stack.length) {
			const step = stack.at(-1).next();
			if (step.done) {
				stack.pop();
				if (path.length) path.pop();
				continue;
			}
			const [ key, { c, v } ] = step.value;

			path.push(key);

			if (v !== EMPTY) yield [ [...path], v ];
			if (c !== null) stack.push(c.entries());
			else path.pop();
		}
	}

	forEach(callback, thisArg) {
		for (const [ keys, value ] of this) callback.call(thisArg, value, keys, this);
	}

	clear() {
		this.#root = Empty();
		this.#size = 0;
	}
}

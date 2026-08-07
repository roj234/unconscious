import {debugSymbol} from "unconscious";

export const NODE_VALUE = debugSymbol('NodeValue');

/**
 * NestedMap - 支持数组作为复合键的 Map
 */
export class NestedMap {
	#tree = new Map();
	#simple = new Map();
	//#size = 0;

	constructor(entries) {
		if (entries) for (const [keys, value] of entries) {
			this.set(keys, value);
		}
	}

	/**
	 * 设置值
	 * @param {any|any[]} keys
	 * @param {any} value
	 */
	set(keys, value) {
		if (Array.isArray(keys)) {
			if (keys.length > 1) {
				let current = this.#tree;
				for (const key of keys) {
					let next = current.get(key);
					if (!next) {
						current.set(key, next = new Map());
					}
					current = next;
				}

				//if (!current.has(NODE_VALUE)) this.#size++;
				current.set(NODE_VALUE, value);
				return this;
			}

			keys = keys[0];
		}
		this.#simple.set(keys, value);
		return this;
	}

	/**
	 * 获取值
	 * @param {any|any[]} keys
	 */
	get(keys) {
		if (Array.isArray(keys)) {
			if (keys.length > 1) {
				let current = this.#tree;
				for (const key of keys) {
					current = current.get(key);
					if (!current) return;
				}
				return current.get(NODE_VALUE);
			}

			keys = keys[0];
		}

		return this.#simple.get(keys);
	}

	getChildren(keys) {
		let current = this.#tree;
		for (let i = 0; i < keys.length; i++) {
			current = current.get(keys[i]);
			if (!current) return;
		}
		return current;
	}

	/**
	 * 判断是否存在
	 * @param {any|any[]} keys
	 */
	has(keys) {
		if (Array.isArray(keys)) {
			if (keys.length > 1) {
				let current = this.#tree;
				for (const key of keys) {
					current = current.get(key);
					if (!current) return false;
				}
				return current.has(NODE_VALUE);
			}

			keys = keys[0];
		}

		return this.#simple.has(keys);

	}

	/**
	 * 删除键值对
	 * @param {any|any[]} keys
	 * @param {boolean} includeDescents
	 */
	delete(keys, includeDescents) {
		if (Array.isArray(keys)) {
			if (keys.length > 1) {
				const stack = []; // 用于后续清理空节点
				let current = this.#tree;

				for (const key of keys) {
					stack.push([ current, key ]);
					current = current.get(key);
					if (!current) return false;
				}

				let ok = true;
				if (includeDescents) {
					ok = current.size > 0;
					current.clear();
				} else {
					if (!current.delete(NODE_VALUE)) return false;
					//this.#size--;
				}

				// 递归向上删除不再需要的 Map 节点（瘦身）
				for (let i = stack.length - 1; i >= 0; i--) {
					const [ parent, key ] = stack[i];
					const node = parent.get(key);
					if (node.size > 0) break;
					parent.delete(key);
				}

				return ok;
			}

			keys = keys[0];
		}

		return this.#simple.delete(keys);

	}

	/*get size() {
		return this.#size + this.#simple.size;
	}*/

	/**
	 * 迭代器实现 (DFS)
	 */
	*[Symbol.iterator]() {
		yield* this.#simple[Symbol.iterator]();
		yield* this.#traverse(this.#tree, []);
	}

	*#traverse(map, path, includeDir) {
		for (const [key, nextMap] of map.entries()) {
			if (key !== NODE_VALUE) {
				if (includeDir) yield [path];
				path.push(key);
				yield* this.#traverse(nextMap, path, includeDir);
				path.pop();
			} else {
				yield [path, map.get(NODE_VALUE)];
			}
		}
	}

	clear() {
		this.#tree.clear();
		this.#simple.clear();
		//this.#size = 0;
	}
}
import {debugSymbol} from "../shared.js";

import "./VirtualList.css";

/**
 * 项目渲染出元素的索引
 */
export const INDEX = debugSymbol("VL.Index");

/**
 * 该项目的键，在数组中可以重复，如果和上次结果不同就重新渲染项目
 */
const ITEM_VAL = debugSymbol("VL.Item");

/**
 * 该项目的键，在数组中可以重复，如果和上次结果不同就重新渲染项目
 */
export const ITEM_KEY = debugSymbol("VL.Key");
/**
 * 该项目的高度
 */
export const ITEM_HEIGHT = debugSymbol("VL.Height");

/**
 * 钉住
 */
export const PINNED = debugSymbol("VL.Pinned");

/**
 * @type VirtualList<T>
 * @template {Object} T 数据类型
 */
export class VirtualList {
	dom = <div className="_vl" />;

	_start = 0;
	_end = 0;

	_offset = 0;
	_height = 0;

	/**
	 * 返回 scrollTop 所在的第一个可见项目索引。
	 *
	 * 即第一个满足：
	 *   itemTop + itemHeight > scrollTop
	 * 的项目。
	 *
	 * 注意：不能直接使用 _start，因为 _start 可能包含 overscan 区域。
	 */
	_getScrollAnchorIndex(scrollTop) {
		let i;
		let top;

		// 正常情况下 scrollTop 位于当前已渲染区间之后，
		// 从 _start 开始只需遍历很少的项目。
		if (scrollTop >= this._offset) {
			i = this._start;
			top = this._offset;
		} else {
			// 状态刚重置或滚动位置异常时，从头计算。
			i = 0;
			top = 0;
		}

		while (i < this.items.length) {
			const height = this._h(i);

			// 当前项目与视口相交。
			if (top + height > scrollTop) break;

			top += height;
			i++;
		}

		return i;
	}

	/**
	 * @type {ResizeObserverCallback}
	 * @param {{target: HTMLElement}[]} entries
	 * @return {boolean}
	 * @private
	 */
	_onResize = (entries, preservedViewTop) => {
		const wrapper = this._wrapper;
		// ResizeObserver 会把 observer 作为第二参数；只有内部同步测量传入的
		// number 才表示修改 padding 前应保持的逻辑滚动位置。
		const viewTop = typeof preservedViewTop === "number" ? preservedViewTop : (wrapper?.scrollTop ?? 0);

		// 必须在写入真实高度前，用旧高度模型确定当前可视锚点。
		// overscan 中位于锚点前的项目高度变化时，需要同步补偿 scrollTop，
		// 否则这些项目从估算高度切换到真实高度会推动可视内容瞬移。
		// 移动到下方懒加载以优化宽度resize时的性能
		let scrollAnchorIndex;
		let heightChanged = 0;
		let beforeAnchorHeightChanged = 0;
		let hasHeightChanged = false;

		for (let {target, borderBoxSize} of entries) {
			const itemIndex = target[INDEX];
			const item = this.items[itemIndex];
			// might be removed
			if (!item) continue;

			const targetRect = borderBoxSize ? borderBoxSize[0].blockSize : target.getBoundingClientRect().height;
			const gap = this.gap;
			const measuredHeight = targetRect + (typeof gap === "function" ? gap.call(this, target) : gap);
			let expectedHeight = item[ITEM_HEIGHT] ?? this.itemHeight;
			if (null == expectedHeight) {
				if (measuredHeight) this.itemHeight = measuredHeight;
				requestAnimationFrame(() => {
					this._start = this._offset = this._height = 0;
					this.render();
				});
				return;
			}

			if (Math.abs(measuredHeight - expectedHeight) > 0.5) {
				const delta = measuredHeight - expectedHeight;
				item[ITEM_HEIGHT] = measuredHeight;
				heightChanged += delta;
				hasHeightChanged = true;
				if (null == scrollAnchorIndex) scrollAnchorIndex = this._getScrollAnchorIndex(viewTop);
				if (itemIndex < scrollAnchorIndex) beforeAnchorHeightChanged += delta;
			}
		}

		if (hasHeightChanged) {
			this._height += heightChanged;

			// 必须基于测量前保存的逻辑位置设置绝对值，不能在当前 scrollTop 上累加。
			// DOM 更新期间浏览器可能已经把当前 scrollTop 夹取到临时的最大值；
			// 若在夹取值上再加高度差，会把浏览器夹取和高度补偿重复计算。
			const targetScrollTop = viewTop + beforeAnchorHeightChanged;
			if (wrapper && (beforeAnchorHeightChanged || typeof preservedViewTop === "number")) {
				wrapper.scrollTop = targetScrollTop;
			}

			if (!this._dirty) {
				let recalculated = 0;
				for (let j = 0; j < this._start; j++) {
					recalculated += this._h(j);
				}
				this._offset = recalculated;

				this.render();
			}
		}
		// 高度差即使互相抵消，也需要让 render 再跑一轮来更新 padding。
		return hasHeightChanged;
	}

	#ro = new ResizeObserver(this._onResize);
	#io = new IntersectionObserver(entries => {
		if((this._visible = entries.at(-1).isIntersecting) && this._dirty) {
			this.resize();
		}
	});
	#mainRo = new ResizeObserver(() => this.resize());

	/**
	 * @param {VirtualListConfig} config
	 */
	constructor(config) {
		this.itemHeight = config.itemHeight;
		this.renderer = config.renderer;
		this.gap = config.gap || 0;
		this.keyFunc = config.keyFunc || (item => item[ITEM_KEY] ?? item);
		this.isSameKey = config.isSameKey || ((a, b) => a[ITEM_KEY] === b);
		this.overscan = config.overscan || 0;

		this._dirty = !!(this.items = config.data);

		const wrapper = config.element;
		if (wrapper) {
			wrapper.appendChild(this.dom);
			this.attach(wrapper);
		}
	}

	/**
	 * @param {HTMLElement} wrapper
	 * @param {boolean} [skipIO]
	 */
	attach(wrapper, skipIO) {
		this._wrapper = wrapper;
		wrapper.addEventListener('scroll', this.render);
		if (!skipIO) this.#io.observe(wrapper);
		else this._visible = true;
		this.#mainRo.observe(wrapper);
	}

	startMove() {
		const wrapper = this._wrapper;
		this.#mainRo.unobserve(wrapper);
	}

	resize() {
		const style = this._wrapper?.firstElementChild.style;
		if (style) style.height = `1e6px`;
		this.render();
		if (style) style.height = '';
	}

	scrollToBottom() {
		const {items, _h: getItemHeight, dom, _wrapper: wrapper} = this;
		const last = items.length - 1;
		if (last < 0) { this.render(); return; }

		let i = 0;
		let startHeight = 0;

		while(i < last) startHeight += getItemHeight(i++);
		const totalHeight = startHeight + getItemHeight(i);

		this._start = last;
		this._end = last + 1;
		this._offset = startHeight;
		this._height = totalHeight;
		this._dirty = false;

		dom.style = `padding-top:${startHeight}px;padding-bottom:0px`;
		this._updateDOM(dom, last, last + 1, items);

		wrapper.scrollTop = wrapper.scrollHeight;
	}

	scrollTo(offset) {
		this._wrapper.scrollTop = offset;
	}

	/**
	 * 更新数组某项并(立即)更新虚拟列表，如果这项正在渲染
	 * @param {number} i 数组索引
	 * @param {T} item 新的值
	 */
	setItem(i, item) {
		if (item) this.items[i] = item;

		const value = this.getValue(i);
		if (!value) return;
		delete value[ITEM_VAL];

		this._height = 0;
		if (i < this._start) {
			this._start = 0;
			this._offset = 0;
		}

		this.render();
	}

	/**
	 * 更新数组并(立即)更新虚拟列表
	 * @param {T[]} items 新的值
	 */
	setItems(items) {
		this.items = items;
		this._height = 0;
		if (items.length < this._start) {
			this._start = 0;
			this._offset = 0;
		}
		this.resize();
	}

	/**
	 * 获取DOM低N项
	 * @param i
	 * @returns {Element}
	 */
	getValue(i) {return this.dom.children[i - this._start];}

	/**
	 * 查找当前可见的项目
	 * @param {Object} item
	 * @returns {number}
	 */
	findIndex(item) {
		if (!this._visible && this._dirty) return -1;

		for (let i = this._start; i < this._end; i++) {
			if (this.items[i] === item) {
				return i;
			}
		}
		return -1;
	}

	/**
	 * 清理资源
	 */
	destroy() {
		this.#io.disconnect();
		this.#mainRo.disconnect();
		this._wrapper?.removeEventListener('scroll', this.render);
	}

	_h = (j) => this.items[j][ITEM_HEIGHT] ?? this.itemHeight;

	render = () => {
		this._dirty = true;
		let {
			dom: container,
			_h: getItemHeight,
			_visible,
		} = this;
		if (!_visible || !container.isConnected) return;

		let loop = 0;
		for(;;) {
			let {
				items,
				overscan,
				itemHeight,
				_start: i,
				_offset: offset,
				_height: totalHeight,
				_wrapper: {
					scrollTop: viewStart,
					offsetHeight: viewHeight
				}
			} = this;

			// 只处理两次滚动之间的差值 O(n) => O(residual) ≈ O(1)
			if (offset < viewStart) {
				// 往下滚动
				while(i < items.length) {
					const h = getItemHeight(i);
					if ((offset + h) > viewStart) break;
					i++;
					offset += h;
				}
			} else if (offset !== viewStart) {
				// 往上滚动
				while (i > 0) {
					if ((offset -= getItemHeight(--i)) <= viewStart) break;
				}
			}

			if (offset < 0) {
				i = 0;
				offset = 0;
			}

			// 在前部额外渲染
			{
				const targetBeginOffset = Math.max(0, viewStart - overscan);
				while (offset > targetBeginOffset && i > 0) {
					offset -= getItemHeight(--i);
				}
			}

			const startIndex = this._start = i;
			const startHeight = this._offset = offset;

			//离开视口
			const viewEnd = viewStart + viewHeight;
			while(i < items.length) {
				if ((offset += getItemHeight(i++)) > viewEnd) break;
			}

			//总高度
			if (!totalHeight) {
				totalHeight = offset;
				let j = i;
				while(j < items.length) totalHeight += getItemHeight(j++);
				this._height = totalHeight;
			}

			// 在后部额外渲染
			{
				// 将 endExtra 的动态衰减转为对静态边界坐标 targetEndOffset 的检测
				const targetEndOffset = viewEnd + overscan;
				while (offset < targetEndOffset && i < items.length) {
					offset += getItemHeight(i++);
				}
			}

			// 未渲染的元素的高度由padding-top和padding-bottom代替，保证滚动条位置正确
			// 这里如果把设置padding的操作放在渲染元素之后，部分浏览器滚动到最后一个元素时会有问题
			container.style = `padding-top:${startHeight}px;padding-bottom:${(totalHeight - offset)}px`;

			// 在同一帧内尽可能多的更新元素高度以减小闪烁
			if (!this._updateDOM(container, startIndex, i, items, viewStart) || loop++ * itemHeight > viewHeight)
				break;
		}

		this._dirty = false;
	}

	_updateDOM(container, startIndex, endIndex, items, viewStart) {
		const existingItems = new Map;
		const removeNode = node => {
			this.#ro.unobserve(node);
			node.remove();
		};

		const nodes = container.childNodes;
		nodes.forEach(node => existingItems.set(node[ITEM_VAL], node));

		let anchorNode;
		const newElements = [];
		for (let i = startIndex; i < endIndex; i++) {
			const item = items[i];

			let node = existingItems.get(item);
			let key;

			noRender: {
				if (node) {
					existingItems.delete(item);
					if (this.isSameKey(node, key = this.keyFunc(item, i))) {
						if (node[INDEX] !== i) break noRender;
						node[INDEX] = i;
						node[ITEM_KEY] = key;
						anchorNode = node;
						continue;
					} else {
						removeNode(node);
					}
				}

				try {
					node = this.renderer(item, i);
				} catch (e) {
					console.error(e, item);
					continue;
				}
				node[ITEM_VAL] = item;
			}

			// 自身未使用
			node[INDEX] = i;
			node[ITEM_KEY] = key ?? this.keyFunc(item, i);

			if (!anchorNode) container.prepend(node);
			else anchorNode.after(node);

			anchorNode = node;

			newElements.push({target: node});
			this.#ro.observe(node);
		}

		existingItems.forEach(node => {
			const val = node[ITEM_VAL];
			if (!val?.[PINNED] || items[node[INDEX]] !== val) {
				removeNode(node);
			}
		});

		this._start = startIndex;
		this._end = endIndex;

		return viewStart != null && newElements.length && this._onResize(newElements, viewStart);
	}
}
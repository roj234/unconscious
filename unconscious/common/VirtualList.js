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
	 * @private
	 */
	_onResize = (entries, preservedViewTop) => {
		const wrapper = this._wrapper;
		if (!wrapper) return;

		const viewTop = typeof preservedViewTop === "number" ? preservedViewTop : wrapper.scrollTop;

		let scrollAnchorIndex = -1;
		let heightChanged = 0;
		let aboveAnchorHeightChanged = 0;

		for (let {target, borderBoxSize} of entries) {
			const itemIndex = target[INDEX];
			const item = this.items[itemIndex];
			// might be removed
			if (!item) continue;

			const targetRect = borderBoxSize ? borderBoxSize[0].blockSize : target.getBoundingClientRect().height;
			if (targetRect === 0) continue;

			const gap = this.gap;
			const measuredHeight = targetRect + (typeof gap === "function" ? gap.call(this, target) : gap);

			let expectedHeight = item[ITEM_HEIGHT] ?? this.itemHeight;
			if (null == expectedHeight) {
				this.itemHeight = measuredHeight;
				this._start = this._offset = this._height = 0;
			}

			if (Math.abs(measuredHeight - expectedHeight) > 0.5) {
				// 必须在写入新高度之前确定锚点，保证它基于本次批量变化前的布局。
				if (scrollAnchorIndex < 0) scrollAnchorIndex = this._getScrollAnchorIndex(viewTop);

				const delta = measuredHeight - expectedHeight;
				item[ITEM_HEIGHT] = measuredHeight;
				heightChanged += delta;

				if (itemIndex < scrollAnchorIndex) aboveAnchorHeightChanged += delta;
			}
		}

		if (!heightChanged) return;

		if (this._height)
			this._height = Math.max(0, this._height + heightChanged);

		// 把第一个可见项钉回原来的屏幕位置
		const newTop = Math.max(0, viewTop + aboveAnchorHeightChanged);
		if (Math.abs(wrapper.scrollTop - newTop) > 0.5) wrapper.scrollTop = newTop;

		if (!this._dirty) {
			let recalculated = 0;
			for (let j = 0; j < this._start; j++) {
				recalculated += this._h(j);
			}
			this._offset = recalculated;

			this.render();
		}
	}

	#ro = new ResizeObserver(this._onResize);
	#io = new IntersectionObserver(entries => {
		if ((this._visible = entries.at(-1).isIntersecting) && this._dirty !== false) {
			this._height = 0;
			this.render();
		}
	});
	#mainRo = new ResizeObserver((entries) => {
		const rect = entries.at(-1).contentRect;
		if (rect.width * rect.height) this.render();
	});

	/**
	 * @param {VirtualListConfig} config
	 */
	constructor(config) {
		this.itemHeight = config.itemHeight;
		this.renderer = config.renderer;
		this.gap = config.gap || 0;
		this.keyFunc = config.keyFunc || (item => item[ITEM_KEY] ?? item);
		this.reuseHook = config.reuseHook || ((a, b) => a[ITEM_KEY] === b);
		this.overscan = config.overscan || 100;

		this._dirty = !!(this.items = config.data);

		const wrapper = config.element;
		if (wrapper) {
			wrapper.appendChild(this.dom);
			this.attach(wrapper);
		}

		this.dom._vl = this;
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
		this.render();
	}

	scrollToBottom() {
		const {items, _h: getItemHeight, dom} = this;
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
		this._dirty = 0;

		dom.style.paddingTop = `${startHeight}px`;
		dom.style.paddingBottom = '0px';
		this.render();
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
		this._start = 0;
		this._offset = 0;
		this._height = 0;
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

		if (typeof item === "function") {
			for (let i = this._start; i < this._end; i++) {
				if (item(this.items[i])) return i;
			}
		} else {
			for (let i = this._start; i < this._end; i++) {
				if (this.items[i] === item) return i;
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
		this.#ro.disconnect();
		this._wrapper?.removeEventListener('scroll', this.render);
		this._wrapper = null;
	}

	_h = (j) => this.items[j][ITEM_HEIGHT] ?? (this.itemHeight || 16);

	render = () => {
		const scrolling = this._dirty === 0;
		let {
			dom: container,
			_visible,
		} = this;

		if (!_visible || !container.isConnected) {
			this._dirty = scrolling ? 0 : true;
			return;
		}

		let {
			items,
			overscan,
			_h: getItemHeight,
			_start: i,
			_offset: offset,
			_height: totalHeight,
			_wrapper: {
				scrollTop: viewStart,
				offsetHeight: viewHeight
			}
		} = this;

		if (scrolling) {
			viewStart = Math.max(0, totalHeight - viewHeight);
		}

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

		this._updateDOM(container, startIndex, i, items, viewStart);

		if (scrolling) {
			viewStart = this._wrapper.scrollHeight - viewHeight;
			if (viewStart === 0) requestAnimationFrame(() => this.render());
			this._wrapper.scrollTop = viewStart;
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
					if (this.reuseHook(node, key = this.keyFunc(item, i), item, i)) {
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
import {debugSymbol} from "../runtime_shared.js";

import "./VirtualList.css";

/**
 * 项目渲染出元素的索引，因为实际有它所以{@link ITEM_KEY}才可以重复
 */
export const INDEX = debugSymbol("VL.Index");
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
	dom = <div className="_vl"></div>;

	_start = 0;
	_end = 0;

	_offset = 0;
	_height = 0;

	_recycle = [];

	/**
	 * //@type {ResizeObserverCallback}
	 * @param {{target: HTMLElement}[]} entries
	 * @return {boolean}
	 * @private
	 */
	_onResize = entries => {
		let totalDelta = 0;
		let scrollDelta = 0;

		const wrapper = this._wrapper;
		const domOrContainer = wrapper.firstElementChild.style;
		domOrContainer.height = `1e6px`;

		const wrapperRect = wrapper.getBoundingClientRect();
		for (let {target} of entries) {
			const itemIndex = target[INDEX];
			const item = this.items[itemIndex];
			// might be removed
			if (!item) continue;

			const targetRect = target.getBoundingClientRect();
			const gap = this.gap;
			const measuredHeight = targetRect.height + (typeof gap === "function" ? gap.call(this, target) : gap);
			const expectedHeight = item[ITEM_HEIGHT] ?? this.itemHeight;

			if (measuredHeight !== expectedHeight) {
				const delta = measuredHeight - expectedHeight;
				item[ITEM_HEIGHT] = measuredHeight;
				totalDelta += delta;

				// 当元素完全位于当前视口上方?? 这个没法处理跨边缘问题，比如元素一半在视口内，上下分别有两张图片
				if (targetRect.top + expectedHeight < wrapperRect.top) {
					scrollDelta += delta;
				}
			}
		}

		if (totalDelta) {
			this._height += totalDelta;
			wrapper.scrollTop += scrollDelta;
			if (!this._dirty) {
				this._dirty = true;
				requestAnimationFrame(this.render);
			}
		}

		domOrContainer.height = ``;
		return totalDelta;
	}

	_ro = new ResizeObserver(this._onResize);
	_io = new IntersectionObserver(entries => {
		if((this._visible = entries.at(-1).isIntersecting) && this._dirty) {
			this.resize();
		}
	});

	/**
	 * @param {VirtualListConfig} config
	 */
	constructor(config) {
		this.itemHeight = config.itemHeight;
		this.renderer = config.renderer;
		this.render = this.render.bind(this);
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
	 */
	attach(wrapper) {
		this._wrapper = wrapper;
		wrapper.addEventListener('scroll', this.render);
		this._io.observe(wrapper);
	}

	resize() {
		const style = this._wrapper?.firstElementChild.style;
		if (style) style.height = `1e6px`;
		this.render();
		if (style) style.height = '';
	}

	scrollToBottom() {
		const items = this.items;
		const last = items.length - 1;
		if (last < 0) {
			this.render();
			return;
		}

		let i = 0;
		let startHeight = 0;

		while(i < last) startHeight += items[i++][ITEM_HEIGHT] ?? this.itemHeight;

		this.dom.style = `padding-top:${startHeight}px`;
		this._updateDOM(this.dom, this._start = last, this._end = last + 1, items);
		this._offset = startHeight;
		this._height = startHeight + (items.at(-1)[ITEM_HEIGHT] ?? this.itemHeight);

		const wrapper = this._wrapper;
		wrapper.scrollTop = wrapper.scrollHeight;

		requestAnimationFrame(() => {
			wrapper.scrollTop = wrapper.scrollHeight;
		});
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

		value[INDEX] = -1;
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
		for (let i = this._start; i < this._end; i++) {
			if (this.items[i] === item) {
				return i;
			}
		}
		return -1;
	}

	/**
	 * 回收利用现有元素，有必要吗？
	 * @param {string} match pattern
	 * @returns {HTMLElement|null}
	 * @deprecated 都用框架了还关心这个？
	 */
	findElement(match) {
		const r = this._recycle;
		for (let i = r.length-1; i >= 0; i--) {
			if (r[i].matches(match)) return r.splice(i, 1)[0];
		}
		return null;
	}

	/**
	 * 清理资源
	 */
	destroy() {
		this._io.disconnect();
		this._wrapper.removeEventListener('scroll', this.render);
	}

	render() {
		this._dirty = true;
		if (!this._visible) return;

		const items = this.items;
		const container = this.dom;
		const overscan = this.overscan;
		const getItemHeight = (j) => items[j][ITEM_HEIGHT] ?? this.itemHeight;

		for(;;) {
			let i = this._start;
			let offset = this._offset;

			const {scrollTop: viewStart, offsetHeight: viewHeight} = this._wrapper;

			// 这是一个脆弱（指你不能去改 _start）但有意义的优化，只处理两次滚动之间的差值offset，通常这个差值会很小，O(n) -> O(1)
			if (offset < viewStart) {
				// 处理往下滚动
				while(i < items.length) {
					const h = getItemHeight(i);
					if ((offset + h) >= viewStart) break;
					i++;
					offset += h;
				}
			} else if (offset !== viewStart) {
				// 往上滚动
				while (i > 0) {
					if ((offset -= getItemHeight(--i)) < viewStart) break;
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
			let totalHeight = this._height;
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
			container.style = `padding-top:${startHeight}px;padding-bottom:${totalHeight-offset}px`;
			if (!this._updateDOM(container, startIndex, i, items))
				break
		}
		this._dirty = false;
	}

	_updateDOM(container, startIndex, endIndex, items) {
		const recycle = this._recycle;

		const reuse = {};
		// 遍历现有元素，回收不可见或key变化的元素
		for (const element of Array.from(container.children)) {
			const i = element[INDEX];
			const item = items[i];

			let mustRemove;
			if (i < startIndex || i >= endIndex || (mustRemove = !this.isSameKey(element, this.keyFunc(item, i)))) {
				// 不回收Pinned的元素
				if (!mustRemove && item?.[PINNED]) {
					const height = item[ITEM_HEIGHT] ?? this.itemHeight;
					const property = i < startIndex ? 'paddingTop' : 'paddingBottom';
					container.style[property] = parseFloat(container.style[property]) - height;
					continue;
				}

				recycle.push(element);
				this._ro.unobserve(element);
				element.remove();
			} else {
				reuse[i] = element;
			}
		}

		// 插入新元素
		const newElements = [];
		let anchorNode = null;
		for (let i = startIndex; i < endIndex; i++) {
			if (reuse[i]) {
				anchorNode = reuse[i];
				continue; // 未变化则跳过
			}

			// 创建或复用元素
			let element;
			try {
				element = this.renderer(items[i], i, recycle);
			} catch (e) {
				console.error(e, items[i]);
				continue;
			}
			element[INDEX] = i;
			element[ITEM_KEY] = this.keyFunc(items[i], i);
			this._ro.observe(element);

			if (!anchorNode) {
				// 情况1：向上滚动
				container.prepend(element);
			} else {
				// 情况2：向下滚动
				anchorNode.after(element);
			}
			anchorNode = element; // 更新锚点为新元素
			newElements.push({target: element});
		}

		recycle.length = 0;
		this._start = startIndex;
		this._end = endIndex;
		return newElements.length && this._onResize(newElements);
	}
}

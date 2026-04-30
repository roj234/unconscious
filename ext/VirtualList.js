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
	dom = <div className="_vl" />;

	_start = 0;
	_end = 0;

	_offset = 0;
	_height = 0;

	//_scrollTop = 0;

	/**
	 * @type {ResizeObserverCallback}
	 * @param {{target: HTMLElement}[]} entries
	 * @return {boolean}
	 * @private
	 */
	_onResize = (entries) => {
		let heightChanged = false;

		for (let {target, borderBoxSize} of entries) {
			const itemIndex = target[INDEX];
			const item = this.items[itemIndex];
			// might be removed
			if (!item) continue;

			const targetRect = borderBoxSize ? borderBoxSize[0].blockSize : target.getBoundingClientRect().height;
			const gap = this.gap;
			const measuredHeight = targetRect + (typeof gap === "function" ? gap.call(this, target) : gap);
			const expectedHeight = item[ITEM_HEIGHT] ?? this.itemHeight;

			if (measuredHeight !== expectedHeight) {
				const delta = measuredHeight - expectedHeight;
				item[ITEM_HEIGHT] = measuredHeight;
				heightChanged += delta;
			}
		}

		// 如果抵消了，也可能需要重渲染
		if (heightChanged !== false) {
			this._height += heightChanged;
			const anchor = this._anchor;
			if (!this._dirty) this.render();
			if (anchor) this._moveTo(anchor);
		}
		return heightChanged;
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

		/*const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
		const set = descriptor.set;
		const mySet = function () {
			delete this._anchor;
			set.apply(this, arguments);
		};
		descriptor.set = mySet;
		Object.defineProperty(wrapper, 'scrollTop', descriptor);*/

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
		delete this._anchor;

		const {items, _h: getItemHeight, dom, _wrapper: wrapper} = this;
		const last = items.length - 1;
		if (last < 0) { this.render(); return; }

		let i = 0;
		let startHeight = 0;

		while(i < last) startHeight += getItemHeight(i++);

		dom.style = `padding-top:${startHeight}px`;
		this._updateDOM(dom, this._start = last, this._end = last + 1, items, 1);
		this._offset = startHeight;
		this._height = startHeight + getItemHeight(i);

		wrapper.scrollTop = wrapper.scrollHeight;
	}

	scrollTo(offset) {
		delete this._anchor;
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
		value[INDEX] = -1;

		const anchor = this._findAnchor();

		this._height = 0;
		if (i < this._start) {
			this._start = 0;
			this._offset = 0;
		}

		this.render();

		this._moveTo(anchor);
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
	 * 清理资源
	 */
	destroy() {
		this._io.disconnect();
		this._wrapper?.removeEventListener('scroll', this.render);
	}

	_h = (j) => this.items[j][ITEM_HEIGHT] ?? this.itemHeight;

	_findAnchor() {
		const {_h: getItemHeight, _offset: offset, _start: start, _wrapper: {scrollTop}, items} = this;

		// 如果能看到顶部，就根据顶部定位，否则根据底部定位
		const baseOffset = scrollTop - offset;
		// items[start] 检查空列表
		if (items[start] && baseOffset > 0) return [start + 1, baseOffset - getItemHeight(start)];
		return [start, baseOffset];
	}

	_moveTo([targetIndex, targetOffset]) {
		let {_h: getItemHeight, _offset: prefix, _start: i, items} = this;

		// O(n) => O(residual) ≈ O(1)
		while (i < targetIndex && i < items.length) prefix += getItemHeight(i++);
		while (i > targetIndex && i > 0) prefix -= getItemHeight(--i);

		// 如果开始在 targetIndex 元素上，那么滚动之后不能跑到 targetIndex 元素外
		if (targetIndex < items.length) targetOffset = Math.min(targetOffset, getItemHeight(targetIndex));
		if (targetIndex > 0) targetOffset = Math.max(targetOffset, -getItemHeight(targetIndex-1));

		this._wrapper.scrollTop = prefix + targetOffset;
	}

	render = () => {
		this._dirty = true;
		if (!this._visible) return;

		for(;;) {
			let {
				items,
				dom: container,
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
			//this._scrollTop = viewStart;

			// 只处理两次滚动之间的差值 O(n) => O(residual) ≈ O(1)
			if (offset < viewStart) {
				// 往下滚动
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

			// 可能是直接设置 scrollTop 导致 anchor 丢失
			const anchorElement = this._anchor?.[0];
			if (anchorElement < startIndex || anchorElement > i) this._anchor = null;

			// 未渲染的元素的高度由padding-top和padding-bottom代替，保证滚动条位置正确
			// 这里如果把设置padding的操作放在渲染元素之后，部分浏览器滚动到最后一个元素时会有问题
			container.style = `padding-top:${startHeight}px;padding-bottom:${totalHeight-offset}px`;

			// 在同一帧内尽可能多的更新元素高度以减小闪烁
			if (!this._updateDOM(container, startIndex, i, items, viewHeight))
				break;
		}

		this._anchor = this._findAnchor();
		this._dirty = false;
	}

	_updateDOM(container, startIndex, endIndex, items, heightLimit) {
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

				this._ro.unobserve(element);
				element.remove();
			} else {
				reuse[i] = element;
			}
		}

		// 插入新元素
		const newElements = [];
		let anchorNode = null;
		let i = startIndex;
		for (; i < endIndex/* && heightLimit > 0*/; i++/*, heightLimit -= anchorNode.offsetHeight*/) {
			if (reuse[i]) {
				anchorNode = reuse[i];
				continue; // 未变化则跳过
			}

			// 创建或复用元素
			let element;
			const item = items[i];
			try {
				element = this.renderer(item, i);
			} catch (e) {
				console.error(e, item);
				continue;
			}
			element[INDEX] = i;
			element[ITEM_KEY] = this.keyFunc(item, i);
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

		this._start = startIndex;
		this._end = i;
		return newElements.length && this._onResize(newElements);
	}
}

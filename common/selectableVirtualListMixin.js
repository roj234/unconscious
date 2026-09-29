import {INDEX, VirtualList} from "./VirtualList.js";
import {deepEqual} from "./deepEqual.js";
import {ONCE_EVENT} from "unconscious";

/**
 * @typedef {Object} CopySource
 * @property {HTMLElement} dom
 * @property {boolean} hasLineNumberNode
 * @property {() => number} length
 * @property {(number) => string} getRawText
 * @property {() => [?[number, number], ?[number, number]]} getSimulatedRange
 */

/**
 * @type {Set<CopySource>}
 */
const instances = new Set();

/**
 * @param {CopySource} a
 * @param {CopySource} b
 * @return {number}
 * @private
 */
const compareDocumentOrder = (a, b) => a === b ? 0 : (a.dom.compareDocumentPosition(b.dom) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);

/**
 * 按（行, 列）字典序比较两个列表坐标，负数表示 a 更靠前
 * @param {[number, number]} a
 * @param {[number, number]} b
 * @return {number}
 * @private
 */
const compareCols = (a, b) => (a[0] - b[0]) || (a[1] - b[1]);

/**
 * @param {Node} fromNode
 * @param {number} fromOffset
 * @param {Node} toNode
 * @param {number} toOffset
 * @return {string}
 * @private
 */
const textSlice = (fromNode, fromOffset, toNode, toOffset) => {
	const part = new Range();
	part.setStart(fromNode, fromOffset);
	part.setEnd(toNode, toOffset);
	return part.toString();
};

/**
 * 元素内的位置换算成列表坐标（行, 列），不在已渲染的行里返回 null
 * @param {Node} targetNode
 * @param {number} targetOffset
 * @param {boolean} hasLineNumberNode
 * @return {?[number, number]}
 * @private
 */
const getLineCols = (targetNode, targetOffset, hasLineNumberNode) => {
	const lineEl = (targetNode.nodeType === Node.ELEMENT_NODE ? targetNode : targetNode.parentElement)?.closest('.line');
	if (!lineEl) return null;

	let offset = 0;
	const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
	if (hasLineNumberNode) walker.nextNode(); // 跳过行号

	let point = null;
	if (targetNode.nodeType !== Node.TEXT_NODE) {
		point = document.createRange();
		point.setStart(targetNode, Math.min(targetOffset, targetNode.childNodes.length));
		point.collapse(true);
	}

	while (walker.nextNode()) {
		const node = walker.currentNode;
		if (point) {
			if (point.comparePoint(node, 0) >= 0) break;
		} else if (node === targetNode) {
			offset += Math.min(targetOffset, node.length);
			break;
		}
		offset += node.length;
	}

	return [parseInt(lineEl[INDEX]), offset];
};

/**
 * 整行绝对偏移转换为文本元素相对偏移
 * @param {Element} line
 * @param {number} column
 * @param {boolean} hasLineNumberNode
 * @return {null|[Node, number]}
 * @private
 */
const columnToOffset = (line, column, hasLineNumberNode) => {
	let offset = 0;
	const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
	if (hasLineNumberNode) walker.nextNode(); // 跳过行号
	let lastNode = null;
	while (walker.nextNode()) {
		lastNode = walker.currentNode;
		const len = lastNode.length;
		if (offset + len >= column) return [lastNode, column - offset];
		offset += len;
	}
	return lastNode && [lastNode, lastNode.length];
};

/**
 * 列表内 [from, to] 两行之间的原始文本
 * @param {function(number): string} getRawText
 * @param {[number, number]} from
 * @param {[number, number]} to
 * @return {string}
 * @private
 */
const getSelectedText = (getRawText, [startLine, startOffset], [endLine, endOffset]) => {
	let lines = '';
	for (let i = startLine; i <= endLine; i++) {
		const raw = getRawText(i);
		const startIdx = (i === startLine) ? startOffset : 0;
		const endIdx = (i === endLine) ? endOffset : raw.length;
		lines += raw.slice(startIdx, endIdx);
		if (i !== endLine) lines += '\n';
	}
	return lines;
};

/**
 * 整个文档选区对应的文本：落在列表里的那几段换成原始文本，其余原样保留。
 * @param {Selection} selection
 * @return {?string} null 表示这次复制和列表无关，不该接管
 * @private
 */
const collectTexts = (selection) => {
	if (selection.isCollapsed) return null;

	const range = selection.getRangeAt(0);

	const covered = [...instances]
		.filter(source => range.intersectsNode(source.dom))
		// 不考虑嵌套
		//.filter(source => !instances.some(other => other !== source && range.intersectsNode(other.dom) && other.dom.contains(source.dom)))
		.sort(compareDocumentOrder);
	if (!covered.length) return null;

	const parts = [];
	let fromNode = range.startContainer;
	let fromOffset = range.startOffset;

	for (const source of covered) {
		const dom = source.dom;
		const totalLines = source.length();

		const list = document.createRange();
		list.selectNodeContents(dom);

		parts.push(textSlice(fromNode, fromOffset, list.startContainer, list.startOffset));

		const hasFrom = dom.contains(range.startContainer);
		const hasTo = dom.contains(range.endContainer);

		const [emuStart, emuEnd] = source.getSimulatedRange();

		let from, to;
		if (hasFrom) {
			from = getLineCols(range.startContainer, range.startOffset, source.hasLineNumberNode);
			if (emuStart && (!from || compareCols(emuStart, from) < 0)) from = emuStart;
		}
		if (hasTo) {
			to = getLineCols(range.endContainer, range.endOffset, source.hasLineNumberNode);
			if (emuEnd && (!to || compareCols(emuEnd, to) > 0)) to = emuEnd;
		}

		parts.push(getSelectedText(source.getRawText, from ?? [0, 0], to ?? [totalLines - 1, Infinity]));

		fromNode = list.endContainer;
		fromOffset = list.endOffset;
	}
	parts.push(textSlice(fromNode, fromOffset, range.endContainer, range.endOffset));

	let text = '';
	for (const part of parts) {
		if (!part) continue;
		if (text && !text.endsWith('\n') && !part.startsWith('\n')) text += '\n';
		text += part;
	}
	return text;
};

/**
 * 复制事件处理器：所有列表共用这一个。
 * @param {ClipboardEvent} e
 * @private
 */
const onCopy = (e) => {
	const selection = getSelection();
	if (!selection || !selection.rangeCount || !e.clipboardData) return;

	const text = collectTexts(selection);
	if (text == null) return; // 这次复制和列表无关，交给浏览器

	e.preventDefault();
	e.clipboardData.setData('text/plain', text);
};

/**
 * 支持选区复制的虚拟列表，你绝对没见过吧！
 * - 不支持移动端，但移动端根本没法在选中的同时滚动虚拟列表又完美解决了这个问题（bushi
 * @param {VirtualList} virtualList
 * @param {(number) => string} getRawText
 * @param {boolean=} hasLineNumberNode
 */
export function selectableVirtualListMixin(virtualList, getRawText, hasLineNumberNode) {
	/** @type {?[number, number]} 模拟选区的起点（行, 列） */
	let start = null;
	/** @type {?[number, number]} 模拟选区的终点（行, 列） */
	let end = null;
	/** @type {boolean} 是否正在拖拽选择 */
	let isSelecting = false;

	/**
	 * 模拟选区（按文档顺序排好），没有返回 null
	 * @return {?[[number, number], [number, number]]}
	 */
	const getSimulatedRange = () => {
		if (!start || !end) return null;

		const [startLine, startOffset] = start;
		const [endLine, endOffset] = end;

		const isReverse = (startLine > endLine) || (startLine === endLine && startOffset > endOffset);
		return isReverse ? [end, start] : [start, end];
	};

	const onMouseDown_GlobalOnce = (e) => {
		if (e.button !== 0) return; // 只处理左键
		start = end = null;
	};

	const onMouseDown = (e) => {
		if (e.button !== 0) return;
		onMouseDown_GlobalOnce(e);
		wrapper.addEventListener("mousemove", onMouseMove);
		addEventListener('mouseup', onMouseUp, ONCE_EVENT);
	};

	const onMouseMove = () => {
		// 滚动过程中 anchorNode 离开视口会被移除
		const {anchorNode, anchorOffset} = getSelection();
		if (!anchorNode) return;

		start = getLineCols(anchorNode, anchorOffset, hasLineNumberNode);
		// 锚点不在行里（例如从列表外面拖进来），继续等下一次 mousemove
		if (!start) return;

		wrapper.removeEventListener("mousemove", onMouseMove);
		addEventListener('mousedown', onMouseDown_GlobalOnce, ONCE_EVENT);
		isSelecting = true;
	};

	const setEnd = () => {
		if (!start) return;
		const {focusNode, focusOffset} = getSelection();
		if (!focusNode) return;

		end = getLineCols(focusNode, focusOffset, hasLineNumberNode);
		if (!end || deepEqual(start, end)) end = null;
	};

	const onMouseUp = () => {
		isSelecting = false;
		wrapper.removeEventListener("mousemove", onMouseMove);
		if (start) setEnd();
	};

	const restoreSelection = () => {
		if (isSelecting) return;
		const range = getSimulatedRange();
		if (!range) return;

		const [[startLine, startOffset], [endLine, endOffset]] = range;
		const startDom = virtualList.getValue(startLine);
		const endDom = virtualList.getValue(endLine);

		let startRange = startDom ? columnToOffset(startDom, startOffset, hasLineNumberNode) : null;
		let endRange = endDom ? columnToOffset(endDom, endOffset, hasLineNumberNode) : null;

		// 处理选区超出可视范围的情况
		if (!startRange) {
			const first = virtualList.dom.firstElementChild;
			if (first[INDEX] > endLine) return;
			startRange = [first, 0];
		}
		if (!endRange) {
			const last = virtualList.dom.lastElementChild;
			if (last[INDEX] < startLine) return;
			endRange = columnToOffset(last, 1e9, hasLineNumberNode);
		}

		if (startRange && endRange) {
			getSelection().setBaseAndExtent(startRange[0], startRange[1], endRange[0], endRange[1]);
		}
	};

	/** @type {CopySource} */
	const info = {
		dom: virtualList.dom,
		hasLineNumberNode,
		length: () => virtualList.items?.length ?? 0,
		getRawText,
		getSimulatedRange: () => end ? getSimulatedRange() : [start]
	};

	if (!instances.size) addEventListener('copy', onCopy);
	instances.add(info);

	// 事件绑定与销毁
	const wrapper = virtualList._wrapper;
	wrapper.addEventListener('mousedown', onMouseDown);
	wrapper.addEventListener('scroll', () => requestAnimationFrame(restoreSelection));

	const oldDestroy = virtualList.destroy;
	virtualList.destroy = () => {
		oldDestroy.call(virtualList);
		if (instances.delete(info) && !instances.size) removeEventListener('copy', onCopy);
	};
}
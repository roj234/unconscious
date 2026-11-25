import {VirtualList} from "./VirtualList.js";
import {$cleanup, $watch, dependCapture, unconscious} from "../runtime.js";

class VirtualListElement extends HTMLElement {
	/**
	 * @param {VirtualList} list
	 */
	constructor(list) {
		super();
		this.classList.add("_vl");
		this.list = list;
	}
	connectedCallback() {this.list.attach(this.parentElement);}
	disconnectedCallback() {this.list.destroy();}
}
customElements.define('virtual-list', VirtualListElement);

/**
 * 创建按需更新的虚拟列表，复用现有DOM元素
 * @template T item type
 * @template {T|any} K key type
 * @template {Renderable} E element type
 * @param {Reactive<T[]>} list - 响应式列表
 * @param {(item: T, index: number) => E} renderer - 生成列表项元素的函数
 * @param {(item: T, index: number) => K} [keyFunc=item => item] - 生成唯一标识的函数
 * @param {Object} [options]
 * @returns {HTMLElement} 包含动态列表的自定义元素
 */
export function $vforeach(list, renderer, keyFunc, options) {
	const vl = new VirtualList({
		renderer,
		keyFunc,
		...options
	});
	const canRemove = dependCapture && !dependCapture.has(list);
	const dom = new VirtualListElement(vl);
	const cb = () => { vl.setItems(unconscious(list) ?? []); };
	$watch(list, cb);
	if (canRemove) dependCapture.delete(list);
	$cleanup(dom, [list, cb]);
	return vl.dom = dom;
}


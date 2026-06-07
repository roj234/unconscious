export const PASSIVE_EVENT = {passive: true};
export const ONCE_EVENT = {once: true};

export const UTF8_TEXT_ENCODER = /* #__PURE__ */ new TextEncoder();
export const UTF8_TEXT_DECODER = /* #__PURE__ */ new TextDecoder('utf-8', { ignoreBOM: true });

export const isPureObject = object => Object.prototype.toString.call(object) === "[object Object]";

/**
 * 开发时获取带名称的符号
 * @param name 符号名称
 * @returns {symbol}
 */
export const debugSymbol = name => import.meta.env.DEV ? Symbol(name) : Symbol();

/**
 * 存储简单类型时可使用AS_IS序列化器
 * @template T
 * @type {function(T): T}
 */
export const AS_IS = t => t;

/**
 * 通用按钮事件处理器包装器
 * @param {Function} handler - 原始事件处理函数
 * @param {number} button - 要监听的按钮编号（0:左键, 1:中键, 2:右键）
 * @returns {Function} 包装后的事件处理函数
 */
export const _button = (handler, button) => e => {
	if (e.button !== button) return;
	handler(e);
};
/**
 * 创建仅响应鼠标左键的事件处理器
 * @param {Function} handler - 原始事件处理函数
 * @returns {Function} 包装后的事件处理函数
 */
export const _left = handler => _button(handler, 0);
/**
 * 创建仅响应鼠标中键的事件处理器
 * @param {Function} handler - 原始事件处理函数
 * @returns {Function} 包装后的事件处理函数
 */
export const _middle = handler => _button(handler, 1);
/**
 * 创建仅响应鼠标右键的事件处理器
 * @param {Function} handler - 原始事件处理函数
 * @returns {Function} 包装后的事件处理函数
 */
export const _right = handler => _button(handler, 2);
/**
 * 阻止事件默认行为的事件处理器包装器
 * @param {Function} handler - 原始事件处理函数
 * @returns {Function} 包装后的事件处理函数
 */
export const _prevent = handler => e => {
	e.preventDefault();
	handler(e);
};
/**
 * 阻止事件冒泡的事件处理器包装器
 * @param {Function} handler - 原始事件处理函数
 * @returns {Function} 包装后的事件处理函数
 */
export const _stop = handler => e => {
	e.stopPropagation();
	handler(e);
};

/**
 * 直接子元素事件代理（仅匹配第一级子元素）
 * @param {Function} handler - 原始事件处理函数
 * @param {string} selector - CSS 元素选择器
 * @returns {Function} 包装后的事件处理函数
 * @example
 * // 匹配直接子元素 <li>
 * \@onclick.children("li")
 *
 * @property {Element} event.delegateTarget - 匹配到的直接子元素
 */
export const _children = (handler, selector) => e => {
	const top = e.currentTarget;
	let target = e.target;
	if (top === target) return;

	while (target.parentElement !== top) {
		target = target.parentElement;
	}

	if (selector && target.matches(selector)) {
		e.delegateTarget = target;
		handler(e);
	}
};

/**
 * 通用元素委托事件处理器（支持任意层级匹配）
 * @param {Function} handler - 原始事件处理函数
 * @param {string} selector - 标准 CSS 选择器（不支持 :scope 伪类）
 * @returns {Function} 包装后的事件处理函数
 * @example
 * // 匹配容器内任意层级的 .btn 元素
 * \@onclick.delegate(".btn")
 *
 * @property {Element} event.delegateTarget - 首个匹配选择器的祖先元素
 */
export const _delegate = (handler, selector) => e => {
	const top = e.currentTarget;
	let target = e.target;
	while (target) {
		if (target === top) return;
		if (target.matches(selector)) break;
		target = target.parentElement;
	}

	e.delegateTarget = target;
	handler(e);
};

/**
 * 复制静态元素
 * @param {string} str
 * @return {(function(): HTMLElement)}
 */
export const kloneNode = str => {
	let cached;

	return () => {
		if (!cached) {
			const frag = document.createElement("template");
			frag.innerHTML = str;
			cached = frag.content.firstElementChild;
			str = null;
		}

		return cached.cloneNode(true);
	};
};

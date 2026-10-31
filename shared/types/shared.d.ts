// @roj234/shared

export const PASSIVE_EVENT: {passive: true};
export const ONCE_EVENT: {once: true};

export const UTF8_TEXT_ENCODER: TextEncoder;
export const UTF8_TEXT_DECODER: TextDecoder;

/**
 * 编译器消除ref警告的黑科技
 */
export function ref(): Element;

/**
 * 开发时获取带名称的符号
 * @param name 符号名称
 */
export function debugSymbol(name: string): symbol;

/**
 * 存储简单类型时可使用AS_IS序列化器
 * @template T
 * @type {function(T): T}
 */
export const AS_IS: Function;

/**
 * 基于模板克隆静态的元素
 * @param node
 */
export function kloneNode(node: string): () => JSX.Element;

export function isPureObject(object: any): boolean;

// ——— 事件处理器装饰器（运行时在 shared.js，编译器把 onClick.stop 之类翻译成这些调用） ———

/** 事件处理器包装器通用签名 */
export type EventDecorator = <E extends Event>(handler: (event: E) => void) => (event: E) => void;

/** 只在鼠标左键触发 */
export const _left: EventDecorator;
/** 只在鼠标中键触发 */
export const _middle: EventDecorator;
/** 只在鼠标右键触发 */
export const _right: EventDecorator;
/** 阻止默认行为 */
export const _prevent: EventDecorator;
/** 阻止冒泡 */
export const _stop: EventDecorator;

/** 直接子元素事件代理（仅匹配第一级子元素） */
export function _children<E extends Event>(
    handler: (event: E & { delegateTarget: Element }) => void,
    selector: string
): (event: E) => void;

/** 任意层级的事件代理，事件上会带 delegateTarget */
export function _delegate<E extends Event>(
    handler: (event: E & { delegateTarget: Element }) => void,
    selector: string
): (event: E) => void;
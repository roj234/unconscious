
// 该项目的键，在数组中可以重复，如果和上次结果不同就重新渲染项目
export const ITEM_KEY: unique symbol;
// 该项目的高度
export const ITEM_HEIGHT: unique symbol;
// 禁止从HTML中删除
export const PINNED: unique symbol;

/**
 * 虚拟列表配置选项
 */
export interface VirtualListConfig<T, K> {
    // 父元素 可以稍后通过attach()指定
    element?: HTMLElement;
    // 数据源 可以稍后通过setItems()指定
    data?: T[];
    // 每项高度的估计值
    itemHeight: number;
    // 每项之间的gap/margin
    gap?: number | ((el: HTMLElement) => number);
    /**
     * 视口上下预渲染（缓冲）区域的高度。
     *
     * - 作用（理论上）：在可视区域之外提前渲染一部分 DOM，防止在快速滑动时因来不及挂载节点而出现白屏/闪烁。
     * - 实际上：scroll事件每帧都触发，我的实现使用padding定位未观测到白屏，另一个绝对定位的参考实现会出现白屏
     * - 真实作用：有的用户（比如我们的测试）可能很无聊在列表项边界处来回滚动，加上这个值把元素的创建和用户能看到的视觉边界分隔，减少一点mount后的重复async onResize
     * - 如果列表项高度不会变化，可以设置为0，否则设置一个一两百左右的质数（没有理由，只是感觉）
     */
    overscan?: number;
    // 渲染函数
    renderer: (data: T, index: number, recycle: HTMLElement[]) => HTMLElement;
    // 生成唯一索引的函数
    keyFunc?: (item: T) => K;
    isSameKey?: (key1: HTMLElement, key2: K) => boolean;
}

/**
 * 虚拟列表类
 * @template T 数据类型（默认 Object）
 */
export class VirtualList<T = object> {
    /**
     * 内部垫高容器
     */
    readonly dom: HTMLDivElement;
    /**
     * 每项的预期高度 (实际高度可以不同)
     */
    itemHeight: number;
    /**
     * 视口上下预渲染缓冲区
     */
    overscan: number;
    /**
     * 数据源
     */
    items: T[];
    /**
     * 渲染函数
     */
    readonly renderer: (data: T, index: number, recycle: HTMLElement[]) => HTMLElement;

    /**
     * 构造函数
     * @param config 配置选项
     */
    constructor(config: VirtualListConfig<T>);

    /**
     * 列表高度修改后重新计算需要渲染的项目
     */
    resize(): void;

    scrollToBottom(): void;

    /**
     * 更新数组某项并(立即)更新虚拟列表，如果这项正在渲染
     * @param i 数组索引
     * @param item 新的值（如果为 null/undefined，则使用当前 items[i]）
     * @param heightUnchanged 高度是否未变
     */
    setItem(i: number, item: T | null | undefined, heightUnchanged?: boolean): void;

    /**
     * 更新数组并(立即)更新虚拟列表
     */
    setItems(items: T[]): void;

    /**
     * 获取 items[i] 的元素，若当前正在渲染
     * @param i 数组索引
     */
    getValue(i: number): HTMLElement | undefined;

    /**
     * 查找当前可见的项目索引
     * @param item 要查找的项目
     * @returns 索引（如果未找到，返回 -1）
     */
    findIndex(item: T): number;

    /**
     * lazy附加到容器
     */
    attach(wrapper: HTMLElement): void;

    /**
     * 清理资源（断开观察器和事件监听）
     */
    destroy(): void;
}

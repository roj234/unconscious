import type { VirtualList } from './VirtualList.js';

/**
 * 为虚拟列表增加文本选择与复制功能。
 *
 * @param virtualList - 已初始化的 VirtualList 实例
 * @param getRawText - 根据行号返回该行原始文本的回调
 * @param hasLineNumberNode - 如果行元素包含行号节点，传 `true` 以在计算偏移时跳过行号
 */
export function selectableVirtualListMixin(
    virtualList: VirtualList,
    getRawText: (lineNumber: number) => string,
    hasLineNumberNode?: boolean
): void;
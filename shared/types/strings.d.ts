
/**
 * 根据字符串和其中的索引计算所在行 / 列，并返回带定位箭头的多行字符串。
 */
export function locate(string: string, index: number): string;

export function escapeHtml(string: string): string;
export function escapeHtmlText(string: string): string;
export function escapeHtmlAttr(string: string): string;

/**
 * 规范化所有的换行符为 LF
 * @param str
 */
export function normalizeLineTerminator(str: string): string;
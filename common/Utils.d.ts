
export function G(selector: string, element?: HTMLElement): HTMLElement | null;
export function A(selector: string, element?: HTMLElement): HTMLElement[];

export function formatDate(format: string, stamp?: number | Date | null): string;
export function prettyTime(timestamp: number): string;

// formatSize 函数（size 可为字符串或数字，返回格式化后的字符串）
export function formatSize(size: number | string): string;
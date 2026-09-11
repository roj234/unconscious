
export function G(selector: string, element?: HTMLElement): HTMLElement | null;
export function A(selector: string, element?: HTMLElement): HTMLElement[];

export function formatDate(format: string, stamp?: number | Date | null): string;
export function prettyTime(timestamp: number): string;

// formatSize 函数（size 可为字符串或数字，返回格式化后的字符串）
export function formatSize(size: number | string): string;

export function immutableObjectMap<T extends Record<any, any>>(input: T): Readonly<T>;

export function hook(obj: Object, prop: string | Symbol, callback: (ret: any, ...args: any[]) => any): Function;

/**
 * 根据字符串和其中的索引计算所在行 / 列，并返回带定位箭头的多行字符串。
 */
export function locate(string: string, index: number): string;
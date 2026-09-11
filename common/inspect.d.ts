
export function inspect(value: any, replacer?: function(string, Object): any, indent: number = 2): number;

/**
 * 将 TypedArray 格式化为类似 Buffer 的短字符串
 */
export function inspectTypedArray(typedArray: ArrayBufferView, max: number = 50): string;
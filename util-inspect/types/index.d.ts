
type Replacer = (this: any, key: string, value: any) => any;

/**
 * @param value
 * @param replacer
 * @param [indent=2]
 */
export function inspect(value: any, replacer?: Replacer, indent?: number): number;

/**
 * 将 TypedArray 格式化为类似 Buffer 的短字符串
 * @param typedArray
 * @param [max=50]
 */
export function inspectTypedArray(typedArray: ArrayBufferView, max?: number): string;
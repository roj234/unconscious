/**
 * Normalize a path by resolving "." and "..".
 * 如果传入数组，那么不做任何处理直接返回，主要是我有些地方忘了有没有normalize了这样省点性能
 * 它静默删除绝对路径，（但根会钳到Windows盘符）
 * 预期的使用方式是 INTERNAL_BASE_PATH + '/' + normalizePath(...).join('/')
 *
 * @param path - Untrusted user input path string
 * @returns Normalized path segments (without a leading empty string for absolute paths)
 * @throws {Error} If path is not a string or contains illegal characters
 */
export function normalizePath(path: string): string[];

/**
 * Compute a relative path from `base` to `child`.
 * 两个路径必须是绝对路径.
 *
 * @param base - Base path
 * @param child - Child path
 * @returns Relative path string, or `null` if the paths cannot be relativized
 *          (e.g. different Windows drive letters)
 */
export function relativizePath(base: string, child: string): string | null;

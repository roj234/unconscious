/**
 * Normalize a path by resolving "." and "..", unifying separators,
 * and rejecting characters with code < 32.
 *
 * @param path - Untrusted user input path string
 * @returns Normalized path segments (without a leading empty string for absolute paths)
 * @throws {Error} If path is not a string or contains illegal characters
 */
export function normalizePath(path: string): string[];

/**
 * Compute a relative path from `base` to `child`.
 *
 * @param base - Base path
 * @param child - Child path
 * @returns Relative path string, or `null` if the paths cannot be relativized
 *          (e.g. different Windows drive letters)
 */
export function relativizePath(base: string, child: string): string | null;

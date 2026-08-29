
/**
 * Check if a path segment looks like a Windows drive letter (e.g., "C:").
 */
const isWindowsPartition = segment => /^[A-Za-z]:/.test(segment);

const SANITIZER = /[\u2000-\u200f\u2028-\u202f\u205f-\u206f\ufeff]/g;

/**
 * Path normalization function that handles untrusted user input.
 * Normalizes the path by resolving "." and "..", and unifying separators.
 * @param {string} path
 * @returns {string[]}
 */
export function normalizePath(path) {
	// Reject characters with code < 32
	if (typeof path !== 'string') throw new Error("Path must be string");
	if (/[\x00-\x1F\x7F]/.test(path)) throw new Error("Illegal character in path");
	const paths = path.replaceAll('\\', '/').replaceAll(/\/\/+/g, '/').split('/');

	for (let j = 0; j < paths.length; ) {
		let seg = paths[j];
		if (seg === '.') {
			paths.splice(j, 1);
		} else if (seg === '..') {
			paths.splice(j, 1);
			if (j > 0 && !isWindowsPartition(paths[j - 1])) {
				paths.splice(--j, 1);
			} else {
				throw new Error("Forbidden: Path traversal ("+JSON.stringify(path)+")");
			}
		} else {
			j++;
		}
	}

	// Remove leading empty segment (which represents an absolute path root)
	if (paths.length > 0 && paths[0] === '') {
		paths.shift();
	}

	return paths;
}

/**
 * Split a string by a separator, removing any trailing empty strings.
 * This mimics the behavior of TextUtil.split in the original Java code.
 */
const splitPath = (str, sep = '/') => {
	let parts = str.split(sep);
	while (parts.length > 0 && parts[parts.length - 1] === '') {
		parts.pop();
	}
	return parts;
};

/**
 * Computes a relative path from `base1` to `child1`.
 * Returns `null` if the paths cannot be relativized (e.g., different Windows drives).
 * @param {string} base1
 * @param {string} child1
 * @returns {string}
 */
export function relativizePath(base1, child1) {
	let base = normalizePath(base1);
	let child = normalizePath(child1);

	let baseCount = base.length;
	let childCount = child.length;

	// Skip common prefix
	let n = Math.min(baseCount, childCount);
	let i = 0;
	while (i < n) {
		if (base[i] !== child[i]) break;
		i++;
	}

	// If the first differing component is a Windows drive letter, impossible to relativize
	if (i === 0 && childCount > 0 && isWindowsPartition(child[i])) {
		return null;
	}

	// Remainder of the child path
	let childRemaining = child.slice(i);

	// If the whole base was consumed, the relative path is simply the child remainder
	if (i === baseCount) {
		return childRemaining.join('/');
	}

	// Otherwise, go up for each remaining directory in base, then append child remainder
	let baseRemaining = base.slice(i);
	let resultParts = baseRemaining.map(() => '..').concat(childRemaining);
	return resultParts.join('/');
}
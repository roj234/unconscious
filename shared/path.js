
/**
 * Check if a path segment looks like a Windows drive letter (e.g., "C:").
 */
const isWindowsPartition = segment => /^[A-Za-z]:/.test(segment);

const PATH_INVALID = /[\u2000-\u200f\u2028-\u202f\u205f-\u206f\ufeff\x00-\x1F\x7F|<>"*]/g;

/**
 * Path normalization function that handles untrusted user input.
 * Normalizes the path by resolving "." and "..".
 * @param {string | string[]} path
 * @returns {string[]}
 */
export function normalizePath(path) {
	if (Array.isArray(path)) return path;
	if (typeof path !== 'string') throw new Error("Path must be string");
	if (PATH_INVALID.test(path)) throw new Error("Illegal character in path");
	const parts = path.split(/[/\\]+/);

	for (let j = 0; j < parts.length; ) {
		let seg = parts[j];
		if (seg === '.') {
			parts.splice(j, 1);
		} else if (seg === '..') {
			parts.splice(j, 1);
			if (j > 0) {
				if (j === 1 && isWindowsPartition(parts[0])) continue;
				parts.splice(--j, 1);
			} else {
				//return [];
			}
		} else {
			j++;
		}
	}

	while (parts.at(-1) === '') parts.pop();
	// Remove leading empty segment (which represents an absolute path root)
	if (parts.length > 0 && parts[0] === '') parts.shift();

	return parts;
}

/**
 * Computes a relative path from `base1` to `child1`.
 * Returns `null` if the paths cannot be relativized (e.g., different Windows drives).
 * @param {string} base1
 * @param {string} child1
 * @returns {string | null}
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
	if (i === 0 && childCount > 0 && (isWindowsPartition(child[i]) || isWindowsPartition(base[i]))) {
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
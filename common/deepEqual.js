import {isPureObject} from "../runtime_shared.js";

// a modified version of https://www.npmjs.com/package/fast-deep-equal
export const deepEqual = (a, b, ignoredKeys) => {
	if (a === b) return true;

	if (a && b && typeof a == 'object' && typeof b == 'object') {
		if ((a.constructor??Object) !== (b.constructor??Object)) return false;

		var length, i;
		if (Array.isArray(a)) {
			length = a.length;
			if (length !== b.length) return false;
			for (i = length; i-- !== 0;)
				if (!deepEqual(a[i], b[i])) return false;
			return true;
		}

		if ((a instanceof Map) && (b instanceof Map)) {
			if (a.size !== b.size) return false;
			for (i of a.entries())
				if (!b.has(i[0])) return false;
			for (i of a.entries())
				if (!deepEqual(i[1], b.get(i[0]))) return false;
			return true;
		}

		if ((a instanceof Set) && (b instanceof Set)) {
			if (a.size !== b.size) return false;
			for (i of a.entries())
				if (!b.has(i[0])) return false;
			return true;
		}

		if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
			length = a.length;
			if (length !== b.length) return false;
			for (i = length; i-- !== 0;)
				if (a[i] !== b[i]) return false;
			return true;
		}


		if (a.constructor === RegExp) return a.source === b.source && a.flags === b.flags;
		if (a.valueOf !== Object.prototype.valueOf) return a.valueOf() === b.valueOf();
		if (a.toString !== Object.prototype.toString) return a.toString() === b.toString();

		let keysa = Object.keys(a), keysb = Object.keys(b);

		if (ignoredKeys) {
			const predicate = name => !ignoredKeys.has(name);
			keysa = keysa.filter(predicate);
			keysb = keysb.filter(predicate);
		}

		length = keysa.length;
		if (length !== keysb.length) return false;

		for (i = length; i-- !== 0;)
			if (!Object.prototype.hasOwnProperty.call(b, keysa[i])) return false;

		for (i = length; i-- !== 0;) {
			var key = keysa[i];

			if (!deepEqual(a[key], b[key])) return false;
		}

		return true;
	}

	// true if both NaN, false otherwise
	return a!==a && b!==b;
};

export function delta(oldVal, newVal, ignoredKeys) {
	if (oldVal === newVal) return;
	if (oldVal !== oldVal && newVal !== newVal) return;

	const rep = () => {return { $: 'SET', val: newVal }};

	const oldType = typeof oldVal;
	if (oldType !== typeof newVal || oldType !== 'object' || oldVal === null || newVal === null) {
		if (oldType === 'string' && typeof newVal === 'string') {
			const oldLen = oldVal.length;
			const newLen = newVal.length;

			let start = 0;
			const minLen = Math.min(oldLen, newLen);
			while (start < minLen && oldVal[start] === newVal[start]) start++;

			let oldEnd = oldLen - 1;
			let newEnd = newLen - 1;
			while (oldEnd >= start && newEnd >= start && oldVal[oldEnd] === newVal[newEnd]) {
				oldEnd--;
				newEnd--;
			}

			const deleteCount = oldEnd - start + 1;
			const substring = newVal.slice(start, newEnd + 1);

			return { $: 'STR', val: [start, deleteCount, substring, oldLen] };
		}

		return newVal;
	}

	if (Array.isArray(oldVal)) {
		if (!Array.isArray(newVal)) return rep();

		const oldLen = oldVal.length;
		const newLen = newVal.length;

		if (oldLen === newLen) {
			let outPatches;
			const patches = {};
			for (let i = 0; i < oldLen; i++) {
				const d = delta(oldVal[i], newVal[i]);
				if (d !== undefined) {
					patches[i] = d;
					outPatches = patches;
				}
			}
			return outPatches;
		}

		let start = 0;
		const minLen = Math.min(oldLen, newLen);
		while (start < minLen && delta(oldVal[start], newVal[start]) === undefined) start++;

		let oldEnd = oldLen - 1;
		let newEnd = newLen - 1;
		while (oldEnd >= start && newEnd >= start && delta(oldVal[oldEnd], newVal[newEnd]) === undefined) {
			oldEnd--;
			newEnd--;
		}

		const deleteCount = oldEnd - start + 1;
		const items = newVal.slice(start, newEnd + 1);

		return (deleteCount || items.length) ? {$: 'ARR', val: [[start, deleteCount, ...items], oldLen] } : undefined;
	} else if (isPureObject(oldVal)) {
		if (!isPureObject(newVal)) return rep();

		const patches = {};
		const oldKeys = new Set(Object.keys(oldVal));
		if (ignoredKeys) ignoredKeys.forEach(key => oldKeys.delete(key));

		for (const key of Object.keys(newVal)) {
			if (oldKeys.delete(key)) {
				const d = delta(oldVal[key], newVal[key]);
				if (d !== undefined) patches[key] = d;
			} else {
				if (ignoredKeys?.has(key)) continue;

				patches[key] = newVal[key];
			}
		}
		oldKeys.forEach(key => patches[key] = { $: 'DEL' });

		return Object.keys(patches).length ? patches : undefined;
	}

	return deepEqual(oldVal, newVal, ignoredKeys) ? undefined : rep();
}

export function patch(obj, diff, shallowCopy = false) {
	if (diff === undefined) return obj;

	switch (diff?.$) {
		case 'SET': return diff.val;
		case 'ARR': {
			const [val, len] = diff.val;
			const currentLength = obj.length;
			if (currentLength !== len) {
				const [start, deleteCount, ...items] = val;
				const expectedLen = len - deleteCount + items.length;

				if (currentLength !== expectedLen || !deepEqual(obj.slice(start, start + items.length), items))
					throw new Error("data integrity error");
			} else {
				if (shallowCopy) obj = [...obj];
				obj.splice(...val);
			}
			return obj;
		}
		case 'STR': {
			const [start, deleteCount, substring, len] = diff.val;
			const currentLength = obj.length;
			if (currentLength !== len) {
				const expectedLen = len - deleteCount + substring.length;
				if (currentLength === expectedLen && obj.startsWith(substring, start)) return obj;
				throw new Error("data integrity error");
			}
			return obj.slice(0, start) + substring + obj.slice(start + deleteCount);
		}
		case 'DEL':
			return; // undefined
		default:
			let isArray;
			if (typeof diff === "object" && ((isArray = Array.isArray(obj)) || isPureObject(obj))) {
				if (shallowCopy) obj = isArray ? [...obj] : {...obj};

				for (const key of Object.keys(diff)) {
					const diffVal = diff[key];
					if (diffVal?.$ === 'DEL') {
						delete obj[key];
					} else {
						obj[key] = patch(obj[key], diffVal, shallowCopy);
					}
				}
				return obj;
			}

			return diff;
	}
}


export const betterObject = /*#__PURE__*/ Object.create(null);
for (const n of ["toString", "valueOf"]) {
	Object.defineProperty(betterObject, n, {
		value: Object.prototype[n],
		writable: true,
		configurable: true
	});
}

/**
 * @template T
 * @param {T} input
 * @param {Object} [prototype=null]
 * @return {Readonly<T>}
 */
export const immutableObjectMap = (input, prototype = betterObject) => Object.freeze(Object.assign(Object.create(prototype), input));
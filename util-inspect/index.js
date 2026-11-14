import {immutableObjectMap} from "@roj234/shared/objects";

const ESCAPES = immutableObjectMap({
	0x08: 'b',
	0x09: 't',
	0x0a: 'n',
	0x0b: 'v',
	0x0c: 'f',
	0x0d: 'r',
	0x5c: '\\',
	0x22: '"',
	36: '${',
	96: '`',
});

const INLINE_ARRAY_TYPE = immutableObjectMap({
	'null': true,
	"number": true,
	"boolean": true,
	"bigint": true
});

/** 判断键名是否可以不加双引号（JSON5 规范） */
const IDENTIFIER_RE = /^[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*$/u;
const NUMERIC_KEY_RE = /^(?:0[xX][0-9a-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)$/;

const isJSON5Key = key => IDENTIFIER_RE.test(key) || NUMERIC_KEY_RE.test(key);

/** 对带 toJSON 的对象做预处理 */
const prepare = value => typeof value?.toJSON === "function" ? value.toJSON() : value;

/** 键名序列化：合法则裸写，否则用双引号 */
const stringifyKey = key => isJSON5Key(key) ? key : stringifyString(key, true);

const REGEXP_BACKTICK = /[\x00-\x08\x0B-\x1F\\`\u2028\u2029\u3000\u00a0\uFEFF\u200B]|\${/g;
const REGEXP_QUOTE = /[\x00-\x1F\\\u2028\u2029\u3000\u00a0\uFEFF\u200B"]/g;

/**
 *
 * @param {string} s
 * @param {boolean} [noBacktick]
 * @return {string}
 */
const stringifyString = (s, noBacktick) => {
	const useBacktick = !noBacktick && s.includes("\n");
	const escaped = s.replace(useBacktick ? REGEXP_BACKTICK : REGEXP_QUOTE, (match) => {
		const code = match.charCodeAt(0);
		return "\\"+(ESCAPES[code] ?? (code < 0x20 ? "x"+code.toString(16).padStart(2, "0") : "u"+code.toString(16).padStart(4, "0")));
	});
	const escapeChar = useBacktick ? '`' : '"';
	return escapeChar + escaped + escapeChar;
};

const INSPECT_NOTHING = (k, v) => v;
export const INSPECT_ALL = (k, v) => v;

/**
 *
 * @param {any} value
 * @param {function(string, Object): *} [replacer]
 * @param {number | string} [indent]
 * @return {string | undefined}
 */
export function inspect(value, replacer, indent = 2) {
	const space = typeof indent === "string" ? indent : " ".repeat(Math.max(0, indent));
	const seen = new Map();

	const prepared = prepare(value);
	if (prepared === undefined) return;
	return serialize(prepared, 0, space, seen, replacer ?? INSPECT_NOTHING);
}

/**
 * @param {any} value
 * @param {number} depth
 * @param {string} space
 * @param {Map<Object, number>} seen
 * @param {function(string, Object): *} replacer
 * @return {string}
 */
function serialize(value, depth, space, seen, replacer) {
	switch (typeof value) {
		case "string":return stringifyString(value);
		case "symbol":return `Symbol(${stringifyKey(value.description)})`;
		case "number":case "boolean":return String(value);
		case "bigint":return String(value)+"n";
		case "object":
			if (value === null) return "null";

			// 解析器并不支持，但是比报错更麻烦的是一样的对象变成了不一样的
			if (seen.has(value)) return "*#"+seen.get(value)+" /* Circular reference */";
			seen.set(value, seen.size);

			if (value instanceof Error) {
				return value.stack || (value.name + ': ' + value.message);
			}

			if (Array.isArray(value)) {
				return serializeArray(value, depth, space, seen, replacer);
			}

			let typeName = value[Symbol.toStringTag];
			if (typeof typeName !== "string") {
				const prototype = value.__proto__;
				typeName = prototype ? prototype.constructor.name : "[Object: null prototype]";
			}

			if (typeName && typeName !== 'Object') {
				if (typeName === 'RegExp') return String(value);
				try {
					if (typeName === 'WeakRef') {
						const ref = value.deref();
						return typeName+" {"+(ref ? serializeObject(ref, depth, space, seen, replacer) : '<cleared>')+"}";
					}
					if (typeName === 'Map') {
						let result = typeName+`(${value.size}) [`;
						if (value.size === 0) return result+']';

						const currentIndent = space.repeat(depth);
						const childIndent = space.repeat(++depth);

						let delimiter = '\n';

						for (const [key, val] of value) {
							result += delimiter;
							result += childIndent + (serialize(key, depth, space, seen, replacer)) + " => " + serialize(val, depth, space, seen, replacer);
							delimiter = ",\n";
						}

						return result + "\n" + currentIndent + "]";
					}
					if (typeName === 'Set') return typeName+`(${value.size}) `+serializeArray([...value], depth, space, seen, replacer);
					if (value.buffer instanceof ArrayBuffer) {
						if (typeof value.length === 'number') {
							return inspectTypedArray(value);
						}
						if (value instanceof DataView) {
							const currentIndent = space.repeat(depth);
							const childIndent = space.repeat(1+depth);
							return `${typeName} {\n${childIndent}buffer: ${inspectTypedArray(new Uint8Array(value.buffer))}\n${childIndent}byteOffset: ${value.byteOffset}\n${childIndent}byteLength: ${value.byteLength}\n${currentIndent}}`;
						}
					}
					if (value instanceof ArrayBuffer) {
						const currentIndent = space.repeat(depth);
						const childIndent = space.repeat(1+depth);
						return `${typeName} {\n${childIndent}[Uint8Contents]: ${inspectTypedArray(new Uint8Array(value))}\n${childIndent}[ByteLength]: ${value.byteLength}\n${currentIndent}}`;
					}
				} catch {}

				if (replacer === INSPECT_ALL) {
					return typeName+" "+serializeObject(value, depth, space, seen, replacer);
				}
			}

			return serializeObject(value, depth, space, seen, replacer);
		case "function":return '[Function: '+(value.name || 'anonymous')+']';
		//case "undefined":
		default:return replacer === INSPECT_ALL ? "undefined" : "null";
	}
}

/**
 * @param {Array} arr
 * @param {number} depth
 * @param {string} space
 * @param {Map<Object, number>} seen
 * @param {function(string, Object): *} replacer
 * @return {string}
 */
function serializeArray(arr, depth, space, seen, replacer) {
	if (!arr.length) return "[]";

	const items = arr.map(prepare);

	let result;

	if (items.every(v => v == null || INLINE_ARRAY_TYPE[typeof v])) {
		result = "[ ";

		if (items.length) {
			for (let i = 0;;) {
				result += serialize(items[i], depth, space, seen, replacer);
				if (++i === items.length) break;
				result += ', ';
			}
		}

		result += " ]";
	} else {
		const currentIndent = space.repeat(depth);
		result = "[\n";

		const childIndent = space.repeat(++depth);
		let i = 0;
		for (;;) {
			result += childIndent + serialize(items[i], depth, space, seen, replacer);
			if (++i === items.length) break;
			result += ',\n';
		}
		result += "\n" + currentIndent + "]";
	}

	return result;
}

/**
 * @param {Object} obj
 * @param {number} depth
 * @param {string} space
 * @param {Map<Object, number>} seen
 * @param {function(string, Object): *} replacer
 * @return {string}
 */
function serializeObject(obj, depth, space, seen, replacer) {
	let names = Object.getOwnPropertyNames(obj);
	if (replacer === INSPECT_ALL) names.push(...Object.getOwnPropertySymbols(obj));
	if (!names.length) return "{}";

	const currentIndent = space.repeat(depth);
	const childIndent = space.repeat(++depth);

	let result = '{\n';
	let delimiter = '';

	for (const key of names) {
		const value = obj[key];
		const prepared = prepare(replacer(key, value));
		if (prepared === undefined && replacer !== INSPECT_ALL) continue;

		result += delimiter;
		result += childIndent + (typeof key === 'symbol' ? `Symbol(${stringifyKey(key.description)})` : stringifyKey(key)) + ": " + serialize(prepared, depth, space, seen, replacer);
		delimiter = ",\n";
	}

	if (!delimiter) return "{}";

	return result + "\n" + currentIndent + "}";
}

/**
 * 将 TypedArray 格式化为类似 Buffer 的短字符串
 * @param {ArrayBufferView} bytes - 任意 TypedArray 实例
 * @param {number} [max=50] - 前后最多展示的字节数（默认50）
 * @returns {string} 格式如 "<Uint8Array 01 02 03 ... 10 more bytes ... fe ff>"
 */
export function inspectTypedArray(bytes, max = 50) {
	const typeName = bytes.constructor.name;
	const length = bytes.length;

	if (typeName === "Buffer") {
		const toHex = (arr) => Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join(' ');
		if (length <= max * 2) return `<${typeName} ${toHex(bytes)}>`;

		const front = toHex(bytes.subarray(0, max));
		const back = toHex(bytes.subarray(-max));
		const more = length - max * 2;
		return `<${typeName} ${front} ... ${more} more bytes ... ${back}>`;
	} else {
		const toStr = arr => arr.join(", ");
		if (length <= max) return `${typeName}(${length}) `+(length ? `[ ${toStr(bytes)} ]` : '[]');

		const front = toStr(bytes.subarray(0, max));
		const more = length - max;
		return `${typeName} [ ${front}, ... ${more} more items ]`;
	}

}

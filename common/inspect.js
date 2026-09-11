import {immutableObjectMap} from "./Utils.js";

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
const stringifyKey = key => isJSON5Key(key) ? key : stringifyString(key);

const REGEXP_BACKTICK = /[\x00-\x08\x0B-\x1E\\`\u2028\u2029\u3000\u00a0\uFEFF\u200B]|\${/g;
const REGEXP_QUOTE = /[\x00-\x1E\\\u2028\u2029\u3000\u00a0\uFEFF\u200B"]/g;

/**
 *
 * @param {string} s
 * @return {string}
 */
const stringifyString = s => {
	const useBacktick = s.includes("\n");
	const escaped = s.replace(useBacktick ? REGEXP_BACKTICK : REGEXP_QUOTE, (match) => {
		const code = match.charCodeAt(0);
		return "\\"+(ESCAPES[code] ?? (code < 0x20 ? "x"+code.toString(16).padStart(2, "0") : "u"+code.toString(16).padStart(4, "0")));
	});
	const escapeChar = useBacktick ? '`' : '"';
	return escapeChar + escaped + escapeChar;
};

const TKV = (k, v) => v;

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
	return serialize(prepared, 0, space, seen, replacer ?? TKV);
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
		case "symbol":case "number":case "boolean":return String(value);
		case "bigint":return String(value)+"n";
		case "object":
			if (value === null) return "null";

			// 解析器并不支持，但是比报错更麻烦的是一样的对象变成了不一样的
			if (seen.has(value)) return "*#"+seen.get(value)+" /* Circular reference */";
			seen.set(value, seen.size);

			if (value instanceof Error) {
				return value.stack || (value.name + ': ' + value.message);
			}

			if (value.buffer instanceof ArrayBuffer && typeof value.length === 'number') {
				return inspectTypedArray(value.buffer);
			}

			if (Array.isArray(value)) {
				return serializeArray(value, depth, space, seen, replacer);
			}

			let typeName = value[Symbol.toStringTag];
			if (typeof typeName !== "string") {
				const prototype = value.__proto__;
				if (!prototype) {
					if (replacer !== TKV)
						typeName = "[Object: null prototype]";
				} else {
					typeName = prototype.constructor.name;
				}
			}

			if (typeName && typeName !== 'Object')
				return typeName+" "+serializeObject(value, depth, space, seen, replacer);

			return serializeObject(value, depth, space, seen, replacer);
		case "function":return '[Function: '+(value.name || 'anonymous')+']';
		//case "undefined":
		default:return replacer === TKV ? "null" : "undefined";
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

	if (items.every(v => INLINE_ARRAY_TYPE[typeof v])) {
		result = "[ "+items.join(", ")+" ]";
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
	const entries = Object.entries(obj);
	if (!entries.length) return "{}";

	const currentIndent = space.repeat(depth);
	const childIndent = space.repeat(++depth);

	let result = '{\n';
	let delimiter = '';

	for (const [key, value] of entries) {
		const prepared = prepare(replacer(key, value));
		if (prepared === undefined && replacer === TKV) continue;

		result += delimiter;
		result += childIndent + stringifyKey(key) + ": " + serialize(prepared, depth, space, seen, replacer);
		delimiter = ",\n";
	}

	return result + "\n" + currentIndent + "}";
}

/**
 * 将 TypedArray 格式化为类似 Buffer 的短字符串
 * @param {ArrayBufferView} typedArray - 任意 TypedArray 实例
 * @param {number} [max=50] - 前后最多展示的字节数（默认50）
 * @returns {string} 格式如 "<Uint8Array 01 02 03 ... 10 more bytes ... fe ff>"
 */
export function inspectTypedArray(typedArray, max = 50) {
	// 取得底层字节数组
	const bytes = new Uint8Array(
		typedArray.buffer,
		typedArray.byteOffset,
		typedArray.byteLength
	);
	const typeName = typedArray.constructor.name;
	const length = bytes.length;
	// 辅助：将字节数组转为空格分隔的十六进制字符串
	const toHex = (arr) =>
		Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join(' ');
	if (length <= max * 2) {
		// 小于阈值，显示全部字节
		return `<${typeName} ${toHex(bytes)}>`;
	}
	// 超过阈值，只显示首尾 max 个字节
	const front = toHex(bytes.slice(0, max));
	const back = toHex(bytes.slice(-max));
	const more = length - max * 2;
	return `<${typeName} ${front} ... ${more} more bytes ... ${back}>`;
}

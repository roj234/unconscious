import {deepEqual} from "./deepEqual.js";
import {isPureObject} from "unconscious";

// llama.cpp的value替换为 type: SCHEMA_VALUES
const SCHEMA_VALUES = ["object", "array", "string", "number", "boolean", "null"];

/**
 * DFS
 * @param {Object} obj
 * @param {Set<Object>} seen
 * @return {Generator<any, Object, string>}
 */
export function* deepEntries(obj, seen = new Set()) {
	if (obj === null || typeof obj !== 'object') return;
	if (seen.has(obj)) return;
	seen.add(obj);

	for (const key of Object.getOwnPropertyNames(obj)) {
		const value = obj[key];
		if (value && typeof value === 'object') {
			yield* deepEntries(value, seen);
		}
		yield [value, obj, key];
	}
}

/**
 *
 * @param {string} path
 * @param {'.' | '/'} separator
 * @return {string[]}
 */
export const parseJsonPath = (path, separator = '.') => {
	const keys = path.split(separator);
	for (let i = 0; i < keys.length; i++) {
		const key = keys[i];
		if (key.endsWith("]")) {
			const j = key.indexOf("[");
			const pre = key.slice(0, j);
			const post = key.slice(j+1, key.length-1);
			keys.splice(i, 1, pre, post);
			i++;
		}
	}
	return keys;
}

export const jsonGet = (obj, path) => {
	const keys = Array.isArray(path) ? path : parseJsonPath(path);

	for (let i = 0; i < keys.length - 1; i++) {
		obj = obj[keys[i]];
		if (!obj) return;
	}

	return obj[keys[keys.length - 1]];
};

/**
 * 辅助函数：解析路径并操作对象
 * @param {Object} obj
 * @param {string|string[]} path
 * @param {'set' | 'plus' | 'push' | 'merge' | 'delete' | 'get'} action
 * @param {any=} value
 * @return {{value: any, undo: any}}
 */
export const jsonPathOp = (obj, path, action, value) => {
	const keys = Array.isArray(path) ? path : parseJsonPath(path);

	let current = obj;
	for (let i = 0; i < keys.length - 1; i++) {
		if (!current[keys[i]]) {
			if (action === "delete") return {value: false};
			if (action === "get") return {};

			current[keys[i]] = {};
		}
		current = current[keys[i]];
	}
	const lastKey = keys[keys.length - 1];

	let container = current[lastKey];
	let undo = container;

	switch (action) {
		case 'get': return {value: container};
		case 'set': container = value; break;
		case 'plus': container = Number(container || 0) + Number(value); break;
		case 'push':
			if (!Array.isArray(container)) {
				if (container) throw new Error("值 "+path+" 已存在且不是数组！");
				container = [];
			}

			undo = container.length;
			if (Array.isArray(value)) container.push(...value);
			else container.push(value);
			break;
		case 'merge': container = { ...container, ...value }; break;
		case 'delete': {
			if (Array.isArray(current)) {
				undo = current.splice(parseInt(lastKey), 1);
				return {
					undo: {
						_isArray: true,
						value: undo
					},
					value: undo
				}
			} else {
				undo = current[lastKey];
				return {
					undo,
					value: delete current[lastKey]
				};
			}
		}
	}

	current[lastKey] = container;
	return {
		undo,
		value: container
	};
};

/**
 * 对输入的 JSON Schema 进行预处理和优化：
 * 1. 将 `$ref` 引用原地替换为实际引用的子模式（仅支持 `#/` 开头的内部路径）。
 * 2. 调整 `type` 字段：`"value"` 替换为通用值模式 `SCHEMA_VALUES`；`"object"` 且未显式声明 `additionalProperties` 时默认设为 `false`。
 * 3. 若存在 `enum` 但缺少 `type`，则通过枚举值推导出类型（单一类型或类型数组）。
 * 4. 对 `oneOf` / `anyOf` 进行优化：提取所有分支模式的公共属性，重构为 `allOf` 结构（公共部分 + 原组合器），以减少冗余并可能提升后续处理效率。
 *
 * **注意**：该函数会**直接修改**传入的 `input` 对象并返回该对象。
 *
 * @template {Schema} T
 * @param {T} input - 待编译的 JSON Schema 对象（会被原地修改）
 * @param {boolean=} openAIStrict
 * @returns {T} 编译后的同一 Schema 对象（即修改后的 `input`）
 */
export function compileSchema(input, openAIStrict) {
	for (const [val, own, key] of deepEntries(input)) {
		const $ref = val?.$ref;
		if ($ref) own[key] = jsonGet(input, parseJsonPath($ref.slice(2), '/'));

		// OpenAI 严格模式
		if (openAIStrict) {
			if (key === "type") {
				if (val === "value") own[key] = SCHEMA_VALUES;
				else if (val === "object") {
					if (own["additionalProperties"] == null)
						own["additionalProperties"] = false;
				}
			} else

			if (key === "const") {
				delete own[key];
				own["enum"] = [val];
				own["type"] = typeof val;

			} else

			if (key === "enum") {
				if (own["type"] == null) {
					const set = new Set;
					val.forEach(item => set.add(typeof item));
					let result = [...set];
					own["type"] = set.size === 1 ? result[0] : result;
					if (!result.length) throw new Error("enum must nonempty");
				}
			}
		}

		// 尝试提取公共前缀
		if (key === "oneOf" || key === "anyOf") {
			const [first] = val;
			if (typeof first !== 'object' || first === null) continue;

			const common = {};
			for (const k of Object.keys(first)) {
				const firstVal = first[k];
				let allHave = true;
				for (let i = 1; i < val.length; i++) {
					const sub = val[i];
					if (!(k in sub) || !deepEqual(sub[k], firstVal)) {
						allHave = false;
						break;
					}
				}
				if (allHave) {
					common[k] = firstVal;
				}
			}

			if (Object.keys(common).length) {
				// 删除公共属性
				for (const branch of val) {
					for (const ck of Object.keys(common)) {
						delete branch[ck];
					}
				}

				const newAllOf = [common, { [key]: val }];
				if (own.allOf) own.allOf.push(...newAllOf);
				else own.allOf = newAllOf;

				delete own[key];
			}
		}
	}
	return input;
}

const isEmptyObject = (obj) => !Object.keys(obj).length;

/**
 * 验证并返回错误，输入必须是对象
 * @param {Object} o
 * @param {ObjectSchema} schema
 * @return {string}
 */
export function validateAndShowError(o, schema) {
	const issues = {};
	validate(o, schema, issues);
	const entries = Object.entries(issues);
	if (entries.length) return entries.map(([k, v]) => k+": "+v).join("\n");
}

/**
 * 进行JSON Schema解析
 * @param {any} o
 * @param {Schema} schema
 * @param {Record<string, string>} issues
 * @param {string} [path]
 */
export function validate(o, schema, issues, path = "$") {
	const error = err => issues[path] = err;

	const candidates = schema.const ? [schema.const] : schema.enum;
	found:
	if (candidates?.length) {
		for (let candidate of candidates) {
			if (deepEqual(candidate, o))
				break found;
		}
		error("value("+JSON.stringify(o)+") must in "+JSON.stringify(candidates));
	}

	const {default: def, type: types} = schema;

	if (o == null && def !== undefined)
		return def;

	const isType = (type) => {
		switch (type) {
			case 'value':
				return true;
			case 'null':
				return o === null;
			case 'string':
			case 'boolean':
			case 'number':
				return typeof o === type;
			case 'object':
				return isPureObject(o);
			case 'array':
				return Array.isArray(o);
			case 'integer':
				return typeof o === 'bigint' || Number.isInteger(o);
		}
	}
	let matchType;

	checkTypeMatch:{
		if (Array.isArray(types)) {
			for (const t of types) {
				if (isType(matchType = t))
					break checkTypeMatch;
			}
		} else {
			if (types == null || isType(matchType = types))
				break checkTypeMatch;
		}

		error("type must be "+JSON.stringify(types));
	}

	switch (matchType) {
		case 'object': {
			const {required = [], properties, additionalProperties = 1} = schema;
			const requiredSet = new Set(required);
			for (const key of Object.keys(o)) {
				requiredSet.delete(key);

				let property = properties[key];
				if (!property) {
					if (!additionalProperties) {
						error("additional property "+JSON.stringify(key));
					}
					if (typeof additionalProperties !== "object") {
						// default (omit)
						if (additionalProperties === 1) {
							// 如果指定了 clean 就删除多余字段
							if (issues["clean"]) delete properties[key];
						}
						continue;
					}
					property = additionalProperties;
				}

				o[key] = validate(o[key], property, issues, path+"."+key);
			}

			for (const key of requiredSet) {
				let {default: def} = properties[key];
				if (def !== undefined) {
					o[key] = def;
					requiredSet.delete(key);
				}
			}

			if (requiredSet.size) {
				error("missing required fields: "+JSON.stringify([...requiredSet]));
			}
		}
		break;
		case 'array': {
			const {minItems = 0, maxItems = NaN, items} = schema;
			const len = o.length;
			if (len < minItems || len > maxItems) {
				error(`length(${len}) must in [${minItems || ''}, ${maxItems || ''}]`);
			}
			if (items) {
				for (let i = 0; i < len; i++) {
					o[i] = validate(o[i], items, issues, path+"["+i+"]");
				}
			}
		}
		break;
		case 'string': {
			const {minLength = NaN, maxLength = NaN, pattern, format} = schema;
			const len = o.length;
			if (len < minLength || len > maxLength) {
				error(`length(${len}) must in [${minLength || ''}, ${maxLength || ''}]`);
			}
			if (pattern && !new RegExp(pattern).test(o)) {
				error("value("+JSON.stringify(o)+") must match pattern "+JSON.stringify(pattern));
			}
			// format 未实现 'date' | 'time' | 'date-time' | 'uri' | 'email' | 'hostname' | 'ipv4' | 'ipv6' | 'uuid'
		}
		break;
		case 'number':
		case 'integer': {
			const {minimum = NaN, maximum = NaN, exclusiveMinimum = NaN, exclusiveMaximum = NaN, multipleOf} = schema;
			if (o < minimum || o <= exclusiveMinimum || o > maximum || o >= exclusiveMaximum) {
				let str;
				str = exclusiveMinimum !== exclusiveMinimum ? '[' + (minimum || '') : '(' + exclusiveMinimum;
				str += ', ';
				str += exclusiveMaximum !== exclusiveMaximum ? (maximum || '') + ']' : exclusiveMaximum + ')';
				error(`value(${o}) must in `+str);
			}
			if (multipleOf && (o % multipleOf)) {
				error(`value(${o}) must be multiple of `+multipleOf);
			}
		}
		break;
	}

	let _if = schema["if"];
	if (_if) {
		const issues1 = {};
		validate(o, _if, issues1, path);

		const next = schema[isEmptyObject(issues1) ? "then" : "else"];
		if (next) validate(o, next, issues, path);
	}

	let subSchemas = schema.anyOf;
	anyOf:
	if (subSchemas) {
		let lastIssue;
		for (let i = 0; i < subSchemas.length; i++) {
			lastIssue = {};
			o = validate(o, subSchemas[i], lastIssue, path+"[anyOf:"+i+"]");
			if (isEmptyObject(lastIssue)) break anyOf;
		}
		Object.assign(issues, lastIssue);
	}

	if ((subSchemas = schema.allOf)) {
		for (let i = 0; i < subSchemas.length; i++){
			o = validate(o, subSchemas[i], issues, path+"[allOf:"+i+"]");
		}
	}

	if ((subSchemas = schema.oneOf)) {
		let lastIssue, lastSuccess, lastSuccessIdx;
		for (let i = 0; i < subSchemas.length; i++) {
			lastIssue = {};
			let result = validate(o, subSchemas[i], lastIssue, path+"[oneOf:"+i+"]");
			if (!isEmptyObject(lastIssue)) continue;

			if (lastSuccess !== undefined) error("many("+lastSuccessIdx+","+i+") oneOf matches");
			lastSuccess = result;
			lastSuccessIdx = i;
		}
		if (lastSuccess !== undefined) return lastSuccess;
		error("no oneOf matches");
		Object.assign(issues, lastIssue);
	}

	return o;
}

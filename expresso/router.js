/**
 * OKRouter —— 极简、零依赖的 HTTP 路由核心（node:http 兼容）
 */
import {immutableObjectMap} from "@roj234/shared/objects";

// 尾斜杠的三种态度
const ANY = 0;
const FILE = 1;
const DIRECTORY = 2;

/**
 * 静态优先级，数字大的赢。顺序按 Route.java 第 45 行：
 *   精确路径 > 正则约束 > 无约束 > ? > + > *
 */
const QUANT_RANK = {1: 3, '?': 2, '+': 1, '*': 0}

class Node {
	/** @type {Map<string, Node>} */
	literal = new Map()
	/** @type {ParamNode[]} quant='1' 的 ParamNode */
	params = []
	/** @type {ParamNode[] | undefined} 其余 ParamNode */
	qparams = undefined
	/** @type {Map<string, Function>} */
	routes = null
	/** @type {ANY | FILE | DIRECTORY} */
	flag = -1

	priority() {
		return 100;
	}
}

class ParamNode extends Node {
	/**
	 * @param {string} name 参数名
	 * @param {string | undefined} source 正则源串
	 * @param {'1' | '?' | '+' | '*'} quant
	 */
	constructor(name, source, quant) {
		super()
		this.name = name
		this.source = source
		this.quant = quant
		this.regex = source ? new RegExp(`^(?:${source})$`) : null
	}

	priority() {
		return (this.regex !== null ? 60 : 40) + QUANT_RANK[this.quant];
	}
}

const PARAM_RE = /^:([\w-]+)(?:\((.+)\))?([+*?])?$/;

/** 注册专用：'/a/b' -> ['a','b']；'/' -> []；'/a/' -> ['a']（尾斜杠不算一段） */
function splitPath(path) {
	let p = path;
	let start = 0;
	let end = p.length;
	if (p.charCodeAt(0) === 47) start++;
	if (p.charCodeAt(end - 1) === 47) end--;
	return p.slice(start, end).split('/');
}

function decode(s) {
	try {
		return decodeURIComponent(s)
	} catch {
		return s
	}
}

// ---------------------------------------------------------------- Params

/** 参数的原值表藏在 Symbol 上：定义为不可枚举，不出现在 {...params} / JSON / for...in 里 */
const ALL = Symbol('params');

/** 共同的 Params 原型。null 原型 → 没有 toString / constructor / __proto__ setter，参数名不会被污染 */
const _MultiMap = Object.create(null);

/**
 * 取某个参数的全部值。单段捕获 → 长度为 1；:name+ / :name* → 逐段给出。
 * @returns {string[]} 没这个参数时返回 []
 */
_MultiMap.getAll = function (name) {
	return this[ALL][name] ?? [];
}

/**
 * 参数链表 -> Params（链表是反序的，所以倒着填）。
 * 第一个值直接放属性上，全部值放 getAll 里。
 */
function toMultiMap(par) {
	const dict = Object.create(null)
	if (par !== null) {
		const list = []
		while (par !== null) {
			list.push(par)
			par = par.prev
		}
		for (let i = list.length - 1; i >= 0; i--) {
			const e = list[i]
			const a = dict[e.name]
			if (a === undefined) dict[e.name] = [e.value]
			else a.push(e.value)
		}
	}

	const out = Object.create(_MultiMap)
	Object.defineProperty(out, ALL, {value: dict})
	for (const k in dict) out[k] = dict[k][0]
	return out
}

const HTTP_CODES = immutableObjectMap({
	'GET': 0,
	'POST': 1,
	'PUT': 2,
	'HEAD': 3,
	'PATCH': 4,
	'DELETE': 5,
	'OPTIONS': 6,
	'UPGRADE': 7
})

export class Router {
	#n1 = [];
	#p1 = [];
	#n2 = [];
	#p2 = [];
	root = new Node();

	/**
	 * @param {Object} [options]
	 * @param {boolean} [options.strict=true] 默认严格：'/a' 不匹配 '/a/'（Route.java 第 50 行）
	 */
	constructor(options = {}) {
		this.options = options
		this.strict = options.strict !== false
	}

	// ---------------------------------------------------------------- 注册

	/**
	 * @param {string} method HTTP 方法，大小写不敏感
	 * @param {string} path 路径，开头有无 '/' 都一样（Route.java 第 40 行）
	 * @param {Function} handler 任意调用形状，本模块不假定
	 * @param {Object} [options]
	 * @param {boolean} [options.strict] 覆盖 router 级默认值：
	 *        false 时 '/user' 同时匹配 '/user' 和 '/user/'（Route.java 第 51 行）
	 * @returns {this}
	 */
	add(method, path, handler, options) {
		const M = method.toUpperCase();
		const c = HTTP_CODES[M];
		if (undefined === c) throw new TypeError(`非法 method: ${method}`);

		const strict = options?.strict ?? this.strict;
		const segs = splitPath(path);
		const endsWithSlash = path.charCodeAt(path.length - 1) === 47;
		const flag = endsWithSlash ? DIRECTORY : (!strict ? ANY : FILE);

		let node = this.root;
		for (let i = 0; i < segs.length; i++) node = this.#child(node, segs[i], i === segs.length - 1);

		if (node.flag === -1) node.flag = flag;
		else if (node.flag !== flag) throw new Error(`同一路径的尾斜杠定义不一致: ${M} ${path}`);

		const routes = node.routes ??= new Map();
		if (routes.has(M)) throw new Error(`路由已注册: ${M} ${path}`);
		routes.set(M, handler);
		return this
	}

	/** 取（必要时创建）某一段对应的子节点 */
	#child(node, seg, last) {
		if (seg.charCodeAt(0) === 58 /* : */) {
			const m = PARAM_RE.exec(seg)
			if (m === null) throw new TypeError(`无法解析的路径段: ${seg}`)

			const name = m[1]
			const source = m[2];
			const quant = m[3] ?? '1'

			if (!last && (quant === '?' || quant === '*') && source === undefined) {
				throw new Error(`不允许在非末尾路径上使用零宽转移路径段 '${seg}': 会有歧义`)
			}

			const next = new ParamNode(name, source, quant);

			const list = quant === '1' ? node.params : (node.qparams ??= []);
			for (const p of list) {
				if (p.name === name && p.source === source && p.quant === quant) return p;
			}

			list.push(next);
			return next;
		}

		let child = node.literal.get(seg);
		if (child === undefined) {
			child = new Node();
			node.literal.set(seg, child);
		}
		return child
	}

	/**
	 * @param {string} method
	 * @param {string} path
	 * @returns {{handler: Function, params: Object} | {allow: string[]} | null}
	 */
	find(method, path) {
		const M = String(method).toUpperCase();

		path = path.slice(1);

		// 尾斜杠不参与走树，只作为终点判定的一部分（同 Java 的 isFile）
		const isFile = path.length > 0 && path.charCodeAt(path.length - 1) !== 47;
		if (!isFile) path = path.slice(0, -1);

		const len = path.length;
		const start = path.charCodeAt(0) === 47 ? 1 : 0;

		let curN = this.#n1;
		let curP = this.#p1;
		let nxtN = this.#n2;
		let nxtP = this.#p2;
		let curSize = 1;
		let nxtSize = 0;
		curN[0] = this.root;
		curP[0] = null;

		let seg = ''
		let dseg = ''

		const push = (node, par) => {
			nxtN[nxtSize] = node
			nxtP[nxtSize] = par
			nxtSize++
		}

		/** 让 node 的子节点消费当前段 */
		const consumeFrom = (node, par) => {
			if (node.literal.size !== 0) {
				const lit = node.literal.get(seg)
				if (lit !== undefined) push(lit, par)
			}
			// 空段（尾斜杠产生的）只允许字面量 '' 消费，参数段不吃它
			if (seg === '') return

			const ps = node.params
			for (let j = 0; j < ps.length; j++) {
				const p = ps[j]
				if (p.regex !== null && !p.regex.test(seg)) continue
				push(p, {name: p.name, value: dseg, prev: par})
			}

			const qp = node.qparams
			if (qp === undefined) return
			for (let j = 0; j < qp.length; j++) {
				const p = qp[j]
				if (p.regex === null) {
					// 无正则的 qparam 只剩 '+'：必须吃一段
					push(p, {name: p.name, value: dseg, prev: par})
				} else if (p.regex.test(seg)) {
					// 匹配 → 吃掉这一段
					push(p, {name: p.name, value: dseg, prev: par})
				} else {
					// 不匹配 → 确定性地跳过，让它的子节点吃这一段（等价于 Java 的 ZERO 分支）
					consumeFrom(p, par)
				}
			}
		}

		/** 层内候选：既能消费当前段，也能自环（+ / * 表示还能再吃一段） */
		const expand = (node, par) => {
			consumeFrom(node, par)
			if (seg !== '' && (node.quant === '+' || node.quant === '*')) {
				if (node.regex === null || node.regex.test(seg)) {
					// 自环：同一参数再绑一段，链上连续追加，getAll 自然拿到多值
					push(node, {name: node.name, value: dseg, prev: par})
				}
			}
		}

		let i = start
		for (; i <= len;) {
			let e = path.indexOf('/', i);
			if (e === -1 || e >= len) e = len
			seg = path.substring(i, e)
			dseg = decode(seg)

			nxtSize = 0
			for (let k = 0; k < curSize; k++) expand(curN[k], curP[k])

			const tn = curN;
			curN = nxtN;
			nxtN = tn
			const tp = curP;
			curP = nxtP;
			nxtP = tp
			curSize = nxtSize
			if (curSize === 0) break
			i = e + 1
		}

		// 末尾：可零段的参数可以不吃任何段直接结束（这就是"可选段在路径末尾"）
		let k = 0
		while (k < curSize) {
			const node = curN[k]
			const par = curP[k]
			k++
			const qp = node.qparams
			if (qp === undefined) continue
			for (let j = 0; j < qp.length; j++) {
				const p = qp[j]
				if (p.quant === '+') continue
				curN[curSize] = p
				curP[curSize] = par
				curSize++
			}
		}

		let bestPrio = -1
		let bestHandler = null
		let bestPar = null
		let allow = null

		for (let j = 0; j < curSize; j++) {
			const node = curN[j]
			const routes = node.routes
			if (routes === null) continue

			// 尾斜杠的三种态度，同 Java 的 DIRECTORY / FILE / 无 flag
			if (node.flag === FILE ? !isFile : node.flag === DIRECTORY ? isFile : false) continue


			const h = routes.get(M === 'HEAD' && !routes.has(M) ? 'GET' : M);
			if (h !== undefined) {
				const pr = node.priority();
				if (pr > bestPrio) {
					bestPrio = pr;
					bestHandler = h;
					bestPar = curP[j];
				}
				continue
			}

			// 收集这个节点上所有可用的方法
			allow ??= new Set();
			for (const name of routes.keys()) allow.add(name);
		}

		if (bestHandler !== null) return {handler: bestHandler, params: toMultiMap(bestPar)}
		if (allow !== null) return {allow: [...allow].sort()}
		return null
	}
}

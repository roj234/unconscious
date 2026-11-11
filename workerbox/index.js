import SandboxWorker from './worker/sandbox.js?worker';
import {applyEdits, ESMParseError, isIdentifierName, parseModule} from '@roj234/esm-parser';
import {normalizeLineTerminator} from "@roj234/shared/strings";

//region Module transformer
const quote = JSON.stringify;
const quoteIdent = name => isIdentifierName(name) ? name : quote(name);
/** `a` → `.a`，`weird-name` → `["weird-name"]` */
const prop = name => isIdentifierName(name) ? '.' + name : '[' + quote(name) + ']';
/**
 * @param {Array<{name: string, alias: string}>} specs
 * @returns {string}
 */
const namedDestruct = specs => `{ ${specs.map(({name, alias}) => name === alias ? quoteIdent(name) : `${quoteIdent(name)}: ${alias}`).join(', ')} }`;

/**
 * 把一份 ES 模块源码变成沙箱里能跑的 async 函数体。
 *
 * 注意：解构声明（`export const {a} = obj`）静态拿不到名字，不会生成导出。
 *
 * @param {string} path 模块名，会注入成 `__moduleId`
 * @param {string} code 原始源码
 * @returns {string}
 */
function bundleModule(path, code) {
	let temp = 0;
	/** 生成不撞名的临时变量 */
	const nextTmp = () => '__tmp_' + temp++;

	/** 待应用的编辑，区间一律左闭右开 */
	const edits = [];
	/** import.meta 用到的头部声明，只有真用到了才加 */
	let metaUsed = '';

	// #! 放进函数体里是非法的，直接扔掉
	if (code.startsWith('#!')) {
		const hashbangEnd = code.indexOf('\n');
		edits.push({start: 0, end: hashbangEnd < 0 ? code.length : hashbangEnd, replacement: ''});
	}

	/**
	 * 导入表达式的文本。
	 * @param {string} name 模块说明符
	 * @param {string} [type] import attributes 里的 type，此时取 default
	 * @returns {string}
	 */
	const resolveModule = (name, type) => {
		const attrs = type === undefined ? '' : `, { with: { type: ${quote(type)} } }`;
		const call = `await _imp(__moduleId, ${quote(name)}${attrs})`;
		return type === undefined ? call : `(${call}).default`;
	};

	/**
	 * @param {import('@roj234/esm-parser').ImportNode} node
	 * @returns {string}
	 */
	const transformImport = node => {
		const type = node.attribute?.entries.type;

		if (type !== undefined) {
			// with { type: 'text' | 'json' }：加载器直接返回内容，只有默认导入有意义
			if (node.namespace || node.specifiers)
				throw new ESMParseError('类型导入不支持命名导入或命名空间导入', code, node.start);

			const module = resolveModule(node.source, type);
			return node.default ? `const ${node.default} = ${module};` : module + ';';
		}

		const module = resolveModule(node.source);
		if (!node.namespace && !node.default && !node.specifiers) return module + ';'; // import 'x'

		const tmp = node.namespace ?? nextTmp();
		const live = [];
		let out = `const ${tmp} = ${module};`;

		if (node.default) {
			out += `let ${node.default} = ${tmp}.default;`;
			live.push(`${node.default} = ${tmp}.default;`);
		}
		if (node.specifiers) {
			out += `let ${namedDestruct(node.specifiers)} = ${tmp};`;
			for (const {name, alias} of node.specifiers) live.push(`${alias} = ${tmp}${prop(name)};`);
		}

		// 模块初始化完再回填一次，免得循环引用拿到 undefined
		if (live.length) out += `__onload(${quote(node.source)}, () => {${live.join('')}});`;
		return out;
	};

	/**
	 * export 语句：返回前缀区间的替换文本，语句尾巴上要补的导出另外插进去。
	 * @param {import('@roj234/esm-parser').ExportNode} node
	 * @returns {string}
	 */
	const transformExport = node => {
		/** 在整条语句之后插入 */
		const append = text => edits.push({start: node.statementEnd, end: node.statementEnd, text: text});

		// export * [as ns] from 'x' / export {a as b} from 'x'
		if (node.source !== undefined) {
			const module = resolveModule(node.source);

			if (node.namespace !== undefined) return `exports${prop(node.namespace)} = ${module};`;

			const tmp = nextTmp();
			let out = `const ${tmp} = ${module};`;
			for (const {name, alias} of node.specifiers ?? []) out += `exports${prop(alias)} = ${tmp}${prop(name)};`;
			// export * from 'x'：全转出去，但不转 default
			if (!node.specifiers) out += `for(const k in ${tmp}){if(k!=="default")exports[k]=${tmp}[k];}`;
			return out;
		}

		// export {a, b as c}
		if (node.specifiers) {
			let out = '';
			for (const {name, alias} of node.specifiers) out += `exports${prop(alias)} = ${name};`;
			return out;
		}

		// export default …
		if (node.default) {
			const name = node.names[0];
			// export default function f() {} / class C {}：声明留着，语句后面补一句
			if (name) {
				append(`\nexports.default = ${name};`);
				return '';
			}
			// export default 42 / function () {}：直接把值赋过去
			return 'exports.default = ';
		}

		const decl = node.declaration;

		if (node.uncertain) throw new ESMParseError('不支持的语法', code, node.start);

		if (decl === 'var' || decl === 'let' || decl === 'const') {
			append('\n' + node.names.map(name => decl === 'const'
				? `exports${prop(name)} = ${name};`
				// let / var 是活的，用 getter 读
				: `Object.defineProperty(exports, ${quote(name)}, {get: () => ${name}});`
			).join(''));
			return '';
		}

		// export function / class / async function
		const name = node.names[0];
		if (name) append(`\nexports${prop(name)} = ${name};`);
		return '';
	};

	code = normalizeLineTerminator(code);
	for (const node of parseModule(code)) {
		switch (node.type) {
			case 'import':
				edits.push({start: node.start, end: node.end, text: transformImport(node)});
			break;
			case 'export':
				edits.push({start: node.start, end: node.end, text: transformExport(node)});
			break;
			case 'importMeta':
				metaUsed = 'const __meta = {url: "file:///" + __moduleId};\n';
				edits.push({start: node.start, end: node.end, text: '__meta'});
			break;
			case 'importDynamic':
				edits.push({start: node.start, end: code.indexOf('(', node.start + 6)+1, text: '_imp(__moduleId, '});
			break;
		}
	}

	let out = applyEdits(code, edits);

	if (path?.endsWith(".cjs")) out = `const module = {exports};`+out+"\n;Object.assign(exports,module.exports)";

	console.log(out);
	return `const __moduleId=${quote(path || 'inlineModule')};\n`+metaUsed+out;
}
//endregion

/**
 * 创建沙盒和RPC组件
 * @param {function('load' | 'exec' | string, any[], Transferable[]): any|Promise<any>} rpcHandler
 * @param {function(string): void} logHandler
 * @param {string} [name]
 * @returns {[Function, Function]}
 */
export function createWorker(rpcHandler, logHandler, name) {
	const worker = new SandboxWorker({name});
	const post = worker.postMessage.bind(worker);

	let rpcId = 0;
	const rpcTasks = new Map();

	/**
	 * Send a request to the Worker thread and wait for the result.
	 * @param {string} method
	 * @param {any} args
	 * @param {ArrayBuffer[]=} transfer
	 * @returns {Promise<any>}
	 */
	const RPC = (method, args, transfer) => new Promise((resolve, reject) => {
		if (destroyed) return Promise.reject(destroyed);
		const id = ++rpcId;
		rpcTasks.set(id, [resolve, reject]);
		post({id, method, args}, transfer || {});
	});

	worker.onmessage = ({data}) => {
		if ('log' in data) return logHandler(data.log);
		const exit = data.exit;
		if (exit != null) return onError(`process.exit(${exit})`);

		const id = data.id;
		const method = data.method;
		if (method) {
			const transfer = [];
			const resolve = (v) => post({id, value: v}, transfer);
			const reject = (e) => post({id, error: e});

			try {
				const result = rpcHandler(method, data.args, transfer);
				if (result instanceof Promise) result.then(resolve, reject);
				else resolve(result);
			} catch (e) {
				reject(e);
			}
		} else {
			const task = rpcTasks.get(id);
			if (!task) return;

			rpcTasks.delete(id);
			if ('error' in data) {
				task[1](data.error);
			} else {
				task[0](data.value);
			}
		}
	};

	/** @type {undefined|Error} */
	let destroyed;
	const onError = (e) => {
		destroyed = e instanceof Error ? e : new DOMException(e instanceof Event ? 'Failed to initialize sandbox' : e.message || String(e) || 'aborted', 'InternalError');
		rpcTasks.forEach((p) => p[1](destroyed));
		rpcTasks.clear();
	};
	worker.onerror = onError;

	return [
		RPC,
		(e) => {
			worker.terminate();
			onError(e||'Worker destroyed');
		}
	]
}

/**
 *
 * @param {Object} handlers - 外部可实时更新不需要重启沙盒的 handlers
 * @param {function(string, string, boolean): string|Promise<string>} handlers.load - 模块文件加载器
 * @param {function(string, any[], Transferable[]): any|Promise<any>} [handlers.rpc] - 文件系统 RPC 提供者
 * @param {function(string): void} handlers.log - 控制台打印处理程序
 * @param {string[]} permissions - 脚本权限
 * @param {string} [prefix] - 数据库允许使用的命名空间前缀
 * @param {ReadonlyMap<string, Record<string, Function>>} [hostModules] - 主机侧模块
 * @param name
 * @returns {Sandbox}
 */
export function createSandbox(
	handlers,
	permissions,
	{
		prefix,
		hostModules,
		name
	} = {}
) {

	const [RPC, destroy] = createWorker(async (method, data, transfer) => {
		if (method === 'load') {
			const [name, caller, isSystemModule, type] = data;
			const code = await handlers.load(name, caller, isSystemModule);
			return type ? code : bundleModule(name, code);
		} else if (method === 'exec') {
			const [mod, func, args] = data;
			const fn = hostModules.get(mod)?.[func];
			if (!fn) throw new DOMException('Export not found: '+mod+"::"+func);
			return fn.apply(null, args);
		}

		const rpc = handlers.rpc;
		if (rpc) return rpc(method, data, transfer);
		else throw new DOMException('RPC endpoint not found');
	}, (log) => handlers.log(log), name);

	let initialized;
	const initialize = (forceResetModuleCache, secrets) => {
		if (secrets) RPC('setSecrets', secrets);
		if (initialized) {
			if (forceResetModuleCache) return RPC('reset');
			return;
		}
		initialized = true;
		return RPC('init', [
			permissions,
			hostModules && [...hostModules.keys()],
			prefix
		]);
	};

	const loadModule = async (moduleName) => {
		const exported = new Set(await RPC('load', [
			moduleName,
			bundleModule(moduleName, await handlers.load(moduleName))
		]));

		return new Proxy(Object.create(null), {
			get(stub, name) {
				if (!exported.has(name)) return;
				return stub[name] || (stub[name] = (...args) => RPC('call', [moduleName, name, args]));
			}
		});
	};

	const execute = (moduleName, code, env, argv) => RPC('eval', [
		moduleName,
		bundleModule(moduleName, code),
		env,
		argv
	]);

	return {
		initialize,
		loadModule,
		execute,
		destroy
	};
}

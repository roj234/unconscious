import {lockdown} from "./lockdown.js";
import {normalizePath} from "../../path-utils.js";
import {emulateConsole} from "./emulated-console.js";
import {emulateFsPromises} from "./emulated-fsPromises.js";
import {emulatedPath} from "./emulated-path.js";
import Buffer from "./buffer-polyfill.js";
import process from "./emulated-process.js";
import {
	base64DecodeToString,
	base64DecodeToUint8Array,
	base64Encode,
	createBase64Decoder,
	createBase64Encoder
} from "../../Base64.js";

// ===== Helper functions =====

const postMessage = self.postMessage.bind(self);
const fun = Function;
const createObject = (o) => Object.freeze(Object.assign(Object.create(null), o));
/**
 *
 * @param {string} code
 * @param {string} [name]
 * @returns {Function}
 */
const createFunction = (code, name) => {
	let fn = codeCache.get(code);
	if (!fn) {
		try {
			codeCache.set(code, fn = fun('return async function '+(name ? name.replaceAll(/[^a-zA-Z]/g, '_') : 'unnamedModule')+"(__onload, exports){"+code+"\n};")());
		} catch (e) {
			throw new Error("Failed to load module "+name+": "+e.message);
		}
		if (codeCache.size > 200) codeCache.delete(codeCache.keys().next().value);
	}
	return fn;
};

const codeCache = new Map;
const moduleCache = new Map;

let rpcId = 0;
const rpcTasks = new Map();

/**
 * Send a request to the main thread and wait for the result.
 * @param {string} method
 * @param {any} args
 * @param {ArrayBuffer[]=} transfer
 * @returns {Promise<any>}
 */
const RPC = (method, args, transfer) => new Promise((resolve, reject) => {
	const id = ++rpcId;
	rpcTasks.set(id, [resolve, reject]);
	postMessage({id, method, args}, transfer || {});
});

const NO = () => false;

// ===== Initialization =====

const [emulatedConsole, resetFakeConsole] = emulateConsole(postMessage);
self.onunhandledrejection = (e) => emulatedConsole.error(e.reason);
Object.freeze(emulatedConsole);

const navigator1 = Object.create(null);

/** @type {Set<string>|undefined} */
let hostModules;
let nodeModules = new Map;

// ===== API =====

/**
 * 初始化沙箱并启用安全限制。
 *
 * 如果不调用初始化，那么安全限制(lockdown)将不启用！
 * @param {string[]} permissions - 允许的权限 fs wasm net db 任意
 * @param {string[]} [hm] - Host侧的异步模块名称列表
 * @param {string} [prefix] - 缓存和数据库必须的前缀
 * @returns {boolean}
 */
const init = ([permissions, hm, prefix]) => {
	if (hm) hostModules = new Set(hm);

	const removePrefix = (name) => name.startsWith(prefix) ? name.slice(prefix.length) : null;

	if (permissions.includes('fs')) {
		const emulatedProcess = process;
		const processModules = createObject( { process: emulatedProcess, default: emulatedProcess });

		const emulatedBuffer = Buffer;
		const bufferModule = createObject({ Buffer: emulatedBuffer, default: emulatedBuffer });

		const emulatedFs = emulateFsPromises(RPC);
		const fsModule = createObject({ ...emulatedFs, default: emulatedFs });

		const pathModule = createObject({ ...emulatedPath, default: emulatedPath });

		Object.freeze(emulatedBuffer);
		Object.freeze(emulatedFs)
		Object.freeze(emulatedPath);

		// buffer polyfill 依赖它，所以我就不独立打包了
		nodeModules.set('base64', createObject({
			createBase64Encoder,
			createBase64Decoder,
			base64Encode,
			base64DecodeToUint8Array,
			base64DecodeToString
		}));

		nodeModules.set('buffer', bufferModule);
		nodeModules.set('fs', fsModule);
		nodeModules.set('process', processModules);
		nodeModules.set('fs/promises', fsModule);
		nodeModules.set('path', pathModule);

		Object.assign(global, {
			fs: emulatedFs,
			path: emulatedPath,
			Buffer: emulatedBuffer,
			process: emulatedProcess
		});
	}
	if (permissions.includes('wasm')) global.WebAssembly = WebAssembly;
	if (permissions.includes('net')) {
		const _caches = caches;
		Object.assign(global, {
			caches: createObject({
				open: name => _caches.open(prefix + name),
				has: name => _caches.has(prefix + name),
				delete: name => _caches.delete(prefix + name),
				keys: async () => (await _caches.keys()).map(removePrefix).filter(Boolean),
				match: (request, options) => _caches.match(request, options),
			}),
			fetch,
			XMLHttpRequest,
			WebSocket,
			EventSource
		});
	}
	if (permissions.includes('db')) {
		const _indexedDB = indexedDB;
		global.indexedDB = createObject({
			open: (name, version) => _indexedDB.open(prefix + name, version),
			deleteDatabase: (name) => _indexedDB.deleteDatabase(prefix + name),
			databases: async () => (await _indexedDB.databases()).map(db => ({...db, name: removePrefix(db.name)})).filter(t=> t.name),
			cmp: _indexedDB.cmp.bind(_indexedDB),
		});

		const _storage = navigator.storage;
		navigator1.storage = createObject({
			getDirectory: async () => (await _storage.getDirectory()).getDirectoryHandle(prefix, {create: true}),
			estimate: _storage.estimate.bind(_storage),
			persist: _storage.persist.bind(_storage)
		});
	}

	lockdown(global);
	return true;
};

let timerStart = 0;
const onload = (module, callback) => moduleCache.get(module)?.then?.(callback);

/**
 * 执行代码
 * @param {string|undefined} path - 模块名称(可选)
 * @param {string} code - 转换后的模块代码
 * @param {Object|undefined} context - 运行时的 this 上下文
 * @returns {*}
 */
const _eval = async ([path, code, context]) => {
	const fn = createFunction(code);
	try {
		const promise = fn.call(context, onload, {});
		if (path) moduleCache.set(path, promise);
		return await promise;
	} finally {
		resetFakeConsole();

		const timerEnd = setTimeout(() => {});
		for (; timerStart < timerEnd; timerStart++) clearTimeout(timerStart);
	}
};

const loadModule = async (path, code) => {
	const fn = createFunction(code, path);
	const exports = Object.create(null);
	moduleCache.set(path, exports);
	await fn(onload, exports);
	if (!('default' in exports)) exports.default = createObject(exports);
	Object.freeze(exports);
	return exports;
};

/**
 * 注册模块, 并返回它的导出函数名称
 * @param {string} path - 模块名称
 * @param {string} code - 模块代码
 * @returns {string[]}
 */
const load = async ([path, code]) => Object.keys(await loadModule(path, code));

/**
 * 执行模块函数
 * @param {string} path  - 模块名称
 * @param {string} func  - 导出名称
 * @param {any[]} [args] - 参数
 * @returns {*}
 */
const call = async ([path, func, args = []]) => {
	const mod = await moduleCache.get(path);
	const fn = mod[func];
	if (typeof fn !== 'function')
		throw new Error('Export not found: '+path+"::"+func);
	return await fn(...args);
};

const systemFunctions = {init, call, load, eval: _eval};

self.onmessage = async (e) => {
	const data = e.data;
	const id = data.id;
	const method = data.method;
	if (method) {
		try {
			const result = await systemFunctions[method](data.args);
			postMessage({id, value: result});
		} catch (e) {
			postMessage({id, error: e});
		}
	} else {
		const pending = rpcTasks.get(id);
		if (pending) {
			rpcTasks.delete(id);
			const error = data.error;
			if (error) {
				pending[1](error);
			} else {
				pending[0](data.value);
			}
		}
	}
};

const resolvePath = (name, path) => {
	if (name[0] === '/') {
		name = normalizePath(name).join('/');
	} else if (name[0] === '.') {
		const idx = !path ? -1 : path.lastIndexOf('/');
		const pathname = idx < 0 ? '' : path.slice(0, idx);
		name = normalizePath(pathname + '/' + name).join('/');
		if (path == null) emulatedConsole.warn("Relative imports in inline code,", name);
	}
	return name;
};

const createHostModule = name => {
	const stub = Object.create(null);
	const handler = {
		get(stub, func, proxy) {
			if (func === 'then') return proxy === resolved ? undefined : (resolve) => resolve(resolved);
			return stub[func] || (stub[func] = (...args) => RPC('exec', [name, func, args]));
		},
		set: NO
	};
	const resolved = new Proxy(stub, handler);
	const fakePromise = new Proxy(stub, handler);
	moduleCache.set(name, fakePromise);
	return fakePromise;
};

const global = {
	Request,
	Response,
	performance,
	console: emulatedConsole,
	navigator: navigator1,
	require(owner, name, attributes) {
		if (typeof name !== 'string') throw new Error('Illegal argument');
		if (name.startsWith("data:")) throw new Error('\"data:\" is not allowed');

		let type = attributes?.with?.type;

		let isSystemModule = name[0] !== '.' && name[0] !== '/';
		if (isSystemModule) {
			if (type) throw new Error('System module cannot use type assertion');

			let prefix = name.startsWith('node:') ? 5 : 0;
			const nodeModule = nodeModules.get(name.slice(prefix));
			if (nodeModule) return nodeModule;

			const cache = moduleCache.get(name);
			if (cache) return cache;
		}

		if (hostModules?.has(name)) return createHostModule(name);

		if (!type && name.endsWith(".json")) type = 'json';

		const absolutePath = resolvePath(name, owner);
		let cacheKey = absolutePath;
		if (type) cacheKey+="::"+type;
		let cache = moduleCache.get(cacheKey);
		if (!cache) {
			cache = RPC('load', [absolutePath, type, isSystemModule]).then((code) => {
				if (type === 'text') return { default: code };
				if (type === 'json') return { default: JSON.parse(code) };
				return loadModule(absolutePath, code);
			});
			moduleCache.set(cacheKey, cache);
		}

		return cache;
	}
};

const unlockedSelf = self;
const globalKeys = new Set(Object.keys(unlockedSelf));

// TODO WorkerGlobalScope 其实没啥东西，不Hook也行？
global.globalThis = global.self = new Proxy(Object.create(null), {
	get(target, key) {
		return key in target ? target[key] : unlockedSelf[key];
	},
	set(target, p, newValue, receiver) {
		// 禁止修改全局作用域存在的变量
		if (globalKeys.has(p)) target[p] = newValue;
		else unlockedSelf[p] = newValue;
		return true;
	}
});

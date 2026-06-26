import {lockdown} from "./lockdown.js";

// 在lockdown之前保留所有需要的全局对象
const Proxy1 = Proxy;
const Promise1 = Promise;
const postMessage1 = postMessage;
const Error1 = Error;
const String1 = String;
const startsWith1 = String1.prototype.startsWith;

const [hostModules, namespace, permissions] = [AA];
const modules = new Map();
const rpcTasks = new Map();
let rpcId = 0;

self.onmessage = ({data}) => {
	const id = data.id;
	if (data.func) {
		const resolve = (v) => postMessage1({id, value: v});
		const reject = (e) => postMessage1({id, error: String1(e?.message||e)});

		const fn = BB[data.func];
		if (!fn) {
			reject("Export not found: "+data.name);
			return;
		}

		try {
			const result = fn.apply(global, data.args);
			if (result instanceof Promise1) result.then(resolve, reject);
			else resolve(result);
		} catch (e) {
			reject(e);
		}
	} else {
		const task = rpcTasks.get(id);
		rpcTasks.delete(id);
		if ('error' in data) {
			task[1](new Error1(data.error));
		} else {
			task[0](data.value);
		}
	}
};

const NO = () => false;
const navigator1 = {};
const global = {
	postMessage: postMessage1,
	navigator: navigator1,
	require(mod) {
		const module = modules.get(mod);
		if (module) return module;
		if (hostModules.has(mod)) {
			const proxy = new Proxy1({}, {
				get(stub, name, proxy) {
					if (name === 'then') return (resolve) => resolve(proxy);

					return stub[name] || (stub[name] = (...args) => new Promise1((resolve, reject) => {
						rpcTasks.set(++rpcId, [resolve, reject]);
						postMessage1({id: rpcId, module: mod, func: name, args});
					}));
				},
				set: NO,
				deleteProperty: NO
			});
			modules.set(mod, proxy);
			return proxy;
		}

		throw new Error1("Module not found: " + mod);
	}
};

const namespaceFilter = (orig) => (ns, ...args) => {
	if (!startsWith1.call(ns, namespace)) throw new Error1("name must startsWith "+namespace);
	orig(ns, ...args);
};
const createFilter = (original, keys) => {
	const proto = original.__proto__;
	const copy = {};
	for (const k of keys)
		copy[k] = namespaceFilter(proto[k].bind(original));
	return copy;
};

if (permissions.has('wasm')) global.WebAssembly = WebAssembly;
if (permissions.has('net')) Object.assign(global, {
	caches: createFilter(caches, ["open","delete","has"]),
	fetch,
	XMLHttpRequest,
	importScripts,
	Request,
	Response,
	WebSocket,
	EventSource
});

if (permissions.has('storage')) {
	const idb = indexedDB;
	const flt = createFilter(idb, ["open","deleteDatabase"]);
	flt.cmp = idb.cmp;

	Object.assign(global, {indexedDB: flt});
	navigator1.storage = navigator.storage;
}

lockdown(global.globalThis = global);

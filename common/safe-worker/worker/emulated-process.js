
const _listeners = new Map();

const _on = (ev, fn) => {
	if (!_listeners.has(ev)) _listeners.set(ev, new Set());
	_listeners.get(ev).add(fn);
	return process;
};
const _off = (ev, fn) => {
	_listeners.get(ev)?.delete(fn);
	return process;
};
const _emit = (ev, ...args) => {
	_listeners.get(ev)?.forEach((fn) => fn(...args));
	return true;
};
const _removeAllListeners = ev => {
	if (ev === undefined) _listeners.clear();
	else _listeners.delete(ev);
	return process;
};

const _env = Object.create(null);
_env.NODE_ENV = "production";
_env.BROWSER = "true";

// --- The polyfill ---

const process = {
	// ---------- versions ----------
	version: "v22.0.0", // pretend Node version, widely used for feature detection
	versions: { node: "22.0.0", },
	release: { name: 'node', },

	// ---------- env ----------
	env: _env,

	// ---------- argv ----------
	argv: ["node"],
	argv0: "node",

	// ---------- platform / arch ----------
	platform: self.navigator?.platform || "linux",
	arch: "x64",

	// ---------- pid / title ----------
	pid: 1,
	title: "WebWorker",

	// ---------- cwd ----------
	cwd() {
		return "./";
	},

	// ---------- exit ----------
	exit(code = 0) {
		console.warn(`process.exit(${code})`);
		close();
	},

	// ---------- nextTick (microtask) ----------
	nextTick(fn, ...args) {
		if (args.length) {
			queueMicrotask(() => fn(...args));
		} else {
			queueMicrotask(fn);
		}
		return this;
	},

	// ---------- stdout / stderr ----------
	// Minimal console-based write, useful for build tools that capture stdout
	stdout: {
		write(str) {
			console.log(str);
			return true;
		},
		isTTY: false,
	},
	stderr: {
		write(str) {
			console.error(str);
			return true;
		},
		isTTY: false,
	},
	stdin: { isTTY: false },

	// ---------- uptime ----------
	uptime() {
		return (
			(typeof performance !== "undefined"
				? performance.now()
				: Date.now()) / 1000
		);
	},

	// ---------- hrtime ----------
	hrtime(time) {
		const now =
			typeof performance !== "undefined" ? performance.now() : Date.now();
		const ms = Math.floor(now);
		const ns = Math.floor((now - ms) * 1e6);
		const secs = Math.floor(ms / 1000);
		const remainder = ms % 1000;
		const totalSecs = secs + remainder / 1000 + ns / 1e9;
		if (time !== undefined) {
			const diff = totalSecs - time[0] - time[1] / 1e9;
			return [Math.floor(diff), Math.floor((diff - Math.floor(diff)) * 1e9)];
		}
		return [secs, remainder * 1e6 + ns];
	},

	// ---------- memoryUsage ----------
	memoryUsage() {
		if (typeof performance !== "undefined" && performance.memory) {
			const m = performance.memory;
			return {
				rss: m.totalJSHeapSize,
				heapTotal: m.totalJSHeapSize,
				heapUsed: m.usedJSHeapSize,
				external: 0,
				arrayBuffers: 0,
			};
		}
		return { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
	},

	// ---------- EventEmitter subset ----------
	on: _on,
	addListener: _on,
	off: _off,
	removeListener: _off,
	emit: _emit,
	removeAllListeners: _removeAllListeners,
	listeners(ev) {
		return Array.from(_listeners.get(ev) || []);
	},

	// ---------- misc ----------
	browser: true,
	debugPort: 0,
	features: {},
	config: {},

	__polyfilled: true,
};

export default process;

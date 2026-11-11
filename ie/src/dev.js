import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import * as esbuild from 'esbuild';
import {applyEdits, isIdentifierName, parseModule} from '@roj234/esm-parser';
import {fileURLToPath} from 'node:url';
import {createPluginContainer, resolveConfig, toPosix} from './config.js';
import {createResolver} from './resolve.js';
import {processCss} from './css.js';
import {applyHtmlTransforms, attr, transformTags} from './html.js';
import {WebSocketServer} from "@roj234/ws";
import {formatError} from './errors.js';
import * as U from './utils.js';
import {hash} from './utils.js';
import {normalizePath} from "./plugin.js";
import {safeStat, serveFile} from "../utils/serveFile.js";
import {getContentType} from "../utils/mimeTypes.js";
import {watch} from 'chokidar';
import picomatch from "picomatch";
import {normalizeLineTerminator} from "@roj234/shared/strings";

// 这两个值的定义必须和 client.js 相同
const HMR_PROTOCOL = 'hmr';
const HMR_PATH = '/@ie/client';
const HMR_FILE = fileURLToPath(new URL('./client.js', import.meta.url));


/**
 * @param {import('node:http').Server} httpServer
 * @param {ie.Logger} [log]
 */
function createWebSocket(httpServer, log) {
	const clients = new Set();
	const add = (ws) => {
		const client = {send: json => ws.send(json), close: () => ws.close(), ws};
		clients.add(client);
		return client;
	};

	const wss = new WebSocketServer({noServer: true, protocols: [HMR_PROTOCOL], maxPayload: 655360});
	httpServer.on('upgrade', (req, socket, head) => {
		const pathname = (req.url || '').split('?')[0];
		if (pathname !== HMR_PATH) return;

		try {
			wss.handleUpgrade(req, socket, head, ws => {
				const client = add(ws);
				ws.on('close', () => clients.delete(client));
				ws.on('message', (message) => {
					if (typeof message === 'string') {
						try {
							const payload = JSON.parse(message);
							if (payload.type === 'custom') {
								console.log("自定义事件尚未实现", payload);
							}
						} catch (e) {
							ws.close();
						}
					}
				});
			});
		} catch (error) {
			log?.warn(`websocket 握手失败: ${error?.message || error}`);
			socket.destroy();
		}
	});

	return {
		available: true,
		clients,
		send(payload) {
			const json = JSON.stringify(payload);
			for (const client of clients) client.send(json);
		},
		close() {
			for (const client of clients) client.close();
			clients.clear();
			wss.close();
		},
	};
}

/**
 *
 * @param {string} root
 * @param {ie.Config} config
 * @param {ie.Logger} log
 * @param {Function} onFileChange
 * @return {Promise<{add(string): void, close(): Promise<void>, on()}>}
 */
async function createWatcher(root, config, log, onFileChange) {
	const ignore = picomatch(['node_modules', '.*', config.build.outDir || 'dist', ...config.server.watch.ignored]);

	let timer = null;
	const fire = file => {
		clearTimeout(timer);
		timer = setTimeout(() => onFileChange(file).catch(e => log.error(e)), 40);
	};

	const closers = [];
	const externalRoots = new Set();

	const bind = (watcher, base) => {
		const onChange = f => {
			const abs = path.resolve(base, String(f));
			if (!ignore(U.toPosix(path.relative(base, abs)))) fire(abs);
		};
		watcher.on('change', onChange);
		watcher.on('add', onChange);
		return watcher;
	};

	const rootWatcher = bind(watch(root, {ignoreInitial: true}), root);

	// monorepo：root 之外的模块（../unconscious 之类）也要监听
	const addExternal = dir => {
		if (dir.startsWith(root + path.sep) || externalRoots.has(dir)) return;
		externalRoots.add(dir);
		closers.push(bind(watch(dir, {ignoreInitial: true}), dir));
	};

	return {
		add: addExternal,
		async close() {
			await rootWatcher.close?.();
			for (const c of closers) {
				try {
					await c.close?.()
				} catch {}
			}
		},
		on() {
		}, // 兼容 watcher 的最小接口
	};
}

function moduleUrl(id, root) {
	const p = U.toPosix(id);
	const r = U.toPosix(root);
	const url = p === r ? '/' : p.startsWith(r + '/') ? '/' + p.slice(r.length + 1) : '/@fs/' + p;
	return encodeURI(url);
}

/**
 * @param {string} name
 * @returns {string}
 */
const quoteIdent = name => isIdentifierName(name) ? name : JSON.stringify(name);

/** `{a, b as c}` */
const printSpecifiers = specs => '{' + specs.map(({name, alias}) =>
	name === alias ? quoteIdent(name) : `${quoteIdent(name)} as ${quoteIdent(alias)}`).join(', ') + '}';

/** ` with {type: 'json'}` / ` assert {…}`，没有就是空串 */
const printAttribute = ({keyword, entries} = {}) => keyword === undefined ? ''
	: ` ${keyword} {${Object.entries(entries).map(([key, value]) => `${quoteIdent(key)}: ${JSON.stringify(value)}`).join(', ')}}`;

/**
 * 把一条 import / export 语句重新拼出来，
 * @param {ModuleNode} node
 * @param {string} [source] 新说明符，默认沿用节点里原来的
 * @returns {ReplaceSegment|null}
 */
function rewriteSource(node, source = node.source) {
	const tail = JSON.stringify(source);

	if (node.type === 'importDynamic') {
		return {start: node.start, end: node.sourceEnd, text: `import(${tail}`};
	}

	const attribute = printAttribute(node.attribute);

	if (node.type === 'import') {
		let bindings = node.default;
		if (node.namespace !== undefined) {
			const ns = `* as ${quoteIdent(node.namespace)}`;
			bindings = bindings === undefined ? ns : `${bindings}, ${ns}`;
		} else if (node.specifiers !== undefined) {
			const specs = printSpecifiers(node.specifiers);
			bindings = bindings === undefined ? specs : `${bindings}, ${specs}`;
		}
		const head = bindings === undefined ? '' : bindings + ' from ';
		return {start: node.start, end: node.end, text: `import ${head}${tail}${attribute};`};
	}

	if (node.type !== 'export' || node.source === undefined) return null;

	const exported = node.namespace !== undefined ? `* as ${quoteIdent(node.namespace)}`
		: node.specifiers !== undefined ? printSpecifiers(node.specifiers)
			: '*';
	return {
		start: node.start,
		end: node.statementEnd ?? node.end,
		text: `export ${exported} from ${tail}${attribute};`,
	};
}

export async function createServer(options = {}) {
	const startTime = Date.now();

	const config = await resolveConfig({...options, command: 'serve'});
	const root = config.root;
	const log = U.createLogger('ie');
	const resolver = createResolver(config);
	const container = createPluginContainer(config.plugins, config);
	const graph = new Map();
	const codeCache = new Map();
	const middlewares = [];

	const broadcast = payload => wss.send(payload);
	let wss;

	const server = {
		config,
		log,
		resolver,
		graph,
		middlewares: {use: fn => middlewares.push(fn)},
		get ws() {
			return {
				send: broadcast,
				clients: wss.clients,
				transport: 'ws',
				available: wss.available,
				close: () => wss.close(),
			};
		},
		moduleGraph: {getModuleById: id => graph.get(id), modules: graph},
		httpServer: null,
		watcher: null,
		/*async transformRequest(url) {
			const file = getFileFromUrl(url);
			return {code: await transformModule(file, U.splitQuery(url)[1])};
		},*/
		async close() {
			wss.close();
			await new Promise(r => httpServer.close(r));
			await server.watcher?.close?.();
		},
		async restart() {
			/* 配置变更后重启交给 CLI 重新拉起 */
		},
	};

	function getModule(id) {
		let m = graph.get(id);
		if (!m) {
			m = {id, url: moduleUrl(id, root), importers: new Set(), importedModules: new Set(), accepted: false};
			graph.set(id, m);
		}
		return m;
	}

	const watchedExternal = new Set();

	function watchExternal(fileId) {
		let dir = path.dirname(fileId);
		if (watchedExternal.has(dir)) return;
		watchedExternal.add(dir);
		for (let i = 0; i < 16; i++) {
			if (fs.existsSync(path.join(dir, 'package.json'))) {
				server.watcher?.add?.(dir);
				return;
			}
			const parent = path.dirname(dir);
			if (parent === dir) return;
			dir = parent;
		}
	}

	// ---------- 模块管线 ----------
	function definePrelude() {
		const env = {
			DEV: config.mode === 'development',
			PROD: config.mode !== 'development',
			MODE: config.mode,
			BASE_URL: config.base || '/'
		};
		const parts = [`import.meta.env = ${JSON.stringify(env)};`];
		for (const [key, value] of Object.entries(config.define || {})) {
			if (/^[A-Za-z_$][\w$]*$/.test(key)) parts.push(`const ${key} = (${value});`);
		}
		return parts.join(' ') + '\n';
	}

	/** 把模块里的 import / export / import() 说明符换成浏览器能取的 URL，顺手补模块图 */
	function rewriteImports(code, fileId, params) {
		const mod = getModule(fileId);
		const pageOpenTime = parseInt(params.pv);
		const where = U.toPosix(path.relative(root, fileId));

		const deps = [];
		const edits = [];

		code = normalizeLineTerminator(code);
		for (const node of parseModule(code)) {
			const raw = node.source;
			if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;

			const resolved = resolver.resolveId(raw, fileId);
			if (!resolved) {
				log.warn(`无法解析 "${raw}" (来自 ${where})`);
				continue;
			}
			if (resolved.external) continue;

			let url = moduleUrl(resolved.id, root);
			if (resolved.query) url += '?' + resolved.query;
			else {
				const ext = path.extname(resolved.id).toLowerCase();
				if (ext === '.json') url += '?import';
				else if (ext && !U.isJsFile(resolved.id) && ext !== '.css') url += '?url';
			}

			const mtimeMs = fs.statSync(resolved.id).mtimeMs;
			if (mtimeMs > pageOpenTime) url = U.withQuery(url, 't', mtimeMs);

			if (url !== raw) {
				const edit = rewriteSource(node, url);
				if (edit) edits.push(edit);
				else log.warn(`改不了 "${raw}" 的说明符 (来自 ${where})`);
			}

			const dep = getModule(resolved.id);
			if (!deps.includes(dep)) deps.push(dep);
		}

		for (const dep of mod.importedModules) if (!deps.includes(dep)) dep.importers.delete(mod);
		for (const dep of deps) dep.importers.add(mod);
		mod.importedModules = new Set(deps);

		return applyEdits(code, edits);
	}

	async function transformJs(file, fileId, query, params) {
		const mod = getModule(fileId);

		// root 之外的模块也要加入监听
		if (!fileId.startsWith(U.toPosix(root) + '/')) watchExternal(fileId);

		let code = await container.load(fileId);
		if (code == null) code = await fsp.readFile(file, 'utf8');
		code = await container.transform(code, fileId);
		// unconscious 只做 jsx / 响应式转换，类型标注还要交给 esbuild（和 vite 一样）
		if (/\.tsx?$/.test(file)) {
			const result = await esbuild.transform(code, {
				loader: /\.tsx$/.test(file) ? 'tsx' : 'ts',
				format: 'esm',
				target: 'esnext',
				sourcefile: file,
				legalComments: 'inline',
			});
			code = result.code;
		}
		mod.accepted = code.includes('import.meta.hot.accept(');

		if (code.includes('import.meta.env') || Object.keys(config.define || {}).length) code = definePrelude() + code;
		code = rewriteImports(code, fileId, params);

		if (code.includes('import.meta.hot')) {
			code = `import {createHotContext as __ie_createHotContext} from ${JSON.stringify(HMR_PATH)};\n`
				+ `import.meta.hot = __ie_createHotContext(${JSON.stringify(mod.url)});\n` + code;
		}
		return code;
	}

	function cssModule(file) {
		const url = moduleUrl(file, root);
		const href = url + (url.includes('?') ? '&' : '?') + 'direct';
		return `const href = ${JSON.stringify(href)};

let r;
const p = new Promise(resolve => r = resolve);

const link = document.createElement('link');
link.rel = 'stylesheet';
link.href = href;
link.onload = r;
document.head.appendChild(link);

await p;
`;
	}

	async function transformModule(file, query, params) {
		const fileId = U.toPosix(file);
		getModule(fileId);

		let code;
		if ('raw' in params) {
			code = `export default ${JSON.stringify(await fsp.readFile(file, 'utf8'))}`;
		} else if ('worker' in params) {
			const url = moduleUrl(file, root);
			code = `export default class extends Worker { constructor(options) { super(${JSON.stringify(url)}, Object.assign({type:'module'}, options)) } }`;
		} else {
			const ext = path.extname(file).toLowerCase();
			if (ext === '.css') { code = cssModule(file); }
			else if (ext === '.json') code = `export default ${await fsp.readFile(file, 'utf8')}`;
			else if (!U.isJsFile(file)) code = `export default ${JSON.stringify(moduleUrl(file, root))}`;
			else code = await transformJs(file, fileId, query, params);
		}
		return code;
	}

	async function transformHTML(file) {
		let html = await fsp.readFile(file, 'utf8');
		html = await applyHtmlTransforms(config.plugins, html, {
			filename: file,
			path: moduleUrl(file, root),
			server
		});
		html = transformTags(html, (name, attrs) => {
			if (name !== 'link') return null;
			if ((attr(attrs, 'rel') || '').toLowerCase() !== 'stylesheet') return null;
			const href = attr(attrs, 'href');
			if (!href) return null;

			const rel = new URL(href, "http://0.0.0.0"+moduleUrl(file, root));
			getModule(toPosix(path.join(root, decodeURIComponent(rel.pathname.slice(1)))));

			const next = href + (href.includes('?') ? '&' : '?') + 'direct';
			return `<link${attrs.replace(href, () => next)}>`;
		});
		return html.replace(/<head([^>]*)>/i, m => `${m}\n<script type="module" src="${HMR_PATH}"></script>`);
	}

	async function handleRequest(req, res) {
		const url = new URL(req.url, `http://${req.headers.host}`);
		const pathname = decodeURIComponent(url.pathname);
		const params = Object.fromEntries(url.searchParams);

		let file;
		if (pathname === HMR_PATH) {
			const stat = await safeStat(HMR_FILE);
			await serveFile({ req, res }, {
				type: getContentType(HMR_FILE),
				lastModified: stat.mtimeMs,
				size: stat.size,
				volatile: true,
			}, HMR_FILE);
			return;
		}

		if (pathname.startsWith('/@fs/')) {
			file = normalizePath(pathname.slice(5));
			// 最简单的安全检查以避免路径遍历
			/*if (!file.includes("/node_modules/")) {
				return U.sendText(res, 404, 'Not Found');
			}*/
		} else {
			file = path.join(root, pathname);
		}

		let stat = await safeStat(file);
		if (stat.isDirectory()) {
			file = path.join(file, 'index.html');
			stat = await safeStat(file);
		}
		if (!stat.isFile() && config.publicDir) {
			const pub = path.join(config.publicDir, pathname);
			stat = await safeStat(pub);
			if (stat.isFile()) file = pub;
		}

		// SPA 模式
		if (config.pathRouter && !stat.isFile()) {
			file = path.join(root, 'index.html');
			stat = await safeStat(file);
		}

		if (!stat.isFile()) {
			U.sendText(res, 404, 'Not Found');
			return;
		}

		const lastModified = 't' in params ? parseInt(params.t, 10) : stat.mtimeMs;

		const sendCached = async (callback, type, noCache) => {
			const cacheKey = 't' in params ? null : file+url.search;
			const cached = codeCache.get(cacheKey);
			let code;
			if (cached?.mtime === lastModified) {
				code = cached.code;
			} else {
				code = await callback();
				if (cacheKey) codeCache.set(cacheKey, { mtime: lastModified, code });
			}

			const tag = hash(code);
			const expect = req.headers['if-none-match'];
			if (expect === tag) {
				res.writeHead(304, {'Cache-Control': 'no-cache', 'ETag': tag});
				res.end();
				return;
			}

			res.writeHead(200, {
				// 用 &t 的全是避免重刷的临时文件，根本不需要缓存
				'Cache-Control': cacheKey == null ? 'no-store' : 'no-cache',
				'Content-Type': type,
				'Content-Length': Buffer.byteLength(code),
				'ETag': tag
			});
			res.end(code);
		};

		const ext = path.extname(file).toLowerCase();
		if (ext === '.html') {
			return sendCached( () => transformHTML(file), 'text/html; charset=utf-8');
		}

		if (ext === '.css' || url.searchParams.size || U.isJsFile(file)) {
			if (ext === '.css' && 'direct' in params) {
				return sendCached(async () => processCss(await fsp.readFile(file, 'utf8'), file, {config, root}), 'text/css; charset=utf-8');
			}

			return sendCached(() => transformModule(file, url.search.slice(1), params), 'application/javascript; charset=utf-8');
		}

		await serveFile({ req, res }, {
			type: getContentType(file),
			lastModified: stat.mtimeMs,
			size: stat.size,
			volatile: true,
		}, file);
	}

	// ---------- HMR ----------
	// TODO 合并这里和 unconscious HMR 的模块图处理
	function findBoundaries(mod, seen = new Set(), chain = [mod.id]) {
		if (seen.has(mod)) return {list: [], deadEnd: true};
		seen.add(mod);
		if (mod.accepted) return {list: [{boundary: mod, chain}], deadEnd: false};
		if (!mod.importers.size) return {list: [], deadEnd: true};
		const list = [];
		let deadEnd = false;
		for (const importer of mod.importers) {

			const r = findBoundaries(importer, seen, [importer.id, ...chain]);
			if (r.deadEnd) return r;

			list.push(...r.list);
		}
		return {list, deadEnd};
	}

	async function onFileChange(file) {
		const fileId = U.toPosix(file);
		const timestamp = Date.now();
		const mod = graph.get(fileId);
		if (!mod) return;

		const affected = [mod, ...mod.importers];
		// 先算边界，invalidate 会拆掉 importer 关系
		const {list, deadEnd} = findBoundaries(mod);

		for (const plugin of config.plugins) {
			if (!plugin.handleHotUpdate) continue;
			try {
				await plugin.handleHotUpdate({file: fileId, timestamp, modules: affected, server, type: 'update'});
			} catch (e) {
				log.warn(`${plugin.name}: ${e?.message || e}`)
			}
		}

		const isCss = file.endsWith('.css');

		for (const key of codeCache.keys()) {
			if (key === fileId || key.startsWith(fileId + '?')) codeCache.delete(key);
		}

		if (isCss && mod) return broadcast({type: 'css-update', updates: [{path: mod.url, timestamp}]});
		if (!mod || !list.length || deadEnd) return broadcast({type: 'full-reload'});

		broadcast({
			type: 'update',
			updates: list.map(({boundary, chain}) => ({
				path: mod.url,
				acceptedPath: boundary.url,
				chain,
				timestamp,
			})),
		});
	}

	// ---------- 初始化 ----------
	const httpServer = http.createServer(function (req, res) {
		let i = 0;

		const fail = error => {
			const url = new URL(req.url, `http://${req.headers.host}`);
			const pathname = decodeURIComponent(url.pathname);

			let file = pathname.startsWith('/@fs/') ? normalizePath(pathname.slice(5)) : path.join(root, pathname);

			const info = formatError(error, {root, id: U.isFile(file) ? file : ''});
			log.error(`${info.id ? info.id + (info.loc ? `:${info.loc.line}:${info.loc.column}` : '') + ' ' : ''}${info.message}`);
			if (info.frame) console.error(info.frame);

			wss.send({type: 'error', err: info, module: pathname.slice(1)});

			if (res.headersSent || res.writableEnded) return res.end();

			U.sendText(res, 500, `<!DOCTYPE html><html><head><meta charset="utf-8"><title>系统错误</title><style>:root{ color-scheme: light dark; }</style><script data-error-url="${url.pathname}" type="module" src="${HMR_PATH}"></script></html>`, 'text/html; charset=utf-8');
		};

		const next = err => {
			if (err) return fail(err);
			const fn = middlewares[i++];
			if (!fn) return U.sendText(res, 404, 'Not Found');
			try {
				const r = fn(req, res, next);
				if (r && typeof r.then === 'function') r.catch(fail);
			} catch (e) {
				fail(e)
			}
		};
		next();
	});
	server.httpServer = httpServer;
	httpServer.on('error', e => log.error(e.message));
	wss = createWebSocket(httpServer, log);

	for (const plugin of config.plugins) {
		await plugin.configureServer?.(server);
	}
	middlewares.push(handleRequest);

	const port = options.port ?? config.server.port ?? 5173;
	const host = options.host ?? config.server.host ?? 'localhost';
	await new Promise((resolve, reject) => {
		httpServer.once('error', reject);
		httpServer.listen(port, host === 'localhost' ? '127.0.0.1' : host, resolve);
	});

	server.watcher = await createWatcher(root, config, log, onFileChange);
	const address = httpServer.address();
	log.info(`ready ${Date.now() - startTime}ms http://${host}:${address.port}/`);
	return server;
}

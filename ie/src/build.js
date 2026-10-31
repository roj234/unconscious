import fsp from 'node:fs/promises';
import path from 'node:path';
import {gzip} from 'node:zlib';
import {rollup} from 'rollup';
import * as esbuild from 'esbuild';
import {resolveConfig} from './config.js';
import {createResolver} from './resolve.js';
import {processCss} from './css.js';
import {createPreloadPlugin} from './modulePreload.js';
import {applyHtmlTransforms, attr, hasAttr, transformTags} from './html.js';
import * as U from './utils.js';
import {colors} from "../utils/consoleColor.js";
import {safeStat} from "../utils/serveFile.js";
import {getContentType} from "../utils/mimeTypes.js";

const CSS_DIR = 'assets';

export async function build(options = {}) {
	const config = await resolveConfig({...options, command: 'build'});
	const root = config.root;
	const log = U.createLogger('ie');
	const outDir = path.resolve(root, config.build.outDir || 'dist');
	const base = config.base ?? '/';
	const resolver = createResolver(config);

	const href = fileName => {
		if (base && base !== '' && base !== './') return (base.endsWith('/') ? base : base + '/') + fileName;
		return './' + fileName;
	};

	// ────────── 入口 & HTML 扫描 ──────────
	const rollupInput = {};
	const docs = [];
	const usedNames = new Set();
	const uniq = (name) => {
		let n = name || 'chunk';
		let i = 2;
		while (usedNames.has(n)) n = `${name}${i++}`;
		usedNames.add(n);
		return n;
	};

	const inputOption = config.build.rollupOptions.input;
	const inputMap = new Map();
	if (typeof inputOption === 'string') inputMap.set('index', path.resolve(root, inputOption));
	else if (Array.isArray(inputOption)) for (const f of inputOption) inputMap.set(path.basename(f).replace(/\.[^.]+$/, ''), path.resolve(root, f));
	else if (inputOption) for (const [k, v] of Object.entries(inputOption)) inputMap.set(k, path.resolve(root, v));
	else inputMap.set('index', path.resolve(root, 'index.html'));

	for (const [name, file] of inputMap) {
		if (!file.endsWith('.html')) {
			rollupInput[uniq(name)] = file;
			continue;
		}
		const html = await fsp.readFile(file, 'utf8');
		const doc = {name, file, dir: path.dirname(file), html, scripts: [], styles: [], assets: []};
		transformTags(html, (tag, attrs) => {
			if (tag === 'script') {
				const src = attr(attrs, 'src');
				const type = attr(attrs, 'type');
				if (!src || (type && type !== 'module')) return null;
				const abs = path.resolve(doc.dir, src.split(/[?#]/)[0]);
				if (!U.isFile(abs)) return null;
				const scriptName = uniq(path.basename(abs).replace(/\.[^.]+$/, ''));
				rollupInput[scriptName] = abs;
				doc.scripts.push({
					src,
					abs,
					name: scriptName,
					async: hasAttr(attrs, 'async'),
					defer: hasAttr(attrs, 'defer')
				});
			} else {
				const url = attr(attrs, 'href');
				if (!url || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url)) return null;
				const abs = path.resolve(doc.dir, url.split(/[?#]/)[0]);
				if (!U.isFile(abs)) return null;
				if ((attr(attrs, 'rel') || '').toLowerCase() === 'stylesheet') doc.styles.push({href: url, abs});
				else doc.assets.push({href: url, abs, attrName: 'href'});
			}
			return null;
		});
		docs.push(doc);
	}

	// ────────── 构建上下文 ──────────
	const ctx = {
		config,
		root,
		css: new Map(),          // 模块 id -> 处理后的 css
		assetRefs: new Map(),    // 缓存键 -> refId
		assetSource: new Map(),  // refId -> 源文件
		assetNames: new Map(),   // refId -> 产物路径
		emitAsset(pluginCtx, file, source, name) {
			const cacheKey = U.toPosix(file) + '|' + (name || '');
			const cached = ctx.assetRefs.get(cacheKey);
			// 注意结尾的 "__;"：rollup 的 refId 里可能出现下划线，必须有明确的分隔符
			if (cached) return `__IE_ASSET__${cached}__;`;
			const ref = pluginCtx.emitFile({type: 'asset', name: name || path.basename(file), source});
			ctx.assetRefs.set(cacheKey, ref);
			ctx.assetSource.set(ref, file);
			return `__IE_ASSET__${ref}__;`;
		},
	};
	ctx.assetUrl = ctx.emitAsset;

	const placeholders = (text, fromFile, mode) => String(text).replace(/__IE_ASSET__(.*?)__;/g, (_, ref) => {
		const fileName = ctx.assetNames.get(ref);
		if (!fileName) return '';
		if (mode === 'css') {
			const r = path.posix.relative(path.posix.dirname(fromFile), fileName);
			return r.startsWith('.') ? r : './' + r;
		}
		return href(fileName);
	});

	const esbuildOptions = {
		format: 'esm',
		target: config.build.target || 'esnext',
		charset: 'utf8',
		define: {
			...config.define,
			'import.meta.env.DEV': String(config.mode === 'development'),
			'import.meta.env.PROD': String(config.mode !== 'development'),
			'import.meta.env.MODE': JSON.stringify(config.mode),
			'import.meta.env.BASE_URL': JSON.stringify(config.base || '/'),
		},
	}

	// ────────── 插件 ──────────
	const plugins = [
		{
			name: 'ie:pre',
			resolveId(source, importer) {
				const r = resolver.resolveId(source, importer ? U.toPosix(importer) : undefined);
				if (!r) return null;
				if (r.external) return {id: r.id, external: true};
				const id = r.id + (r.query ? '?' + r.query : '');
				return r.id.endsWith('.css') ? {id, moduleSideEffects: 'no-treeshake'} : id;
			},
		},
		...config.plugins.map(p => {
			const cloned = {...p};
			delete cloned.generateBundle;
			for (const [k, v] of Object.entries(cloned)) {
				cloned[k] = typeof v === 'function' ? v.bind(p) : v;
			}
			return cloned;
		}),
		{
			name: 'ie:post',
			async load(id) {
				const file = id.split('?', 1)[0];
				const ext = path.extname(file).toLowerCase();

				if (id.endsWith("?raw")) return `export default ${JSON.stringify(await fsp.readFile(file, 'utf8'))}`;
				if (id.endsWith("?worker")) {
					// ?worker：用 esbuild 单独打成一个 ESM worker 文件
					const result = await esbuild.build({
						entryPoints: [file],
						bundle: true,
						write: false,
						platform: 'browser',
						minify: config.build.minify !== false,
						...esbuildOptions,
					});
					const name = path.basename(file).replace(/(\.[^.]+)$/, '.worker$1');
					const url = ctx.emitAsset(this, file, result.outputFiles[0].contents, name);
					return {
						code: `export default class extends Worker { constructor(options) { super(${JSON.stringify(url)}, Object.assign({type:'module'}, options)) } }`,
						map: null,
					};
				}
				if (ext === '.css') {
					const css = await processCss(await fsp.readFile(file, 'utf8'), file, ctx, this);
					ctx.css.set(U.toPosix(id), css);
					return {code: '', map: null};
				}
				if (ext === '.json') return `export default ${await fsp.readFile(file, 'utf8')}`;
				if (U.isJsFile(file)) return null;

				const source = await fsp.readFile(file);
				const limit = config.build.assetsInlineLimit ?? 4096;
				const url = source.length <= limit
					? `data:${getContentType(file)};base64,${source.toString('base64')}`
					: ctx.emitAsset(this, file, source);
				return `export default ${JSON.stringify(url)}`;
			},
			async transform(code, id) {
				const file = U.cleanUrl(id);
				if (!U.isJsFile(file)) return null;

				let ext = path.extname(file).toLowerCase().slice(1);
				if (ext[0] === 'm' || ext[0] === 'c') ext = ext.slice(1);

				const result = await esbuild.transform(code, {
					...esbuildOptions,
					loader: ext,
					sourcefile: file,
				});
				return {code: result.code, map: null};
			},
			async buildStart() {
				// TODO 大肥鱼写的这玩意怎么没调用？
				for (const doc of docs) {
					for (const style of doc.styles) {
						style.css = await processCss(await fsp.readFile(style.abs, 'utf8'), style.abs, ctx, this);
					}
					for (const asset of doc.assets) {
						asset.source = await fsp.readFile(asset.abs);
						const ref = this.emitFile({
							type: 'asset',
							name: path.basename(asset.abs),
							source: asset.source
						});
						ctx.assetSource.set(ref, asset.abs);
						asset.ref = ref;
					}
				}
			},
			generateBundle() {
				for (const [ref, file] of ctx.assetSource) {
					try {
						ctx.assetNames.set(ref, this.getFileName(ref));
					} catch (e) {
						console.warn(`[ie] 无法确定资源名 ${file}: ${e.message}`);
					}
				}
			},
		},
	];


	const disablePreload = config.build?.modulePreload === false;


	// ────────── chunk ↔ css 归属 ──────────
	const cssInfo = new Map();   // chunk name -> {fileName, css} | null

	const chunkCss = chunk => {
		if (cssInfo.has(chunk.name)) return cssInfo.get(chunk.name);
		const list = [];
		for (const id of chunk.moduleIds || Object.keys(chunk.modules || {})) {
			const css = ctx.css.get(U.toPosix(id));
			if (css) list.push(css);
		}
		const info = list.length ? {
			fileName: `${CSS_DIR}/${sanitizeName(chunk.name)}-${U.hash(list.join())}.css`,
			css: list.join('\n'),
		} : null;
		cssInfo.set(chunk.name, info);
		return info;
	};

	if (!disablePreload) {
		plugins.push(createPreloadPlugin(chunk => chunkCss(chunk)?.fileName,));
	}

	// ────────── rollup ──────────
	const outputOptions = {
		format: 'es',
		entryFileNames: 'assets/[name]-[hash].js',
		chunkFileNames: 'assets/[name]-[hash].js',
		assetFileNames: 'assets/[name]-[hash][extname]',
		dir: outDir,
		...config.build.rollupOptions.output,
	};

	const tasks = [];

	if (config.build.emptyOutDir !== false && (await safeStat(outDir)).isDirectory()) {
		tasks.push(fsp.readdir(outDir).then(item => Promise.all(item.map(p => fsp.rm(path.join(outDir, p), {recursive: true, force: true})))));
	}

	const t0 = Date.now();
	const bundle = await rollup({
		input: rollupInput,
		external: config.build.rollupOptions.external,
		plugins,
		onwarn(warning, warn) {
			if (warning.code === 'CIRCULAR_DEPENDENCY' || warning.code === 'SOURCEMAP_ERROR') return;
			if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return;
			warn(warning);
		},
	});
	const {output} = await bundle.generate(outputOptions);
	await bundle.close();

	// ────────── 后处理 ──────────
	const files = new Map();
	const chunkByName = new Map();
	const chunkByFile = new Map();
	for (const item of output) {
		files.set(item.fileName, item);
		if (item.type === 'chunk') {
			chunkByName.set(item.name, item);
			chunkByFile.set(item.fileName, item);
		}
		if (item.type === 'chunk' && item.map && outputOptions.sourcemap) {
			files.set(item.fileName + '.map', {
				type: 'asset',
				fileName: item.fileName + '.map',
				source: item.map.toString(),
				name: item.fileName + '.map'
			});
		}
	}

	// 1. 每个 chunk 的 css
	const cssByChunk = new Map();
	for (const js of output) {
		if (js.type !== 'chunk') continue;
		const css = chunkCss(js);
		if (!css) continue;
		files.set(css.fileName, {
			type: 'asset',
			fileName: css.fileName,
			name: css.fileName,
			source: placeholders(css.css, css.fileName, 'css')
		});
		cssByChunk.set(js.fileName, css.fileName);
	}

	// 2. HTML
	const collectChunks = (chunk, set) => {
		if (!chunk || set.has(chunk.fileName)) return set;
		// 先依赖后自己：与 vite 的 css link 顺序一致
		for (const f of chunk.imports) collectChunks(chunkByFile.get(f), set);
		set.add(chunk.fileName);
		return set;
	};
	const staticImports = (chunk, acc = new Set()) => {
		for (const f of chunk.imports) {
			if (acc.has(f)) continue;
			acc.add(f);
			const c = chunkByFile.get(f);
			if (c) staticImports(c, acc);
		}
		return acc;
	};

	// 2.5 每个文档静态可达的 chunk css（依赖序：先依赖后自己）
	const docCssList = new Map();

	const allCssRef = new Set();
	const uniqueCssRef = new Set();

	// 合并不共享的CSS文件
	const mergeUniqueCss = config.build.mergeUniqueCss;

	for (const doc of docs) {
		const deps = new Set();
		for (const script of doc.scripts) {
			const chunk = chunkByName.get(script.name);
			if (chunk) collectChunks(chunk, deps);
		}

		const list = [];

		for (const js of deps) {
			const css = cssByChunk.get(js);
			if (css) {
				if (mergeUniqueCss) {
					if (!allCssRef.has(css)) {
						allCssRef.add(css);
						uniqueCssRef.add(css);
					} else {
						uniqueCssRef.delete(css);
					}
				}

				list.push([js, css]);
			}
		}

		docCssList.set(doc, list);
	}

	for (const doc of docs) {
		const list = docCssList.get(doc);

		const cssLinks = [];

		let run = [];
		const flushRun = () => {
			if (!run.length) return;
			const source = run.map(css => files.get(css).source).join('');
			const fileName = `${CSS_DIR}/${sanitizeName(doc.name)}-${U.hash(source)}.css`;
			files.set(fileName, {type: 'asset', fileName, name: fileName, source});
			cssLinks.push(`<link rel="stylesheet" crossorigin href="${href(fileName)}">`);
			run = [];
		};

		for (const [js, css] of list) {
			cssByChunk.delete(js);

			if (uniqueCssRef.has(css)) {
				run.push(css);
				continue;
			}

			flushRun();
			cssLinks.push(`<link rel="stylesheet" crossorigin href="${href(css)}">`);
		}
		flushRun();

		let html = transformTags(doc.html, (tag, attrs, raw) => {
			if (tag === 'script') {
				const src = attr(attrs, 'src');
				const script = doc.scripts.find(s => s.src === src);
				if (!script) return null;
				const chunk = chunkByName.get(script.name);
				if (!chunk) return null;
				const preload = disablePreload ? '' : [...staticImports(chunk)].map(f => `<link rel="modulepreload" crossorigin href="${href(f)}">`).join('');
				return `<script type="module" crossorigin src="${href(chunk.fileName)}"${script.async ? ' async' : ''}${script.defer ? ' defer' : ''}></script>${preload}`;
			}
			if (tag === 'link') {
				const url = attr(attrs, 'href');
				if (url) {
					const style = doc.styles.find(s => s.href === url);
					if (style) {
						const fileName = `${CSS_DIR}/${sanitizeName(path.basename(style.abs).replace(/\.css$/i, ''))}-${U.hash(style.css)}.css`;
						style.fileName = fileName;
						style.pending = placeholders(style.css, fileName, 'css');
						return `<link rel="stylesheet" crossorigin href="${href(fileName)}">`;
					}

					const asset = doc.assets.find(a => a.href === url);
					if (asset) {
						const fileName = ctx.assetNames.get(asset.ref);
						if (fileName) return raw.replace(url, () => href(fileName));
					}
				}

				return null;
			}
			return null;
		});

		if (cssLinks.length) html = html.replace(/<\/head>/i, `${cssLinks.join('')}</head>`);
		html = await applyHtmlTransforms(config.plugins, html, {
			path: '/' + U.toPosix(path.relative(root, doc.file)),
			filename: doc.file,
			bundle: Object.fromEntries(files),
		});
		const outName = U.toPosix(path.relative(root, doc.file));
		files.set(outName, {type: 'asset', fileName: outName, name: outName, source: html});
	}

	uniqueCssRef.forEach(name => files.delete(name));

	// HTML 里引用的 css 资源（延迟到占位符可用后一次写入）
	for (const doc of docs) {
		for (const style of doc.styles) {
			if (!style.fileName) continue;
			files.set(style.fileName, {
				type: 'asset',
				fileName: style.fileName,
				name: style.fileName,
				source: style.pending
			});
		}
	}

	// 3. 动态 chunk 自己注入 css
	if (disablePreload) {
		for (const [js, css] of cssByChunk) {
			const chunk = chunkByFile.get(js);
			if (!chunk) continue;
			const rel = path.posix.relative(path.posix.dirname(js), css);
			chunk.code += `\n;(()=>{const l=document.createElement('link');l.rel='stylesheet';l.href=new URL(${JSON.stringify(rel)},import.meta.url).href;document.head.appendChild(l)})();`;
		}
	}

	// 4. 压缩
	if (config.build.minify !== false) {
		for (const item of output) {
			if (item.type !== 'chunk' || !item.code) continue;
			const result = await esbuild.transform(item.code, {
				...esbuildOptions,
				loader: 'js',
				minify: true,
			});
			item.code = result.code;
		}
	}

	// 5. 资源占位符收尾：js 里用 base 相对，css 里相对自身
	for (const [fileName, item] of files) {
		if (item.type === 'chunk') item.code = placeholders(item.code, fileName, 'js');
		else if (typeof item.source === 'string') {
			item.source = placeholders(item.source, fileName, 'css');
			if (fileName.endsWith('.css') && config.build.minify !== false) {
				const result = await esbuild.transform(item.source, {loader: 'css', minify: true, charset: 'utf8',});
				item.source = result.code;
			}
		}
	}

	const bundleObject = Object.fromEntries(files);
	for (const plugin of config.plugins) {
		if (!plugin.generateBundle) continue;

		const hookThis = {
			info: m => log.info(`[plugin ${plugin.name}] ${m}`),
			warn: m => log.warn(`[plugin ${plugin.name}] ${m}`),
			error: m => log.error(`[plugin ${plugin.name}] ${m}`),
			emitFile(file) {
				const fileName = file.fileName || `${CSS_DIR}/${U.hash(file.source || '')}-${file.name || 'asset'}`;
				bundleObject[fileName] = {type: file.type, fileName, name: file.name, source: file.source};
				return fileName;
			},
			getFileName: name => name,
		};

		await plugin.generateBundle.call({...hookThis, ...plugin}, outputOptions, bundleObject, false);
	}

	await Promise.all(tasks);
	tasks.length = 0;

	if (config.build.copyPublicDir !== false && (await safeStat(config.publicDir)).isDirectory()) {
		tasks.push(fsp.mkdir(outDir, {recursive: true}).then(() => fsp.cp(config.publicDir, outDir, {recursive: true, force: true})));
	}

	const reportCompressed = config.build.reportCompressedSize !== false;
	const reports = [];

	for (const [key, item] of Object.entries(bundleObject)) {
		const content = item.type === 'chunk' ? item.code : item.source;
		if (content == null) continue;

		const fileName = item.fileName || key;
		const target = path.join(outDir, fileName);
		tasks.push(fsp.mkdir(path.dirname(target), {recursive: true}).then(() => fsp.writeFile(target, content)));

		if (!fileName.endsWith('.map')) {
			const isChunk = item.type === 'chunk';
			const isCSS = fileName.endsWith('.css');

			const r = {
				name: fileName,
				group: isChunk ? 'JS' : isCSS ? 'CSS' : 'Assets',
				size: typeof content === 'string' ? Buffer.byteLength(content) : content.length,
			};

			if (reportCompressed && (isChunk || isCSS || COMPRESSIBLE_RE.test(fileName))) {
				const buf = typeof content === 'string' ? Buffer.from(content) : content;
				tasks.push(new Promise(resolve => {
					gzip(buf, (error, result) => {
						r.compressedSize = error ? 'ERR' : result.length;
						resolve();
					})
				}))
			}

			reports.push(r);
		}
	}

	await Promise.all(tasks);

	printDistReport(reports, outDir, root, config, log);

	log.info(`${colors.green('✓')} built in ${((Date.now() - t0) / 1000).toFixed(2)}s`);
	return {outDir, files: bundleObject};
}

/** 和 vite reporter.ts 一致：Assets 绿、CSS 洋红、JS 青 */
const COLORS = {
	Assets: colors.green,
	CSS: colors.magenta,
	JS: colors.cyan,
};
/** vite 里只有这些静态资源值得报 gzip 体积（js/css 另外处理） */
const COMPRESSIBLE_RE = /\.(?:html|json|svg|txt|xml|xhtml)$/;
const sizeFormatter = new Intl.NumberFormat('en', {minimumFractionDigits: 2, maximumFractionDigits: 2});
/** vite 用 1000 进制，不是 1024 */
const displaySize = bytes => `${sizeFormatter.format(bytes / 1000)} kB`;

/**
 *
 * @param {{ name, group, size, compressedSize? }[]} entries
 * @param {string} outDir
 * @param {string} root
 * @param config
 * @param log
 */
export function printDistReport(entries, outDir, root, config, log) {
	const grouped = {};
	let nameLength = 0;
	let sizeLength = 0;
	let compressedSizeLength = 0;

	entries.forEach(item => {
		(grouped[item.group] ??= []).push(item);
		nameLength = Math.max(nameLength, item.name.length);
		sizeLength = Math.max(sizeLength, displaySize(item.size).length);
		if (item.compressedSize != null)
			compressedSizeLength = Math.max(compressedSizeLength, displaySize(item.compressedSize).length);
	});

	const chunkLimit = config.build.chunkSizeWarningLimit ?? 500;
	const relativeOutDir = U.toPosix(path.relative(root, outDir)) + '/';
	let hasLargeChunks = false;

	for (const [groupName, groupColor] of Object.entries(COLORS)) {
		const arr = grouped[groupName];
		if (!arr) continue;

		for (const entry of arr.sort((a, b) => a.size - b.size)) {
			const isLarge = groupName === 'JS' && entry.size / 1000 > chunkLimit;
			if (isLarge) hasLargeChunks = true;
			const sizeColor = isLarge ? colors.yellow : colors.dim;

			const slash = entry.name.lastIndexOf('/');
			const dir = slash < 0 ? '' : entry.name.slice(0, slash + 1);
			const base = entry.name.slice(dir.length);

			let line = colors.dim(relativeOutDir);
			line += (dir ? colors.dim(dir) : '') + groupColor(base.padEnd(nameLength + 2 - dir.length));
			line += colors.bold(sizeColor(displaySize(entry.size).padStart(sizeLength)));
			if (entry.compressedSize) {
				line += colors.dim(` │ gzip: ${displaySize(entry.compressedSize).padStart(compressedSizeLength)}`);
			}
			console.log(line);
		}
	}

	if (hasLargeChunks && config.build.minify !== false) {
		log.warn(
			`(!) 有 chunk 超过 ${chunkLimit} kB（压缩前）。考虑用 dynamic import() 拆包，` +
			`或用 manualChunks 重新分组，或调大 build.chunkSizeWarningLimit`,
		);
	}
}

function sanitizeName(name) {
	return String(name).replace(/[\\/]/g, '-').replace(/[^\w.-]/g, '_');
}

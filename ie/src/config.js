import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import * as esbuild from 'esbuild';
import {createLogger, flatten, mergeConfig, toPosix} from './utils.js';

const VITE_SHIM = fileURLToPath(new URL('./plugin.js', import.meta.url));
const CONFIG_NAMES = ['vite.config.js', 'vite.config.mjs', 'vite.config.ts', 'ie.config.js', 'ie.config.mjs'];

function sortPlugins(plugins) {
	const byEnforce = {pre: 0, normal: 1, post: 2};
	return plugins.sort((a, b) => (byEnforce[a.enforce] ?? 1) - (byEnforce[b.enforce] ?? 1));
}

/**
 * 载入 vite.config.js：用 esbuild 打包成临时 mjs。
 * 好处是天然支持 TS / JSON import attributes / `import {defineConfig} from "vite"`。
 */
async function loadUserConfig(root, configFile, command, mode) {
	let entry = configFile === false ? null : configFile ? path.resolve(root, configFile) : CONFIG_NAMES.map(n => path.join(root, n)).find(fs.existsSync);
	if (!entry) return {};

	const entryUrl = pathToFileURL(entry).href;
	const outFile = path.join(root, 'node_modules', '.ie', `config-${process.pid}-${Date.now()}.mjs`);
	await fsp.mkdir(path.dirname(outFile), {recursive: true});
	await esbuild.build({
		entryPoints: [entry],
		outfile: outFile,
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: 'node20',
		packages: 'external',
		logLevel: 'silent',
		// 配置里的 __dirname 必须指向配置文件所在目录，而不是产物目录
		define: {
			__dirname: JSON.stringify(path.dirname(entry)),
			__filename: JSON.stringify(entry),
			'import.meta.url': JSON.stringify(entryUrl),
		},
		plugins: [{
			name: 'ie-vite-shim',
			setup(build) {
				build.onResolve({filter: /^vite$/}, () => ({path: VITE_SHIM}));
			},
		}],
	});

	try {
		const mod = await import(pathToFileURL(outFile).href);
		const userConfig = typeof mod.default === 'function'
			? await mod.default({command, mode})
			: (mod.default ?? {});
		return userConfig || {};
	} finally {
		fsp.rm(outFile, {force: true}).catch(() => {
		});
	}
}

export function defaultConfig(root) {
	return {
		root,
		base: '/',
		publicDir: 'public',
		define: {},
		resolve: {alias: [], extensions: ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json']},
		css: {postcss: {plugins: []}},
		build: {
			outDir: 'dist',
			assetsInlineLimit: 4096,
			minify: 'esbuild',
			copyPublicDir: true,
			emptyOutDir: true,
			rollupOptions: {},
			modulePreload: {polyfill: false},
			reportCompressedSize: true,
		},
		server: {watch: {ignored: []}},
		optimizeDeps: {},
	};
}

/**
 * @param {{root?: string, configFile?: string|false, mode?: string, command?: 'serve'|'build', config?: Partial<ie.Config>}} options
 * @return {ie.Config}
 */
export async function resolveConfig(options = {}) {
	const root = path.resolve(options.root || '.');
	process.chdir(root);
	const command = options.command || 'build';
	const mode = options.mode || (command === 'serve' ? 'development' : 'production');
	process.env.NODE_ENV = command === 'serve' ? 'development' : 'production';

	const userConfig = options.config ?? await loadUserConfig(root, options.configFile, command, mode);

	let config = mergeConfig(defaultConfig(root), userConfig);
	config.plugins = flatten(config.plugins || []).filter(p => p && p.name)
		.filter(p => !p.apply || p.apply === command);
	config.plugins = sortPlugins(config.plugins);

	// 插件自身注入的配置（别名、define...）
	for (const plugin of [...config.plugins]) {
		if (!plugin.config) continue;
		const partial = await plugin.config(config, {command, mode});
		if (partial) config = mergeConfig(config, partial);
	}
	config.plugins = sortPlugins(flatten(config.plugins || []).filter(p => p && p.name && (!p.apply || p.apply === command)));

	config.root = root;
	config.command = command;
	config.mode = mode;
	config.isProduction = mode === 'production';
	config.publicDir = config.publicDir === false ? false : path.resolve(root, config.publicDir || 'public');
	config.define = config.define || {};
	// define 的值必须是字符串形式的表达式（插件可能直接塞布尔值）
	for (const key of Object.keys(config.define)) {
		const value = config.define[key];
		if (typeof value !== 'string') config.define[key] = JSON.stringify(value);
	}

	for (const plugin of config.plugins) await plugin.configResolved?.(config);
	return config;
}

/** 给 dev / build 用的插件容器：按 enforce 顺序执行 load / transform / transformIndexHtml */
export function createPluginContainer(plugins, config) {
	const ctx = plugin => ({
		...plugin,
		meta: {ie: true, vite: {version: '7.0.0-ie'}},
		...createLogger('plugin '+plugin.name),
		//async resolve() {return null},
		//emitFile() {},
	});
	const call = async (name, ...args) => {
		for (const plugin of plugins) {
			const fn = plugin[name];
			if (fn) await fn.apply(ctx(plugin), args);
		}
	};
	return {
		plugins,
		async load(id) {
			for (const plugin of plugins) {
				if (!plugin.load) continue;
				const r = await plugin.load.call(ctx(plugin), id);
				if (r == null) continue;
				return typeof r === 'string' ? r : r.code;
			}
			return null;
		},
		async transform(code, id) {
			for (const plugin of plugins) {
				if (!plugin.transform) continue;
				const r = await plugin.transform.call(ctx(plugin), code, id, {inMap: null});
				if (r == null) continue;
				code = typeof r === 'string' ? r : r.code;
			}
			return code;
		},
		call,
	};
}

export {sortPlugins, toPosix};

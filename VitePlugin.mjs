import {createFilter, normalizePath} from 'vite';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from "node:url";
import {createTransformConfig, transform} from "./transform.js";

const DEFAULT_FILTER = /\.[jt]sx?$/;
const scriptPath = import.meta.dirname;


function findPackageJson(startDir) {
	let currentDir = path.resolve(startDir || process.cwd());
	const rootDir = path.parse(currentDir).root;

	while (1) {
		const packageJsonPath = path.join(currentDir, 'package.json');

		if (fs.existsSync(packageJsonPath)) {
			try {
				const packageJsonContent = fs.readFileSync(packageJsonPath, 'utf8');
				const packageData = JSON.parse(packageJsonContent);
				return {
					path: packageJsonPath,
					data: packageData
				};
			} catch (error) {
				throw new Error(`Found package.json at ${packageJsonPath} but failed to parse: ${error.message}`);
			}
		}

		if (currentDir === rootDir) break
		currentDir = path.dirname(currentDir);
	}

	return null;
}

/**
 *
 * @param {import('vite').FilterPattern} options.include=undefined
 * @param {import('vite').FilterPattern} options.exclude=undefined
 * @param {boolean} options.micro=false
 * @param {Object} options
 * @property {"unconscious"|string} options.modulePath
 * @return {import('vite').Plugin}
 */
export default (options = {}) => {
	const {
		include = DEFAULT_FILTER,
		exclude,
		plugins = [],
		micro = false
	} = options;

	let theLibrary;
	theLibrary = micro ? {'unconscious': scriptPath + '/runtime_micro.js'} : {'unconscious': scriptPath + '/runtime.js'};

	const transformConfig = createTransformConfig(options, plugins);

	const customFilter = createFilter(include, exclude);
	return {
		name: "unconscious",
		enforce: 'pre',
		handleHotUpdate({ file, timestamp, modules, server }) {
			server.ws.send({
				type: 'custom',
				event: 'module-graph',
				data: {
					id: file,
					timestamp: timestamp,
					updated: modules.map(m => {
						return {
							id: m.id,
							parent: Array.from(m.importers).map(importer => importer.id),
							child: Array.from(m.importedModules).map(importer => importer.id)
						}
					})
				}
			});
		},
		config(userConfig, {mode}) {
			transformConfig.envName = mode;

			return {
				resolve: {
					alias: {
						'unconscious/common': scriptPath+'/common',
						'unconscious/shared.js': scriptPath+'/shared.js',
						...theLibrary,
					}
				},

				define: {
					UC_PERSIST_STORE: userConfig?.define?.UC_PERSIST_STORE ?? JSON.stringify(findPackageJson()?.data.name ?? 'default'),
					UC_REACTIVE_FRAGMENT: userConfig?.define?.UC_REACTIVE_FRAGMENT ?? false,
					UC_VERSION: JSON.stringify(findPackageJson(fileURLToPath(import.meta.url))?.data.version) ?? 'unknown',
				},

				// 依赖转换阶段
				optimizeDeps: {
					esbuildOptions: { plugins: [{
							name: "unconscious_prebuild",
							setup(build) {
								const namespace = "";

								build.onLoad({ filter: /.*/, namespace }, async (args) => {
									if (args.path.startsWith(normalizePath(scriptPath))) {
										if (!normalizePath(args.path.substring(scriptPath.length+1)).includes("/")) return;
									}
									else if (normalizePath(args.path).includes("/node_modules/")) return;
									if (!customFilter(args.path)) return;

									const code = await fs.promises.readFile(args.path, "utf8");
									return {
										contents: transform(code, { filename: args.path, ...transformConfig }).code
									};
								});
							}
						}] },

					rollupOptions: { plugins: [{
							name: "unconscious_prebuild",
							async load(path) {
								if (path.startsWith(scriptPath)) {
									if (!normalizePath(path.substring(scriptPath.length+1)).includes("/")) return;
								}
								else if (scriptPath.includes("/node_modules/")) return;
								if (!customFilter(path)) return;

								const code = await fs.promises.readFile(path, "utf8");
								return transform(code, { filename: path, ...transformConfig }, false);
							}
						}] } }
			};
		},
		// 构建阶段
		transform(code, filename, transformOptions) {
			if (filename.startsWith(normalizePath(scriptPath))) {
				if (!filename.substring(scriptPath.length+1).includes("/")) return;
			}
			if (!customFilter(filename)) return;

			return transform(code, { filename, ...transformConfig, inputSourceMap: transformOptions?.inMap }, true);
		}
	};
};

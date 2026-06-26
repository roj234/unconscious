import {build as esbuildBuild} from 'esbuild';

export function minifyJsString(options) {
	let config = {};
	return {
		name: 'vite-minify-js-string',

		config(userConfig, {mode}) {
			config.envName = mode;
		},

		async load(id) {
			if (!id.endsWith('?minjs')) return

			// 提取真实文件路径
			const [filePath] = id.split('?', 1)
			if (!filePath.endsWith('.js')) return

			// 使用 build API 进行打包 + 压缩
			const result = await esbuildBuild({
				entryPoints: [filePath],
				bundle: true,
				write: false,
				platform: 'browser',
				format: 'iife',
				minify: config.envName !== "development",
			});

			// build 返回 outputFiles 数组（write: false 时）
			const code = result.outputFiles?.[0]?.text ?? '';

			return {
				code: `export default ${JSON.stringify(code)}`,
				map: null,
			};
		},
	}
}
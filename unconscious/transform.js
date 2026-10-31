import {MIXIN_ID} from "./MyJSXParser.mjs";

import {parse as babelParse} from '@babel/parser';
import {generate as babelGenerate} from '@babel/generator';
import codeFrame from "@babel/code-frame";
import traverse from "@babel/traverse";

import HotModuleReplace from "./transformer/HotModuleReplace.js";
import RemoveSpecialImport from "./transformer/RemoveSpecialImport.js";
import UCTransformer from './transformer/Unconscious.js';
import SideEffectAnalyze from "./transformer/SideEffectAnalyze.js";

export const createTransformConfig = (options, plugins = []) => ({
	parseOptions: {},
	generateOptions: {jsescOption: {minimal: true}},
	...options,
	cwd: process.cwd(),
	plugins: [
		[SideEffectAnalyze],
		[UCTransformer, options],
		[RemoveSpecialImport],
		[HotModuleReplace],
		...plugins].map(t => {
		if (Array.isArray(t)) return t[0](null, t[1]);
		return typeof t === "function" ? t(null, {}) : t;
	}),
	removeSpecialImport: {
		'unconscious': ['$watchWithCleanup']
	}
});

// AST Traverser

class PluginPass {
	constructor(file) {
		this._map = new Map();
		this.file = file;
		this.opts = file.opts;
		this.filename = file.opts.filename;
	}

	set(key, val) {
		this._map.set(key, val);
	}
	get(key) {
		return this._map.get(key);
	}

	buildCodeFrameError(node, msg, _Error) {
		return this.file.buildCodeFrameError(node, msg, _Error);
	}
}

class File {
	constructor(code, ast, options) {
		this.code = code;
		this.ast = ast;
		this.opts = options;
		this.metadata = {};
		this.path = traverse.NodePath.get({
			parentPath: null,
			parent: ast,
			container: ast,
			key: "program",
			hub: {
				buildError: this.buildCodeFrameError.bind(this),
				file: this
			}
		}).setContext();
		this.scope = this.path.scope;
	}

	buildCodeFrameError(node, msg, _Error = SyntaxError) {
		let loc = node == null ? void 0 : node.loc;
		if (loc) {
			const {
				highlightCode = true
			} = this.opts;
			msg += "\n" + codeFrame.codeFrameColumns(this.code, {
				start: {
					line: loc.start.line,
					column: loc.start.column + 1
				},
				end: loc.end && loc.start.line === loc.end.line ? {
					line: loc.end.line,
					column: loc.end.column + 1
				} : undefined
			}, {
				highlightCode
			});
		}
		return new _Error(msg);
	}
}

/**
 * 转换JavaScript
 */
export function transform(code, options, needSourceMap) {
	const mixins = ["jsx", MIXIN_ID];
	if (options.filename.match(/.tsx?$/)) {
		mixins.push("typescript");
	}

	const ast = babelParse(code, {
		sourceFileName: options.filename,
		plugins: mixins,
		inputSourceMap: options.inputSourceMap,
		...options.parseOptions,
		sourceType: "module",
	});

	const file = new File(code, ast, options);

	/**
	 * @type {PluginPass[]}
	 */
	const passes = [];
	const visitors = [];

	for (const plugin of options.plugins) {
		if (plugin.developmentOnly && options.envName !== "development") continue;

		const pass = new PluginPass(file, plugin.key);
		passes.push(pass);
		plugin.pre?.call(pass, file);
		visitors.push(plugin.visitor);
	}

	const visitor = traverse.visitors.merge(visitors, passes, options.wrapPluginVisitorMethod);

	traverse.default(file.ast, visitor, file.scope);

	return babelGenerate(file.ast, {
		comments: true,
		compact: 'auto',
		sourceMaps: needSourceMap,
		inputSourceMap: ast.inputSourceMap,

		...options.generateOptions,

		filename: options.filename,
		sourceFileName: options.filename.substring(options.filename.lastIndexOf('/')+1),
		//sourceRoot: process.cwd(),
	}, code);
}
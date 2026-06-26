/**
 * safe-worker
 * Safe ESM WebWorker sandbox in 10 KiB (minified).
 */

import loader_template from "./worker-setup.js?minjs";

/**
 * @typedef {Object} ModuleResolver
 * @property {string} exports
 * @property {string|null} runtimeImportFunc
 * @property {(name?: string) => string} nextTmp
 * @property {(name: string, options?: { type: string }) => string} resolveModule
 */

export class ParseError extends Error {
	constructor(msg, mod) {
		super(mod ? msg + ' (in "' + mod + '")' : msg);
		this.name = 'ParseError';
	}
}

//region Tokenizer & Transformer
// Character classifiers
const
	SPACE = /\s/,
	IDENT_START = /[a-zA-Z_$]/,
	IDENT_PART = /[a-zA-Z\d_$]/,
	DIGIT = /\d/,
	OPERATORS = /===|!==|\.\.\.|&&|\|\||\?[?.]|(?:<<|>>>?|\*\*|[-+*/%><!=])=?/y;

// Regex context: characters/tokens after which '/' starts a regex literal
// This is not fully compliant, but enough for now.
const RE_CTX = /[(\[{=!&|,;:?~+\-*%<>^]$/;
const RE_KW = /^(return|typeof|void|delete|throw|instanceof|new|case|yield|await|in|of|do|else)$/;

// Statement parser classifiers
const STRING = /^(['"]).*\1$/;
const LITERAL = /^[a-zA-Z_$][a-zA-Z\d_$]*$/;
const quote = s => JSON.stringify(s);
const unquote = s => JSON.parse(`"${s.slice(1, -1)}"`);

/**
 * Single-pass module transformer.
 *
 * Walks source directly, copies everything verbatim except top-level
 * import/export statements which are parsed and transformed inline.
 *
 * 哇，解析JS
 * - 妈的，我没想到我还有第二次做它的一天
 * @param {string} code
 * @param {ModuleResolver} ctx
 * @returns {string[]}
 */
function parseModule(code, ctx) {
	const tokens = [];
	let pos = 0;
	const len = code.length;

	let depth = 0;
	/** @type {null|RegExp} */
	let inStmt;

	const parseDescents = (re) => {
		const outLen = tokens.length;
		const prevInStmt = inStmt;
		const prevDepth = depth;
		inStmt = re;
		depth = 0;
		parse();
		depth = prevDepth;
		inStmt = prevInStmt;
		return outLen;
	};

	const parse = () => {
		while (pos < len) {
			const ch = code[pos];

			// ---- Whitespace ----
			if (SPACE.test(ch)) { pos++; continue; }

			// ---- Comment ----
			if (ch === '/') {
				if (code[pos + 1] === '/') {
					pos = code.indexOf('\n', pos+1)+1;
					continue;
				}

				if (code[pos + 1] === '*') {
					pos = code.indexOf('*/', pos+1)+2;
					continue;
				}
			}

			// ---- String literal ----
			if (ch === '\'' || ch === '"') {
				const start = pos++;
				while (pos < len) {
					const c1 = code[pos++];
					if (c1 === ch) break;
					if (c1 === '\\') pos ++;
				}

				tokens.push(code.slice(start, pos));
				continue;
			}

			// ---- Template literal ----
			if (ch === '`') {
				const start = pos++;
				while (pos < len) {
					const c1 = code[pos++];
					if (c1 === '`') break;
					if (c1 === '\\') pos ++;

					else if (c1 === '$' && code[pos] === '{') {
						pos ++;
						tokens.length = parseDescents(/\0/);
					}
				}

				tokens.push(code.slice(start, pos));
				continue;
			}

			// ---- Number literal ----
			if (DIGIT.test(ch) || (ch === '.' && DIGIT.test(code[pos + 1]))) {
				const start = pos;

				while (/[0-9.]/.test(code[pos])) pos++;

				let c1 = code[pos];
				if (/[xob]/i.test(c1)) {
					while (/[0-9a-fA-F]/.test(code[pos])) pos++;
				} else if (c1 === 'e' || c1 === 'E') {
					c1 = code[pos++];
					if (c1 === '+' || c1 === '-') pos++;
					while (/[0-9.]/.test(code[pos])) pos++;
				}
				else if (c1 === 'n') pos++;

				tokens.push(code.slice(start, pos));
				continue;
			}

			// ---- RegExp literal or division ----
			if (ch === '/') {
				const prevTrim = tokens.at(-1)?.trimEnd();
				const isRegex = !prevTrim || RE_CTX.test(prevTrim) || RE_KW.test(prevTrim);
				const start = pos++;

				if (!isRegex) {
					// Division: / or /=
					if (code[pos] === '=') pos++;
				} else {
					// RegExp literal
					let inClass = false;
					while (pos < len) {
						const c1 = code[pos++];
						if (c1 === '\\') { pos ++; }
						if (!inClass) {
							if (c1 === '/') break;
							if (c1 === '[') inClass = true;
						} else if (c1 === ']') {
							inClass = false;
						}
					}
					while (pos < len && IDENT_PART.test(code[pos])) pos++; // flags
				}

				tokens.push(code.slice(start, pos));
				continue;
			}

			// ---- Identifier / keyword ----
			if (IDENT_START.test(ch)) {
				const start = pos;
				while (pos < len && IDENT_PART.test(code[pos])) pos++;
				const identifier = code.slice(start, pos);

				const ERR = () => {throw new ParseError('Only top-level import/export allowed');};

				if (identifier === 'import') {
					while (pos < len && SPACE.test(code[pos])) pos++;

					// import.meta
					if (code[pos] === '.') {tokens.push(identifier);continue;}
					if (code[pos] === '(') {
						const outLen = parseDescents(/\)/);
						const statement = tokens.splice(outLen);
						parseDynamicImport(statement, tokens, ctx);
						continue;
					}

					// Actually we SUPPORT but not ALLOW it...
					if (depth) ERR();
					const outLen = parseDescents(/;/);
					const statement = tokens.splice(outLen);
					parseImport(statement, tokens, ctx);
					continue;
				}

				if (identifier === 'export') {
					if (depth) ERR();
					while (pos < len && SPACE.test(code[pos])) pos++;

					const outLen = parseDescents(/;/);
					const statement = tokens.splice(outLen);
					parseExport(statement, tokens, ctx);
					continue;
				}

				tokens.push(identifier);
				continue;
			}

			// ---- Punctuation / operators ----
			OPERATORS.lastIndex = pos;
			const arr = code.match(OPERATORS);
			if (arr) {
				pos += arr[0].length;
				tokens.push(arr[0]);
				continue;
			}

			// Single character — track depth
			if (ch === '{' || ch === '(' || ch === '[') depth++;
			else if (ch === '}' || ch === ')' || ch === ']') {
				if (depth === 0) {
					if (inStmt) break;
					throw new Error("Invalid syntax at "+pos);
				}
				depth--;
			}

			pos++;
			tokens.push(ch);

			if (inStmt && depth === 0 && inStmt.test(ch)) break;
		}
	};

	parse();

	return tokens;
}

/**
 * Token to JavaScript
 * @param {string[]} tokens
 * @param {boolean=true} prettify
 * @returns {string}
 */
const prettifier = (tokens, prettify = true) => {
	let code = '';
	let indent = 0;
	let newline = false;

	for (const token of tokens) {
		if (newline && token !== '}' && token !== ']') {
			code += '\n' + '  '.repeat(indent);
			newline = false;
		}

		const lastChar = code[code.length - 1];
		if ((lastChar === ')' && token === '{')/* || (OPERATORS.test(token) || OPERATORS.test(lastChar))*/ || (IDENT_PART.test(lastChar) && IDENT_PART.test(token[0]))) {
			code += ' ';
		}

		if (prettify) {
			if (token.endsWith(';')) {
				newline = true;
			} else if (token === '[' || token === '{') {
				indent++;
				code += token;
				code += '\n' + '  '.repeat(indent);
				newline = false;
				continue;
			} else if (token === ']' || token === '}') {
				indent--;
				code += '\n' + '  '.repeat(indent);
				newline = false;
			}
		}

		code += token;
	}

	if (newline) {
		code += '\n';
	}

	return code;
};

/**
 * @param {string[]} tokens
 * @param {string[]} output
 * @param {ModuleResolver} ctx
 */
const parseDynamicImport = (tokens, output, ctx) => {
	const func = ctx.runtimeImportFunc;
	if (!func) throw new ParseError('import() is not supported');
	output.push(func, ...tokens);
};

/**
 * @param {string[]} tokens
 * @param {string[]} output
 * @param {ModuleResolver} ctx
 */
const parseImport = (tokens, output, ctx) => {
	let i = 0;
	const EXCEPT = (chr) => {
		const token = tokens[i];
		if (token !== chr && !chr?.test?.(token)) throw new ParseError('Expected '+quote(chr)+" but got "+quote(token)+" at "+i);
		i++;
		return token;
	};
	const emit = (str) => output.push(str);

	let namespace, namedImport, defaultImport, moduleName;

	const parse = () => {
		if (tokens[i] === '*') {
			i++;
			EXCEPT("as");
			namespace = EXCEPT(LITERAL);
		} else if (tokens[i] === '{') {
			i++;
			[i, namedImport] = parseSpecifiers(tokens, i);
		} else {
			if (defaultImport != null) throw new ParseError('Expected * or { after ,');

			const srcElement = tokens[i++];
			// import 'a';
			if (STRING.test(srcElement)) { moduleName = unquote(srcElement); return; }

			// import a,
			defaultImport = srcElement;

			if (tokens[i] === ',') { i++; return parse(); }
		}

		EXCEPT("from");
		moduleName = unquote(EXCEPT(STRING));
	};
	parse();

	if (tokens[i] === 'assert' || tokens[i] === 'with') {
		i++;
		EXCEPT("{");
		EXCEPT("type");
		EXCEPT(":");

		const type = unquote(EXCEPT(STRING));
		if (type !== 'text') throw new ParseError("Only text assertion is supported now");

		{
			if (namespace || namedImport) throw new ParseError('cannot use namespace or named import with text assertion');

			const text = ctx.resolveModule(moduleName, {type});
			if (text == null) throw new ParseError('Module "'+moduleName+'" has no text content');

			if (defaultImport) emit(`const ${defaultImport} = ${text};`);
			else emit(`/* text import: ${moduleName} */`);
		}

		EXCEPT("}");
	} else {
		const module = ctx.resolveModule(moduleName);

		if (namespace || defaultImport || namedImport) {
			const tmp = namespace || ctx.nextTmp();

			emit(`const ${tmp} = ${module};`);
			if (defaultImport) emit(`const ${defaultImport} = ${tmp}.default;`);
			if (namedImport) emit(`const ${namedDestruct(namedImport)} = ${tmp};`);
		} else {
			// side-effect
		}
	}

	if (tokens[i] === ';') i++;
	EXCEPT(undefined);
};

/**
 * @param {string[]} tokens
 * @param {string[]} output
 * @param {ModuleResolver} ctx
 */
const parseExport = (tokens, output, ctx) => {
	let i = 0;
	const EXCEPT = (chr) => {
		const token = tokens[i];
		if (token !== chr && !chr?.test(token)) throw new ParseError('Expected '+quote(chr)+" but got "+quote(token)+" at "+i);
		i++;
		return token;
	};
	const emit = (str) => output.push(str);
	const emitExpression = (i) => {
		output.push(...tokens.slice(i));
		if (!output.at(-1).endsWith(';')) output.push(';')
	}

	let namespace;
	const field = ctx.exports;

	if (tokens[i] === 'default') {
		// export default ...
		i++;

		let name = tokens[i];
		const start = i;
		if (name === 'async') name = tokens[++i];
		if (name === 'function' || name === 'class') {
			name = tokens[++i];
			if (LITERAL.test(name)) {
				emitExpression(start);
				emit(`${field}.default = ${name};`);
				return;
			}
		}

		emit(`${field}.default = `);
		emitExpression(start);

		return;
	} else if (tokens[i] === '*') {
		// export * [as ns] from 'mod'

		i++;
		if (tokens[i] === 'as') {
			i++;
			namespace = EXCEPT(LITERAL);
		}

		EXCEPT("from");
		const module = ctx.resolveModule(unquote(EXCEPT(STRING)));

		if (namespace) {
			emit(`${field}.${namespace} = ${module};`);
		} else {
			const tmp = ctx.nextTmp();
			emit(`const ${tmp} = ${module};`);
			emit(`for(const k in ${tmp}){if(k!=="default")${field}[k]=${tmp}[k];}`);
		}
	} else if (tokens[i] === '{') {
		// export {a, b} [from 'mod']
		let specifiers, prefix = '';

		i++;
		[i, specifiers] = parseSpecifiers(tokens, i);

		if (tokens[i] === 'from') {
			i++;

			const module = ctx.resolveModule(unquote(EXCEPT(STRING)));

			const tmp = ctx.nextTmp();
			emit(`const ${tmp} = ${module};`);
			prefix = tmp+'.';
		}

		for (const [name, alias] of specifiers) {
			emit(`${field}.${alias} = ${prefix}${name};`);
		}
	} else if (/async|function|class|const|let|var/.test(tokens[i])) {
		emitExpression(i);

		let token = tokens[i];
		if (/const|let|var/.test(token)) {
			for (const name of parseVariableDecl(tokens, i+1)) {
				emit(`${field}.${name} = ${name};`);
			}
		} else {
			const name = tokens[i + (token === 'async' ? 2 : 1)];
			emit(`${field}.${name} = ${name};`);
		}

		return;
	} else {
		throw new ParseError("Unsupported export format: "+quote(tokens.join(" ")));
	}

	if (tokens[i] === ';') i++;
	EXCEPT(undefined);
};

/**
 * @param {string[]} tokens
 * @param {number} i
 * @returns {string[]}
 */
const parseVariableDecl = (tokens, i) => {
	const names = [];
	let name;
	let depth = 0;
	for (; i < tokens.length; i++) {
		const token = tokens[i];
		if (name == null) names.push(name = token);
		else if (token === '{' || token === '[') {depth++;}
		else if (token === '}' || token === ']') {depth--;}
		else if (token === ',' && depth === 0) name = null;
	}
	return names;
};

/**
 * @param {string[]} src
 * @param {number} i
 * @returns {[number,string[]]}
 */
const parseSpecifiers = (src, i) => {
	const result = [];
	const len = src.length;

	if (src[i] !== '}') {
		while (i < len) {
			const name = src[i++];
			let alias = name;
			if (src[i] === 'as') {
				i++;
				alias = src[i++];
				if (!alias) throw new ParseError('Expected identifier after "as"');
			}

			result.push([name, alias]);

			if (src[i] !== ',') break;
			i++;
		}
		if (src[i++] !== '}') throw new ParseError('Expected } at here ');
	}

	return [i, result];
};
/**
 * @param {Array<[string, string]>} specifiers
 * @returns {string}
 */
const namedDestruct = specifiers => `{ ${specifiers.map(([name, alias]) => name === alias ? name : `${alias}: ${name}`).join(', ')} }`;
//endregion

/**
 * @param {Map<string, Module>} modules
 * @param {string} entryName
 * @param {boolean=} allowCircularImport
 * @param {boolean=} prettify
 * @returns {{bundle: string, exports: string, externalModules: string[]}}
 */
function bundle(modules, entryName, allowCircularImport, prettify = false) {
	const entry = modules.get(entryName);
	if (!entry) throw new ParseError('Module not found: ' + entryName);

	const externalModules = [];
	const loadOrder = new Set([entryName]);

	function resolve(importPath, fromModule) {
		if (modules.has(importPath)) return importPath;
		if (modules.has(importPath+'.js')) return importPath+'.js';
		if (fromModule) {
			const base = fromModule.replace(/\/[^/]*$/, '/');
			const resolved = resolveRelative(base + importPath);
			if (resolved) return resolved;
		}
		return null;
	}

	function resolveRelative(path) {
		const parts = path.split('/').filter(s => s && s !== '.');
		const out = [];
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			if (part === '..') out.pop();
			else out.push(part);
		}
		return resolve(out.join('/'));
	}

	const dependOn = (name, module) => {
		if (!loadOrder.has(name)) {
			loadOrder.add(name);
			if (module.code) importModule(name, module);
			else externalModules.push(name);
		} else {
			//throw new ParseError("Circular import including "+name);
		}
	};

	const moduleId = (name, module) => module.id || (module.id = name.replaceAll(/[^a-zA-Z_]/g, '_') + "_" + Math.random().toString(36).slice(2, 6));

	const importModule = (name, module) => {
		let tmpCounter = 0;
		module.transformed = parseModule(module.code, {
			runtimeImportFunc: 'require',
			exports: name !== entryName && allowCircularImport ? 'exports' : '__mod_'+moduleId(name, module),
			resolveModule(r, {type} = {}) {
				let special = r.lastIndexOf('?');
				if (special > 0) {
					type = r.slice(special+1);
					r = r.slice(0, special);
				}

				const path = resolve(r, name);
				if (path == null) throw new ParseError('Module not found: '+r, name);

				const module = modules.get(path);
				dependOn(path, module);

				if (module.code) {
					if (type === 'text') {
						module.text = true;
						return `__mod_${moduleId(path, module)}.__text`;
					}

					module.script = true;
					return `__mod_${moduleId(path, module)}`;
				}

				if (type) throw new ParseError("External module does not support type assertion");
				return `require(${quote(path)})`;
			},
			nextTmp: () =>'__tmp' + (tmpCounter++)
		});
	};

	entry.script = true;
	importModule(entryName, entry);

	let prefix, code = '';

	if (allowCircularImport) {
		throw new Error("Not implemented yet");
	} else {
		prefix = [];
		for (let name of [...loadOrder].reverse()) {
			const module = modules.get(name);
			if (module.code) {
				prefix.push(module.id);
				if (prettify) code += '// '+name+'\n';
				if (module.script) {
					code += '(()=>{\n'+prettifier(module.transformed, prettify).trim()+'\n})();\n';
				}
				if (module.text) {
					code += "__mod_"+module.id+".__text="+quote(module.code)+";\n";
				}
			}
		}
		prefix = 'const '+prefix.map(id => "__mod_"+id+"={}").join(",")+";\n";
	}

	return {
		bundle: prefix + code,
		exports: '__mod_'+entry.id,
		externalModules
	}
}

/**
 *
 * @param bundle
 * @param exports
 * @param externalModules
 * @param {string|null} moduleNamespace
 * @param {("wasm"|"net"|"storage")[]} modulePermissions
 * @returns {string}
 */
function generateWorkerCode({bundle, exports, externalModules}, moduleNamespace, modulePermissions) {
	return [
		loader_template.replace("AA", `new Set(${JSON.stringify(externalModules)}),${JSON.stringify(moduleNamespace)},new Set(${modulePermissions?JSON.stringify(modulePermissions):""})`).replace("BB", exports),
		bundle,
		'postMessage({ready:1});'
	].join('\n');
}

function createWorker(workerJs) {
	const blob = new Blob([workerJs], {type: 'application/javascript'});
	const url = URL.createObjectURL(blob);
	const w = new Worker(url);
	URL.revokeObjectURL(url);
	return w;
}

/**
 *
 * @param {ReadonlyMap<string, Module>} modules
 * @param {string} entryModule
 * @param {string=} workerCode
 * @returns {SafeModule}
 */
export function createModule(modules, entryModule, workerCode) {
	if (!workerCode) {
		const bundleResult = bundle(modules, entryModule);
		workerCode = generateWorkerCode(bundleResult);
	}
	const worker = createWorker(workerCode);

	let rpcId = 0;
	const rpcTasks = new Map();
	let readyOk, readyFail;
	const ready = new Promise((resolve, reject) => { readyOk = resolve; readyFail = reject; });

	const post = worker.postMessage.bind(worker);
	worker.onmessage = ({data}) => {
		if (data.ready) { readyOk(); return; }
		const id = data.id;
		if (data.func) {
			const resolve = (v) => post({id, value: v});
			const reject = (e) => post({id, error: e && e.message || String(e)});

			const fn = modules.get(data.module)?.module[data.func];
			if (!fn) { reject('Export not found: '+data.name); return; }

			try {
				const result = fn.apply(null, data.args);
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
				task[1](new Error(data.error));
			} else {
				task[0](data.value);
			}
		}
	};

	let destroyed = false;
	const onError = (e) => {
		const err = new Error(e.message || 'Worker error');
		rpcTasks.forEach((p) => p[1](err));
		rpcTasks.clear();
		if (!destroyed) readyFail(e);
		destroyed = true;
	};
	worker.onerror = onError;

	let handler = {
		get(stub, name) {
			if (typeof name !== 'string') return;
			return stub[name] || (stub[name] = (...args) => {
				if (destroyed) return Promise.reject(new Error('Worker destroyed'));

				return new Promise((resolve, reject) => {
					rpcTasks.set(++rpcId, [resolve, reject]);
					post({id: rpcId, func: name, args});
				})
			});
		}
	};

	return {
		ready,
		module: new Proxy({}, handler),
		destroy: () => {
			worker.terminate();
			destroyed = true;
			onError('Worker destroyed');
		}
	};
}

export function bundleModule(modules, entryModule, namespace, permissions) {
	const result = bundle(modules, entryModule);
	return generateWorkerCode(result, namespace, permissions);
}


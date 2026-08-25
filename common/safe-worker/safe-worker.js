/**
 * safe-worker
 * Safe ESM WebWorker sandbox in 10 KiB (minified).
 */
import SandboxWorker from './worker/sandbox.js?worker';

/**
 * @typedef {Object} ModuleResolver
 * @property {string} exports
 * @property {(output: string[], tokens: string[]) => void} [runtimeImportFunc]
 * @property {(output: string[], tokens: string[]) => void} [importMeta]
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
	SPACE = new Set(' \t\r\n'),
	IDENT_START = /[a-zA-Z_$]/,
	IDENT_PART = /[a-zA-Z\d_$]/,
	DIGIT = /\d/,
	OPERATORS = /=>|===|!==|\.\.\.|&&|\|\||\?[?.]|(?:<<|>>>?|\*\*|[-+*/%><!=])=?/y;

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

	let prevTokenIndex = 0, prevIndex = 0;

	if (code.startsWith("#!")) {
		prevIndex = pos = code.indexOf('\n');
		if (pos < 0) return tokens;
	}

	const parseDescents = (re, initDepth = 0) => {
		const outLen = tokens.length;
		const prevInStmt = inStmt;
		const prevDepth = depth;
		inStmt = re;
		depth = initDepth;
		parse();
		depth = prevDepth;
		inStmt = prevInStmt;
		return outLen;
	};

	const beforeMutate = (start) => {
		if (inStmt) return;
		tokens.length = prevTokenIndex;
		const str = code.slice(prevIndex, start);
		if (str) tokens.push(str);
	};

	const afterMutate = () => {
		if (inStmt) return;
		prevTokenIndex = tokens.length;
		prevIndex = pos;
	};

	const parse = () => {
		while (pos < len) {
			const ch = code[pos];

			// ---- Whitespace ----
			if (SPACE.has(ch)) { pos++; continue; }

			// ---- Comment ----
			if (ch === '/') {
				if (code[pos + 1] === '/') {
					pos = code.indexOf('\n', pos+1)+1;
					if (pos < 1) {
						pos = len;
						break;
					}
					continue;
				}

				if (code[pos + 1] === '*') {
					pos = code.indexOf('*/', pos+1)+2;
					if (pos < 2) {
						pos = len;
						break;
					}
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
						tokens.length = parseDescents(/}/, 1);
					}
				}

				tokens.push(code.slice(start, pos));
				continue;
			}

			// ---- Number literal ----
			if (DIGIT.test(ch) || (ch === '.' && DIGIT.test(code[pos + 1]))) {
				const start = pos;

				while (/[0-9_.]/.test(code[pos])) pos++;

				let c1 = code[pos];
				if (/[xob]/i.test(c1)) {
					pos++;
					while (/[0-9a-fA-F]/.test(code[pos])) pos++;
				} else if (c1 === 'e' || c1 === 'E') {
					c1 = code[pos++];
					if (c1 === '+' || c1 === '-') pos++;
					while (/[0-9.]/.test(code[pos])) pos++;
				}
				if (code[pos] === 'n') pos++;

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

				const ERR = () => {throw new ParseError('Only top-level import/export allowed (or not end with semicolon)');};

				if (tokens.at(-1) !== '.')

				if (identifier === 'import') {
					while (pos < len && SPACE.has(code[pos])) pos++;

					beforeMutate(start);

					// import.meta
					if (code[pos] === '.') {
						const importMeta = ctx.importMeta;
						pos++;
						const outLen = parseDescents({ test() {return true;} });
						const statement = tokens.splice(outLen);
						if (importMeta && statement[0] === 'meta') importMeta(tokens, statement);
						else tokens.push('undefined.', ...statement);
						afterMutate();
						continue;
					}
					if (code[pos] === '(') {
						const outLen = parseDescents(/\)/);
						const statement = tokens.splice(outLen);
						parseDynamicImport(statement, tokens, ctx);
						afterMutate();
						continue;
					}

					// Actually we SUPPORT but not ALLOW it...
					if (depth || inStmt) {
						if (code[pos] === '{' || IDENT_START.test(code[pos]))
							ERR();
						tokens.push('undefined');
					} else {
						const func = ctx.runtimeImportFunc;
						if (!func) throw new ParseError('import() is not supported');
						const outLen = parseDescents(/;/);
						const statement = tokens.splice(outLen);
						parseImport(statement, tokens, ctx);
					}
					afterMutate();
					continue;
				} else

				if (identifier === 'export') {
					while (pos < len && SPACE.has(code[pos])) pos++;

					beforeMutate(start);

					if (depth || inStmt) {
						if (code[pos] === '{' || IDENT_START.test(code[pos]))
							ERR();
						tokens.push('undefined');
					}

					const outLen = parseDescents(/[};]/);
					const statement = tokens.splice(outLen);
					parseExport(statement, tokens, ctx);
					afterMutate();
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

			pos++;
			tokens.push(ch);

			// Single character — track depth
			if (ch === '{' || ch === '(' || ch === '[') depth++;
			else if (ch === '}' || ch === ')' || ch === ']') {
				if (--depth < 0) throw new Error("Invalid syntax at "+code.slice(0, pos));
			}

			if (!depth && inStmt?.test(ch)) break;
		}
	};

	parse();

	beforeMutate(pos);
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
	func(output, tokens);
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
		//if (type !== 'text') throw new ParseError("Only text assertion is supported now");

		{
			if (namespace || namedImport) throw new ParseError('cannot use namespace or named import with type assertion');

			const text = ctx.resolveModule(moduleName, {type});
			if (text == null) throw new ParseError('Module "'+moduleName+'" has no assertion content');

			if (defaultImport) emit(`const ${defaultImport} = ${text};`);
			else emit(`/* text import: ${moduleName} */`);
		}

		EXCEPT("}");
	} else {
		const module = ctx.resolveModule(moduleName);

		if (namespace || defaultImport || namedImport) {
			const tmp = namespace || ctx.nextTmp();

			emit(`const ${tmp} = ${module};`);

			const imports = [ ...namedImport || [] ];

			if (defaultImport) {
				imports.push(['default', defaultImport]);
				emit(`let ${defaultImport} = ${tmp}.default;`);
			}
			if (namedImport) {
				emit(`let ${namedDestruct(namedImport)} = ${tmp};`);
			}

			if (imports.length > 0) {
				let str = '';
				for (const [name, alias] of imports) {
					str += `${alias} = ${tmp}.${name};\n`;
				}

				emit(`__onload(${JSON.stringify(moduleName)}, () => {${str}});`);
			}
		} else {
			emit(module+';');
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
			if (name === '*') name = tokens[++i];
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
				if (token !== 'const') {
					emit(`Object.defineProperty(${field}, ${JSON.stringify(name)}, { get: () => ${name}, set: () => false });`);
				} else {
					emit(`${field}.${name} = ${name};`);
				}
			}
		} else {
			let j = i+1;
			if (token === 'async') j++;
			if (tokens[j] === '*') j++;

			const name = tokens[j];
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
		else if (token === '{' || token === '[' || token === '(') {depth++;}
		else if (token === '}' || token === ']' || token === ')') {depth--;}
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
const namedDestruct = specifiers => `{ ${specifiers.map(([name, alias]) => name === alias ? name : `${name}: ${alias}`).join(', ')} }`;
//endregion

/**
 *
 * @param {string} path
 * @param {string} code
 * @param {boolean} prettifyCode
 * @returns {string}
 */
function bundleModule(path, code, prettifyCode = true) {
	let temp = 0;
	let exportUsed, metaUsed = '';
	const tokens = parseModule(code, {
		get exports() {
			exportUsed = 1;
			return "exports";
		},
		importMeta(output, tokens) {
			tokens.shift();
			output.push("__meta", ...tokens);
			metaUsed = 'const __meta = {url:"file://"+__moduleId};\n';
		},
		runtimeImportFunc(output, tokens) {
			output.push('require', '(', '__moduleId', ',', ...tokens.slice(1));
		},
		nextTmp() {
			return "__tmp_"+temp++;
		},
		resolveModule(name, {type} = {}) {
			if (type) {
				return `(await require(__moduleId, ${JSON.stringify(name)}, { with: { type: ${JSON.stringify(type)} }})).default`;
			} else {
				return `await require(__moduleId, ${JSON.stringify(name)})`;
			}
		},
	});
	let out = prettifier(tokens, prettifyCode);

	return `const __moduleId=${JSON.stringify(path)};\n`+metaUsed+out;
}

/**
 * 创建沙盒和RPC组件
 * @param {function('load' | 'exec' | string, any[], Transferable[]): any|Promise<any>} rpcHandler
 * @param {function(string): void} logHandler
 * @param {string} [name]
 * @returns {[Function, Function]}
 */
export function createWorker(rpcHandler, logHandler, name) {
	const worker = new SandboxWorker({name});
	const post = worker.postMessage.bind(worker);

	let rpcId = 0;
	const rpcTasks = new Map();

	/**
	 * Send a request to the Worker thread and wait for the result.
	 * @param {string} method
	 * @param {any} args
	 * @param {ArrayBuffer[]=} transfer
	 * @returns {Promise<any>}
	 */
	const RPC = (method, args, transfer) => new Promise((resolve, reject) => {
		if (destroyed) return Promise.reject(destroyed);
		const id = ++rpcId;
		rpcTasks.set(id, [resolve, reject]);
		post({id, method, args}, transfer || {});
	});

	worker.onmessage = ({data}) => {
		if ('log' in data) return logHandler(data.log);

		const id = data.id;
		const method = data.method;
		if (method) {
			const transfer = [];
			const resolve = (v) => post({id, value: v}, transfer);
			const reject = (e) => post({id, error: e});

			try {
				const result = rpcHandler(method, data.args, transfer);
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
				task[1](data.error);
			} else {
				task[0](data.value);
			}
		}
	};

	/** @type {undefined|Error} */
	let destroyed;
	const onError = (e) => {
		destroyed = new Error(e.message || String(e) || 'Worker error');
		rpcTasks.forEach((p) => p[1](destroyed));
		rpcTasks.clear();
	};
	worker.onerror = onError;

	return [
		RPC,
		(e) => {
			worker.terminate();
			onError(e||'Worker destroyed');
		}
	]
}

/**
 *
 * @param {Object} handlers - 外部可实时更新不需要重启沙盒的 handlers
 * @param {function(string, boolean): string|Promise<string>} handlers.load - 模块文件加载器
 * @param {function(string, any[], Transferable[]): any|Promise<any>} [handlers.rpc] - 文件系统 RPC 提供者
 * @param {function(string): void} handlers.log - 控制台打印处理程序
 * @param {string[]} permissions - 脚本权限
 * @param {string} [prefix] - 数据库允许使用的命名空间前缀
 * @param {ReadonlyMap<string, Record<string, Function>>} [hostModules] - 主机侧模块
 * @param name
 * @returns {Sandbox}
 */
export function createSandbox(
	handlers,
	permissions,
	{
		prefix,
		hostModules,
		name
	} = {}
) {

	const [RPC, destroy] = createWorker(async (method, data, transfer) => {
		if (method === 'load') {
			const [name, type, isSystemModule] = data;
			const code = await handlers.load(name, isSystemModule);
			return type ? code : bundleModule(name, code, !isSystemModule);
		} else if (method === 'exec') {
			const [mod, func, args] = data;
			const fn = hostModules.get(mod)?.[func];
			if (!fn) throw new Error('Export not found: '+mod+"::"+func);
			return fn.apply(null, args);
		}

		const rpc = handlers.rpc;
		if (rpc) return rpc(method, data, transfer);
		else throw new Error('RPC endpoint not found');
	}, (log) => handlers.log(log), name);

	let initialized
	const initialize = () => {
		if (initialized) return;
		initialized = true;
		return RPC('init', [
			permissions,
			hostModules && [...hostModules.keys()],
			prefix
		]);
	};

	const loadModule = async (moduleName) => {
		const exported = new Set(await RPC('load', [
			moduleName,
			bundleModule(moduleName, await handlers.load(moduleName))
		]));

		return new Proxy(Object.create(null), {
			get(stub, name) {
				if (!exported.has(name)) return;
				return stub[name] || (stub[name] = (...args) => RPC('call', [moduleName, name, args]));
			}
		});
	};

	const execute = (moduleName, code, env) => RPC('eval', [
		moduleName,
		bundleModule(moduleName, code),
		env
	]);

	return {
		initialize,
		loadModule,
		execute,
		destroy
	};
}

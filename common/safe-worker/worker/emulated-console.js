
const counters = new Map();
const timers = new Map();
let groupIndent = 0;

const perf = performance;
const toString = Object.prototype.toString;
const isPureObject = object => toString.call(object) === "[object Object]";
const formatArgs = args => args.map(stringify).join(' ');
const indent = () => '  '.repeat(groupIndent);

const stringify = arg => {
	const type = typeof arg;

	if (type === 'symbol') {
		return arg.toString();
	}
	if (type === 'object') {
		if (arg instanceof Error) {
			return arg.stack || (arg.name + ': ' + arg.message);
		}
		if (isPureObject(arg)) {
			return JSON.stringify(arg);
		}

		if (arg && typeof arg.length === 'number' && arg.buffer instanceof ArrayBuffer) {
			return inspectTypedArray(arg);
		}
	} else {
		if (type === 'bigint') return arg.toString() + 'n';
		if (type === 'function') return '[Function: ' + (arg.name || 'anonymous') + ']';
	}

	try {
		return String(arg);
	} catch {
		return toString.call(arg);
	}
};

/**
 * 将 TypedArray 格式化为类似 Buffer 的短字符串
 * @param {ArrayBufferView} typedArray - 任意 TypedArray 实例
 * @param {number} [max=50] - 前后最多展示的字节数（默认50）
 * @returns {string} 格式如 "<Uint8Array 01 02 03 ... 10 more bytes ... fe ff>"
 */
function inspectTypedArray(typedArray, max = 50) {
	// 取得底层字节数组
	const bytes = new Uint8Array(
		typedArray.buffer,
		typedArray.byteOffset,
		typedArray.byteLength
	);
	const typeName = typedArray.constructor.name;
	const length = bytes.length;
	// 辅助：将字节数组转为空格分隔的十六进制字符串
	const toHex = (arr) =>
		Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join(' ');
	if (length <= max * 2) {
		// 小于阈值，显示全部字节
		return `<${typeName} ${toHex(bytes)}>`;
	}
	// 超过阈值，只显示首尾 max 个字节
	const front = toHex(bytes.slice(0, max));
	const back = toHex(bytes.slice(-max));
	const more = length - max * 2;
	return `<${typeName} ${front} ... ${more} more bytes ... ${back}>`;
}

export const emulateConsole = (postMessage) => {
	const writePrefix = (prefix) => (...args) => postMessage({log: indent() + prefix + formatArgs(args)});

	const console = {
		log: writePrefix(''),
		warn: writePrefix('[WARN] '),
		error: writePrefix('[ERROR] '),
		info: writePrefix('[INFO] '),
		debug: writePrefix('[DEBUG] '),
		trace(...args) {
			const stack = new Error().stack;
			const trace = stack ? stack.split('\n').slice(2).join('\n') : '';
			postMessage({log: indent() + '[TRACE] ' + formatArgs(args) + '\n' + trace});
		},
		assert(condition, ...args) {
			if (!condition) {
				const msg = args.length ? formatArgs(args) : 'Assertion failed';
				postMessage({log: indent() + '[ASSERT] ' + msg});
			}
		},
		count(label) {
			label = label || 'default';
			const n = (counters.get(label) || 0) + 1;
			counters.set(label, n);
			postMessage({log: indent() + label + ': ' + n});
		},
		countReset(label) {
			counters.delete(label || 'default');
		},
		dir(item, options) {
			postMessage({log: stringify(item)});
		},
		group(...args) {
			if (args.length) {
				postMessage({log: indent() + '▶ ' + formatArgs(args)});
			}
			groupIndent++;
		},
		groupEnd() {
			if (groupIndent > 0) groupIndent--;
		},
		table(tabularData, properties) {
			if (!tabularData) {
				postMessage({log: indent() + stringify(tabularData)});
				return;
			}

			if (Array.isArray(tabularData)) {
				if (tabularData.length === 0) {
					postMessage({log: indent() + '┌ (empty array)\n' + indent() + '└'});
					return;
				}
				const first = tabularData[0];
				if (typeof first !== 'object' || first === null) {
					// Primitive array - show index: value
					let output = '';
					const maxIdx = String(tabularData.length - 1).length;
					for (let i = 0; i < tabularData.length; i++) {
						output += indent() + '│ ' + String(i).padStart(maxIdx) + ' │ ' + stringify(tabularData[i]) + '\n';
					}
					output = indent() + '┌─' + '─'.repeat(maxIdx) + '─┼──────\n' + output + indent() + '└─' + '─'.repeat(maxIdx) + '─┴──────';
					postMessage({log: output});
					return;
				}
				const keys = properties || Object.keys(first);
				const rows = [keys, ...tabularData.map(row => keys.map(k => stringify(row[k])))];
				const colWidths = keys.map((_, ci) =>
					Math.max(...rows.map(r => String(r[ci] || '').length))
				);

				let output = '';
				const top = indent() + '┌' + colWidths.map(w => '─'.repeat(w + 2)).join('┬') + '┐\n';
				const sep = indent() + '├' + colWidths.map(w => '─'.repeat(w + 2)).join('┼') + '┤\n';
				const bot = indent() + '└' + colWidths.map(w => '─'.repeat(w + 2)).join('┴') + '┘';

				const fmtRow = row => indent() + '│ ' + row.map((v, i) => String(v || '').padEnd(colWidths[i])).join(' │ ') + ' │\n';

				output = top + fmtRow(keys) + sep;
				for (const row of tabularData) {
					output += fmtRow(keys.map(k => stringify(row[k])));
				}
				output += bot;
				postMessage({log: output});
			} else if (typeof tabularData === 'object') {
				const entries = Object.entries(tabularData);
				if (entries.length === 0) {
					postMessage({log: indent() + '┌ (empty object)\n' + indent() + '└'});
					return;
				}
				const vals = entries.map(([k, v]) => [stringify(k), stringify(v)]);
				const maxKey = Math.max(...vals.map(r => r[0].length));
				const maxVal = Math.max(...vals.map(r => r[1].length));

				const top = indent() + '┌' + '─'.repeat(maxKey + 2) + '┬' + '─'.repeat(maxVal + 2) + '┐\n';
				const sep = indent() + '├' + '─'.repeat(maxKey + 2) + '┼' + '─'.repeat(maxVal + 2) + '┤\n';
				const bot = indent() + '└' + '─'.repeat(maxKey + 2) + '┴' + '─'.repeat(maxVal + 2) + '┘\n';

				let output = top;
				for (const [k, v] of vals) {
					output += indent() + '│ ' + k.padEnd(maxKey) + ' │ ' + v.padEnd(maxVal) + ' │\n';
				}
				output += bot;
				postMessage({log: output});
			} else {
				this.dir(tabularData);
			}
		},
		time(label) {
			timers.set(label || 'default', perf.now());
		},
		timeEnd(label) {
			label = label || 'default';
			const start = timers.get(label);
			if (start === undefined) {
				postMessage({log: indent() + '[TIME] ' + label + ': timer not started'});
				return;
			}
			timers.delete(label);
			postMessage({log: indent() + label + ': ' + (perf.now() - start).toFixed(3) + ' ms'});
		},
		timeLog(label) {
			label = label || 'default';
			const start = timers.get(label);
			if (start === undefined) {
				postMessage({log: indent() + '[TIME] ' + label + ': timer not started'});
				return;
			}
			postMessage({log: indent() + label + ': ' + (perf.now() - start).toFixed(3) + ' ms'});
		},
		profile(label) {
			// No-op
		},
		profileEnd(label) {
			// No-op
		},
		timeStamp(label) {
			postMessage({log: indent() + '[TIMESTAMP] ' + (label || '') + ': ' + perf.now().toFixed(3) + ' ms'});
		},
	};
	console.dirxml = console.dir;
	console.groupCollapsed = console.group;
	// No-op in sandbox
	console.clear = console.profile = console.profileEnd = () => {};

	return [console, () => {
		counters.clear();
		timers.clear();
		groupIndent = 0;
	}]
}
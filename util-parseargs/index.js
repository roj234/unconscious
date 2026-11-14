export class ParseArgsError extends Error {
	constructor(message) {
		super(message);
		this.name = 'ParseArgsError';
	}
}

const BOOLEAN = 'boolean';
const STRING = 'string';

/**
 * @param {string} name
 * @param {string} raw
 */
const parseBoolean = (name, raw) => {
	if (/^(?:yes|true)$/i.test(raw)) return true;
	if (/^(?:no|false)$/i.test(raw)) return false;
	throw new ParseArgsError(`选项 '--${name}' 只接受布尔值`);
};

/**
 * @param {ParseArgsOptions} [options]
 */
function parseOptions(options = {}) {
	const longs = new Map();
	const shorts = new Map();
	const list = [];

	for (const [name, raw] of Object.entries(options)) {
		// `{ verbose: 'boolean' }`
		const def = typeof raw === 'string' ? { type: raw } : { ...raw };

		def.name = name;
		def.type ??= BOOLEAN;

		const short = def.short;
		if (short !== undefined) {
			if (short.length !== 1) throw new TypeError(`option '${name}' 的 short 必须是单个字符`);
			if (short === '-' || short === '=') throw new TypeError(`option '${name}' 的 short 不能是 '-' 或 '='`);
			if (shorts.has(short)) throw new TypeError(`短选项 '-${short}' 被 '${shorts.get(short)}' 和 '${name}' 重复定义`);
			shorts.set(short, name);
		}

		longs.set(name, def);
		list.push(def);
	}

	return { longs, shorts, list };
}

/**
 * @param {string[]} [args]
 * @param {ParseArgsOptions} [options]
 * @return {{positionals: string[], values: Record<string, boolean | string | string[]>}}
 */
export const parseArgs = ({ args = process.argv.slice(2), options } = {}) => {
	const { longs, shorts, list } = parseOptions(options);

	const values = Object.create(null);
	const provided = new Set();
	const positionals = [];
	let i = 0;

	const setValue = (def, value) => {
		provided.add(def.name);
		if (def.multiple) {
			(values[def.name] ??= []).push(value);
		} else {
			values[def.name] = value;
		}
	};

	/**
	 * raw 为 undefined 表示「没给值」，空串表示「给了空值」，两者不能混为一谈。
	 * @param {string} name
	 * @param {string | undefined} raw
	 */
	const setOpt = (name, raw) => {
		const opt = longs.get(name);

		if (opt.type === BOOLEAN) {
			setValue(opt, raw === undefined ? true : parseBoolean(name, raw));
			return;
		}

		if (raw === undefined) throw new ParseArgsError(`选项 '--${name}' 缺少值`);
		setValue(opt, raw);
	};

	while (i < args.length) {
		const arg = args[i];

		if (arg === '--') {
			positionals.push(...args.slice(i + 1));
			break;
		}

		// 单独的 '-' 也算位置参数（常见的 stdin 占位）
		if (typeof arg !== 'string' || arg.length < 2 || arg[0] !== '-') {
			positionals.push(arg);
			i++;
			continue;
		}

		if (arg[1] !== '-') {
			// 短选项：`-v` / `-v=yes` / `-o out` / `-oout`
			const ch = arg[1];
			const name = shorts.get(ch);
			if (!name) throw new ParseArgsError(`未知选项 '-${ch}'`);

			const opt = longs.get(name);
			let raw = arg.slice(2);
			if (raw !== '') {
				if (raw[0] === '=') raw = raw.slice(1);
			} else if (opt.type !== BOOLEAN) {
				raw = args[++i];
			} else {
				raw = undefined;
			}

			setOpt(name, raw);
			i++;
			continue;
		}

		// 长选项：`--flag` / `--flag=yes` / `--opt value` / `--no-flag`
		const body = arg.slice(2);
		const eq = body.indexOf('=');
		let name = eq === -1 ? body : body.slice(0, eq);

		let negate = false;
		if (!longs.has(name) && name.startsWith('no-')) {
			name = name.slice(3);
			negate = true;
		}

		const opt = longs.get(name);
		if (!opt || (negate && opt.type !== BOOLEAN)) {
			throw new ParseArgsError(`未知选项 '--${negate ? `no-${name}` : name}'`);
		}

		// eq === -1 时不能再 slice(eq + 1)，那会切出整个 body 当成值
		let raw;
		if (eq !== -1) raw = body.slice(eq + 1);
		else if (opt.type !== BOOLEAN) raw = args[++i];

		if (negate) {
			if (raw !== undefined) throw new ParseArgsError(`反转布尔选项 '--no-${name}' 不接受值`);
			setValue(opt, false);
		} else {
			setOpt(name, raw);
		}

		i++;
	}

	for (const def of list) {
		if (provided.has(def.name)) continue;
		if (def.multiple) {
			values[def.name] = Array.isArray(def.default) ? def.default.slice() : [];
		} else if (def.default !== undefined) {
			values[def.name] ??= def.default;
		}
	}

	return { values, positionals };
};

const formatLabel = def => `${def.short ? `-${def.short}, ` : '    '}--${def.name}${def.type === STRING ? ` <${def.type}>` : ''}`;

const formatDesc = def => {
	const parts = [];
	if (def.description) parts.push(def.description);
	if (def.multiple) parts.push('(可重复)');
	if (def.default !== undefined) parts.push(`(默认: ${JSON.stringify(def.default)})`);
	return parts.join(' ');
};

/**
 *
 * @param {ParseArgsOptions} options
 * @param {string} [usage]
 * @param {string} [description]
 * @return {string}
 */
export const formatHelp = (options, { usage, description } = {}) => {
	const { list } = parseOptions(options);
	const rows = list.map((def) => ({ label: formatLabel(def), desc: formatDesc(def) }));
	if (rows.length === 0) rows.push({ label: '', desc: '(无可用选项)' });

	const width = Math.max(...rows.map((row) => row.label.length));
	const lines = [];

	if (description) lines.push(description, '');
	lines.push(`Usage: ${usage ?? '<命令> [选项]'}`);
	lines.push('', 'Options:');
	for (const row of rows) {
		lines.push(`  ${row.label.padEnd(width)}  ${row.desc}`.trimEnd());
	}
	return lines.join('\n');
};

export class ParseArgsError extends Error {
	constructor(message) {
		super(message);
		this.name = 'ParseArgsError';
	}
}

const BOOLEAN = 'boolean';
const STRING = 'string';

/**
 * @param {ParseArgsOptions} options
 */
function parseOptions(options) {
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
 * @param {ParseArgsOptions} options
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

	const setOpt = (name, value, negate) => {
		let opt = longs.get(name);

		if (opt.type === BOOLEAN) {
			if (!value) {
				setValue(opt, !negate);
			} else {
				if (/(yes|true)/i.test(value)) setValue(opt, true);
				else if (/(no|false)/i.test(value)) setValue(opt, false);
				else throw new ParseArgsError(`选项 '--${name}' 只接受布尔值'`);
			}
		} else {
			if (!value) throw new ParseArgsError(`选项 '${name}' 缺少值`,);
			setValue(opt, value);
		}
	};

	while (i < args.length) {
		const arg = args[i];

		if (arg[0] === '-') {
			const ch = arg[1];
			if (ch !== '-') {
				if (arg.length > 1) {
					const name = shorts.get(ch);
					if (!name) throw new ParseArgsError(`未知选项 '-${ch}'`);
					let rest = arg.slice(1);
					if (!rest) {
						if (longs.get(name).type !== BOOLEAN) {
							rest = args[++i];
						}
					} else {
						if (rest[0] === '=') rest = rest.slice(1);
					}
					setOpt(name, rest, false);
					continue;
				}
			} else if (arg.length > 2) {
				const body = arg.slice(2);
				const eq = body.indexOf('=');
				let name = eq === -1 ? body : body.slice(0, eq);

				let negate;
				if (!longs.has(name) && name.startsWith('no-')) {
					name = name.slice(3);
					negate = true;
				}

				let opt = longs.get(name);
				if (!opt || (negate && opt.type !== BOOLEAN)) throw new ParseArgsError(`未知选项 '--${name}'`);

				let value = eq === -1 && opt.type !== BOOLEAN ? args[++i] : body.slice(eq + 1);
				if (negate && value) throw new ParseArgsError(`反转布尔选项 '--no-${name}' 不接受值`);

				setOpt(name, value, negate);
				continue;
			} else {
				positionals.push(...args.slice(i + 1));
				break;
			}
		}

		positionals.push(arg);
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

const sep = '/';
const delimiter = ':';

const isAbsolute = p => p[0] === '/' || p === '~' || p.startsWith("~/");

function basename(p, ext) {
	let end = p.length;
	while (end > 0 && p[end - 1] === '/') end--;
	if (end === 0) return '';
	const i = p.lastIndexOf('/', end - 1);
	let base = i === -1 ? p.slice(0, end) : p.slice(i + 1, end);
	if (ext && base.endsWith(ext)) base = base.slice(0, -ext.length);
	return base;
}

function dirname(p) {
	let end = p.length;
	while (end > 0 && p[end - 1] === '/') end--;
	if (end === 0) return isAbsolute(p) ? '/' : '.';
	const trimmed = p.slice(0, end);
	const i = trimmed.lastIndexOf('/');
	if (i === -1) return isAbsolute(p) ? '/' : '.';
	if (i === 0) return '/';
	return trimmed.slice(0, i);
}

function extname(p) {
	const base = basename(p);
	if (base === '.' || base === '..') return '';
	const i = base.lastIndexOf('.');
	return i <= 0 ? '' : base.slice(i);
}

function normalize(p) {
	if (p === '') return '.';
	const isAbs = isAbsolute(p);
	const trailing = p.endsWith('/') ? '/' : '';
	const parts = p.split('/').filter(s => s !== '' && s !== '.');
	const stack = [];
	for (const part of parts) {
		if (part === '..') {
			if (stack.length > 0 && stack[stack.length - 1] !== '..') {
				stack.pop();
			} else if (!isAbs) {
				stack.push('..');
			}
		} else {
			stack.push(part);
		}
	}
	let res = stack.join('/');
	if (isAbs) res = '/' + res;
	if (!res) res = isAbs ? '/' : '.';
	if (trailing && res !== '/') res += '/';
	return res;
}

function join(...paths) {
	if (paths.length === 0) return '.';
	let joined = '.';
	for (const p of paths) {
		joined = isAbsolute(p) ? p : (joined ? joined + '/' + p : p);
	}
	return normalize(joined);
}

function resolve(...paths) {
	let resolved = './';
	for (const p of paths) {
		if (isAbsolute(p)) resolved = p;
		else resolved += (resolved.endsWith('/') ? '' : '/') + p;
	}
	return normalize(resolved);
}

function relative(from, to) {
	from = resolve(from);
	to = resolve(to);
	const fromParts = from.split('/').filter(Boolean);
	const toParts = to.split('/').filter(Boolean);
	let i = 0;
	while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++;
	const ups = fromParts.slice(i).map(() => '..');
	const downs = toParts.slice(i);
	const result = ups.concat(downs).join('/');
	return result || '';
}

function parse(p) {
	const root = isAbsolute(p) ? '/' : '';
	const normalized = p.replace(/\/+$/, '');
	let base, dir;
	if (normalized === '') {
		dir = root;
		base = '';
	} else {
		const noRoot = root ? normalized.slice(1) : normalized;
		const idx = noRoot.lastIndexOf('/');
		if (idx === -1) {
			dir = root;
			base = noRoot;
		} else {
			dir = root + noRoot.slice(0, idx);
			base = noRoot.slice(idx + 1);
		}
	}
	const ext = extname(base);
	const name = base.slice(0, base.length - ext.length);
	return { root, dir, base, ext, name };
}

function format(obj) {
	if (obj.dir) return obj.dir + sep + (obj.base || '');
	if (obj.root) return obj.root + (obj.base || '');
	if (obj.name && obj.ext) return (obj.root || '') + obj.name + obj.ext;
	if (obj.name) return (obj.root || '') + obj.name;
	if (obj.ext) return (obj.root || '') + obj.ext;
	return obj.base || '';
}

export const emulatedPath = {
	sep,
	delimiter,
	isAbsolute,
	basename,
	dirname,
	extname,
	normalize,
	join,
	resolve,
	relative,
	parse,
	format
};
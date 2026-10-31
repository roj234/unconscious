
/**
 * picocolors 风格的最小实现：成对的 open/close 码，可嵌套，非 TTY 自动退化成纯文本。
 */
const COLOR_ENABLED = (() => {
	if (process.env.FORCE_COLOR != null) return process.env.FORCE_COLOR !== '0' && process.env.FORCE_COLOR !== 'false';
	if (process.env.NO_COLOR != null) return false;
	return !!process.stdout.isTTY && process.env.TERM !== 'dumb';
})();

const paint = (open, close) => s => (COLOR_ENABLED ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

export const colors = {
	reset: paint(0, 0),
	bold: paint(1, 22),
	dim: paint(2, 22),
	red: paint(31, 39),
	green: paint(32, 39),
	yellow: paint(33, 39),
	blue: paint(34, 39),
	magenta: paint(35, 39),
	cyan: paint(36, 39),
	gray: paint(90, 39),
};
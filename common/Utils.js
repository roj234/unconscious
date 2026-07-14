/*! FunEx next (beta)
 *  Author: Roj234 @ 2020 - 2024/7/15, All rights reserved
 */


//元素选择器
/**
 *
 * @param {string} selector
 * @param {HTMLElement=document} element
 * @returns {HTMLElement | null}
 */
export const G = (selector, element) => (element ?? document).querySelector(selector);
/**
 *
 * @param {string} selector
 * @param {HTMLElement=document} element
 * @returns {HTMLElement[]}
 */
export const A = (selector, element) => Array.from((element ?? document).querySelectorAll(selector));

//region 日期与时间

const txt_weekdays = "天一二三四五六";
const pad = (n, c) => String(n).padStart(c, "0");

export const formatDate = (format, stamp) => {
	if (null === stamp) return '-';
	const date = (null == stamp/*undefined*/ ? new Date() : new Date(stamp));
	const fmt = {
		// Year
		// 闰年
		L: () => {
			const y = fmt.Y();
			return (0 === (y & 3) && (y % 1e2 || 0 === (y % 4e2))) ? 1 : 0;
		},
		// 2012
		Y: () => date.getFullYear(),
		// 12
		y: () => String(fmt.Y()).slice(2),
		// Day
		j: () => date.getDate(),
		d: () => pad(fmt.j(), 2),
		// Week
		l: () => "星期"+txt_weekdays[fmt.w()],
		// 0-6星期
		w: () => date.getDay(),
		// 1-7
		N: () => fmt.w()+1,
		// Month
		n: () => date.getMonth()+1,
		m: () => pad(fmt.n(), 2),
		// 本月有几天
		t: () => {
			let n = date.getMonth()+1;
			if (n === 2) {
				return 28+fmt.L();
			} else {
				return (!!(n & 1)) === n < 8 ? 31 : 30;
			}
		},
		// Time
		// 小写
		a: () => date.getHours() > 11 ? "pm" : "am",
		// 大写
		A: () => fmt.a().toUpperCase(),
		// am/pm时间
		g: () => date.getHours() % 12 || 12,
		h: () => pad(fmt.g(), 2),
		G: () => date.getHours(),
		H: () => pad(fmt.G(), 2),
		i: () => pad(date.getMinutes(), 2),
		s: () => pad(date.getSeconds(), 2),
		// timezone offset 2
		O: () => {
			const tzoff = date.getTimezoneOffset();
			let t = pad(Math.abs(tzoff / 60 * 100), 4);
			return (tzoff > 0 ? "-" : "+")+t;
		},
		// timezone offset
		P: () => {
			const tzoff = fmt.O();
			return (tzoff.slice(0, 3)+":"+tzoff.slice(3, 2));
		},
		// UTC
		c: () => fmt.Y()+"-"+fmt.m()+"-"+fmt.d()+"T"+fmt.H()+":"+fmt.i()+":"+fmt.s()+fmt.P(),
		// Unix
		U: () => Math.round(date.getTime() / 1000)
	};

	return format.replace(/\\?([a-zA-Z])/g, (t, s) => t === s && fmt[s] ? fmt[s]() : s);
};

const times = [60, 1800, 3600, 86400, 604800];
const names = [" 秒", " 分", "半小时", " 小时", " 天"];
const factors = [60, 0, 60, 24, 7];

export const prettyTime = timestamp => {
	if (timestamp === 0) return "-";

	const now = Date.now();
	const diff = Math.abs((now - timestamp) / 1000);
	if (diff < 1) return "现在";

	let val = diff;
	let factor = 1;
	for (let i = 0; i < times.length; i++) {
		if (diff < times[i]) {
			let str = factor ? (Math.round(val) + names[i]) : names[i];
			str += now < timestamp ? '后' : '前';
			return str;
		}
		if ((factor = factors[i])) {
			val /= factors[i];
		}
	}
	return formatDate("Y-m-d H:i:s", timestamp);
};

//endregion

const SCALE = "KMGTPE";
export const formatSize = size => {
	if (isNaN(size)) return "NaN";
	let cap = 1n;
	let i = 0;
	while (i < SCALE.length) {
		const next = cap << 10n;
		if (next > size) break;
		cap = next;
		i++;
	}

	return (size / parseFloat(cap)).toFixed(i ? 2 : 0)+(SCALE[i-1]||'')+'B';
};
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
function G(selector, element){return (element??document).querySelector(selector);}
/**
 *
 * @param {string} selector
 * @param {HTMLElement=document} element
 * @returns {HTMLElement[]}
 */
function A(selector, element){return Array.from((element??document).querySelectorAll(selector));}

export {G, A}

//region 日期与时间
const parseSubRx = {
	"Y": ["(\\d{4})", "setFullYear"],
	"y": "(\\d{2})",

	"m": "(\\d{2})",
	"n": "(\\d{1,2})",

	"d": ["(\\d{2})", "setDate"],
	"j": ["(\\d{1,2})", "setDate"],

	"H": ["(\\d{2})", "setHours"],
	"i": ["(\\d{2})", "setMinutes"],
	"s": ["(\\d{2})", "setSeconds"],

	"c": "(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}[+-]\\d{2}:\\d{2})",
	"P": "([+-]\\d{2}:\\d{2})",
	"O": "([+-]\\d{4})",
	"U": "(\\d{0,20})"
};

const parseDate = function(pattern, date) {
	var _times = [];
	var id = 1;
	pattern = pattern.replace(/\\?([a-zA-Z])/g, (t, s, i) => {
		var px = parseSubRx[t];
		if (px) {
			_times.push({
				i: id++,
				type: t,
				func: px.sort && px[1]
			});
			return px.sort ? px[0] : px;
		}
		return s;
	});

	var rx = new RegExp("^" + pattern + "$").exec(date);

	if (rx == null) {
		throw new Error("Format error, expecting " + pattern);
	}

	date = new Date(0);

	var o = {};
	for (var j = 0; j < _times.length; j++) {
		var t = rx[_times[j].i];
		if (_times[j].func)
			date[_times[j].func](parseInt(t, 10));
		else
			o[_times[j].type] = t;
	}

	if (o.c !== undefined) {
		return strToTimeV2("Y-m-dTH:i:sP", o.c);
	} else if (o.U !== undefined) {
		date.setTime(parseInt(o.U, 10) * 1000);
	} else if (o.m !== undefined) {
		date.setMonth(parseInt(o.m, 10) - 1);
	} else if (o.n !== undefined) {
		date.setMonth(parseInt(o.n, 10) - 1);
	}

	return date;
}

var txt_weekdays = "天一二三四五六".split("");
const pad = (n, c) => String(n).padStart(c, "0");

const formatDate = (format, stamp) => {
	if (null === stamp) return '-';
	var date = (null == stamp/*undefined*/ ? new Date() : new Date(stamp));
	var fmt = {
		// Year
		// 闰年
		L: () => {
			var y = fmt.Y();
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
		l: () => "星期" + txt_weekdays[fmt.w()],
		// 0-6星期
		w: () => date.getDay(),
		// 1-7
		N: () => fmt.w() + 1,
		// Month
		n: () => date.getMonth() + 1,
		m: () => pad(fmt.n(), 2),
		// 本月有几天
		t: () => {
			var n;
			if ((n = date.getMonth() + 1) === 2) {
				return 28 + fmt.L();
			} else {
				n = 0 !== (n & 1);
				if (n && n < 8 || !n && n > 7) {
					return 31;
				} else {
					return 30;
				}
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
			var t = pad(Math.abs(date.getTimezoneOffset() / 60 * 100), 4);
			if (date.getTimezoneOffset() > 0) t = "-" + t;
			else t = "+" + t;
			return t;
		},
		// timezone offset
		P: () => {
			var tzoff = fmt.O();
			return (tzoff.slice(0, 3) + ":" + tzoff.slice(3, 2));
		},
		// UTC
		c: () => fmt.Y() + "-" + fmt.m() + "-" + fmt.d() + "T" + fmt.H() + ":" + fmt.i() + ":" + fmt.s() + fmt.P(),
		// Unix
		U: () => Math.round(date.getTime() / 1000)
	};

	return format.replace(/\\?([a-zA-Z])/g, (t, s) => t === s && fmt[s] ? fmt[s]() : s);
};

const tms = {
	60: " 秒前",
	1800: " 分前",
	3600: "半小时前",
	86400: " 小时前",
	604800: " 天前"
};
const factor = {
	60: 60,
	1800: 0,
	3600: 60,
	86400: 24,
	604800: 7
};

function prettyTime(timestamp) {
	if (timestamp === 0) return "-";

	var timeNow = Date.now();
	var diff = Math.abs((timeNow - timestamp) / 1000);
	if (diff < 1) return "现在";
	var val = diff;
	var flag = false;
	for (var i in tms) {
		if (diff < i) {
			var str = flag ? tms[i] : (Math.round(val) + tms[i]);
			if (timeNow < timestamp) str = str.replace("前", "后");
			return str;
		}
		if (factor[i] !== 0) {
			val /= factor[i];
			flag = false;
		} else {
			flag = true;
		}
	}
	return formatDate("Y-m-d H:i:s", timestamp);
}

export {formatDate, prettyTime, parseDate};
//endregion

const SCALE = ["B", "KB", "MB", "GB", "TB", "PB", "EB"];
function formatSize(size) {
	size = parseInt(size);
	if (isNaN(size)) return "NaN";
	var cap = 1n;
	var i = 0;
	for (;i < SCALE.length;) {
		var next = cap << 10n;
		if (next > size) break;

		cap = next;
		i++;
	}

	return (size / parseFloat(cap)).toFixed(i ? 2 : 0) + SCALE[i];
}

export {formatSize};
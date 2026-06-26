
const SAFE_SET = new Set((
	"Object\n" +
	"Array\n" +
	"Number\n" +
	"BigInt\n" +
	"parseFloat\n" +
	"parseInt\n" +
	"Infinity\n" +
	"NaN\n" +
	"isFinite\n" +
	"isNaN\n" +
	"undefined\n" +
	"Boolean\n" +
	"String\n" +
	"Symbol\n" +
	"globalThis\n" +
	// Binary
	"ArrayBuffer\n" +
	"Uint8Array\n" +
	"Int8Array\n" +
	"Uint16Array\n" +
	"Int16Array\n" +
	"Uint32Array\n" +
	"Int32Array\n" +
	"Float32Array\n" +
	"Float64Array\n" +
	"Uint8ClampedArray\n" +
	"BigUint64Array\n" +
	"BigInt64Array\n" +
	"DataView\n" +
	// Advanced APIs
	"name\n" +
	"close\n" +
	"onerror\n" +
	"console\n" +
	"structuredClone\n" +
	"atob\n" +
	"btoa\n" +
	"crypto\n" +
	"Function\n" +
	"Proxy\n" +
	"JSON\n" +
	"Math\n" +
	"Intl\n" +
	"Date\n" +
	"Promise\n" +
	"RegExp\n" +
	"Map\n" +
	"Set\n" +
	// Timers
	"setTimeout\n" +
	"setInterval\n" +
	"clearTimeout\n" +
	"clearInterval\n" +
	"queueMicrotask\n" +
	// GC
	"WeakMap\n" +
	"WeakSet\n" +
	"WeakRef\n" +
	"FinalizationRegistry\n" +
	// URI
	"URLSearchParams\n" +
	"URLPattern\n" +
	"URL\n" +
	"decodeURI\n" +
	"decodeURIComponent\n" +
	"encodeURI\n" +
	"encodeURIComponent\n" +
	"escape\n" +
	"unescape\n" +
	// Streams
	"WritableStream\n" +
	"TransformStream\n" +
	"TextEncoderStream\n" +
	"TextEncoder\n" +
	"TextDecoderStream\n" +
	"TextDecoder\n" +
	"DecompressionStream\n" +
	"CompressionStream\n" +
	"Blob\n" +
	"File\n" +
	"AbortController\n" +
	"AbortSignal\n"
).trim().split("\n"));
const FORBIDDEN = { value: undefined };

export const lockdown = (globals) => {
	const object = Object;
	let win = self;
	if (globals) {
		for (const key of object.keys(globals)) {
			SAFE_SET.add(key);
			object.defineProperty(win, key, { value: globals[key] });
		}
	}

	const stopAt = EventTarget.prototype;
	while (win !== stopAt) {
		for (const [name, {value, configurable}] of object.entries(object.getOwnPropertyDescriptors(win))) {
			if (!SAFE_SET.has(name) && configurable && !name.endsWith("Error")) {
				object.defineProperty(win, name, FORBIDDEN);
			} else if (value) {
				// not necessary actually (不过也没几个字节)
				// 这个主要是让代码行为可审计
				object.freeze(value.prototype);
			}
		}
		object.freeze(win);
		win = win.__proto__;
	}
};
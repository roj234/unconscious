
const SAFE_SET = new Set((
	`Object
Array
Number
BigInt
parseFloat
parseInt
Infinity
NaN
isFinite
isNaN
undefined
Boolean
String
Symbol
globalThis
` + // Binary
`ArrayBuffer
Uint8Array
Int8Array
Uint16Array
Int16Array
Uint32Array
Int32Array
Float32Array
Float64Array
Uint8ClampedArray
BigUint64Array
BigInt64Array
DataView
` + // Advanced APIs
`name
close
onerror
console
structuredClone
atob
btoa
crypto
Function
Proxy
JSON
Math
Intl
Date
Promise
RegExp
Map
Set
` + // Timers
`setTimeout
setInterval
clearTimeout
clearInterval
queueMicrotask
` + // GC
`WeakMap
WeakSet
WeakRef
FinalizationRegistry
` + // URI
`URLSearchParams
URLPattern
URL
decodeURI
decodeURIComponent
encodeURI
encodeURIComponent
escape
unescape
` + // Streams
`WritableStream
TransformStream
TextEncoderStream
TextEncoder
TextDecoderStream
TextDecoder
DecompressionStream
CompressionStream
Blob
File
AbortController
AbortSignal
` + // Audio
`AudioDecoder
EncodedAudioChunk
AudioData
OfflineAudioContext
AudioContext
AudioBuffer
`
).trim().split("\n"));
const FORBIDDEN = { value: undefined };
const origSetTimeout = setTimeout;
const origSetInterval = setInterval;
const hookFunction = function fn(code, ...params) {
	if (code === 'return this') return () => self;
	throw new Error('Function is disabled');
};

export const lockdown = (globals) => {
	const object = Object;
	let win = self;

	const overrides = {
		setTimeout(handler, timeout, ...args) {
			if (typeof handler !== 'function')
				throw new Error('handler must be a function');
			return origSetTimeout(handler, timeout, ...args);
		},
		setInterval(handler, timeout, ...args) {
			if (typeof handler !== 'function')
				throw new Error('handler must be a function');
			return origSetInterval(handler, timeout, ...args);
		},
		Function: hookFunction,
		...globals
	}

	for (const key of object.keys(overrides)) {
		SAFE_SET.add(key);
		object.defineProperty(win, key, { value: overrides[key] });
	}

	const killConstructor = (fn) => Object.defineProperty(fn.constructor.prototype, 'constructor', { value: hookFunction });
	killConstructor(Function);
	killConstructor((async () => {}));
	killConstructor((function*(){}));
	killConstructor((async function*(){}));

	const stopAt = EventTarget.prototype;
	const toFreeze = [];
	while (win !== stopAt) {
		for (const [name, {value, configurable}] of object.entries(object.getOwnPropertyDescriptors(win))) {
			if (!SAFE_SET.has(name) && configurable && !name.endsWith("Error")) {
				object.defineProperty(win, name, FORBIDDEN);
			} else if (value) {
				object.freeze(value);
				// 冻结原型不知为何会严重影响性能
				if (value !== object) object.seal(value.prototype);
			}
		}
		win = win.__proto__;
		toFreeze.push(win);
	}
	toFreeze.forEach(x => Object.freeze(x));

	// 一些可能被库修改的值不能不 writable
	// 函数执行堵上之后已经很安全了，这些代码主要是为了防止代码玩花活抗审计之类的
	const objectPrototype = object.prototype;
	for (const [name, desc] of object.entries(object.getOwnPropertyDescriptors(objectPrototype))) {
		if (name !== 'toString' && name !== 'valueOf' && name !== 'constructor' && desc.writable) {
			desc.writable = false;
			object.defineProperty(objectPrototype, name, desc);
		}
	}
	object.seal(objectPrototype);
};
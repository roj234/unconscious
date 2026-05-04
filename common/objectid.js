
const objectMap = new WeakMap();
let idCounter = 0;

// 获取或生成对象的虚拟哈希
function getVirtualHash(obj) {
	if (obj === null || typeof obj !== 'object') return obj;

	if (!objectMap.has(obj)) {
		// 生成一个类似地址的 16 进制字符串
		const hash = (++idCounter).toString(16).padStart(4, '0');
		const objectType = Object.prototype.toString.call(obj);
		objectMap.set(obj, objectType.substring(8, objectType.length-1)+`@0x${hash}`);
	}
	return objectMap.get(obj);
}

const ctx = console;
for (const prop of Object.getOwnPropertyNames(ctx)) {
	const originalMethod = ctx[prop];

	ctx[prop] = (...args) => {
		let styleArgs = [];
		let formatString = "";

		args.forEach(arg => {
			if (arg !== null && typeof arg === 'object') {
				const hash = getVirtualHash(arg);
				formatString += `%o%c[${hash}] `;
				styleArgs.push(arg);
				styleArgs.push("color: rgb(50, 212, 199); font-style: italic; font-weight: bold;");
			} else if (typeof arg === "string") {
				formatString += "%s ";
				styleArgs.push(arg);
			} else if (typeof arg === "number") {
				formatString += "%c%o ";
				styleArgs.push("color: rgb(153, 128, 255);");
				styleArgs.push(arg);
			} else {
				formatString += "%o ";
				styleArgs.push(arg);
			}
		});

		originalMethod.apply(console, [formatString, ...styleArgs]);
	};
}

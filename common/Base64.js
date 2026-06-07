import {UTF8_TEXT_ENCODER} from "../runtime_shared.js";

const B64_TAB = /* #__PURE__ */ UTF8_TEXT_ENCODER.encode("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/");
const B64_URL_TAB = /* #__PURE__ */ UTF8_TEXT_ENCODER.encode("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_");
const EQ = 61; // '='

const DEC = /* #__PURE__ */ new Int8Array(256).fill(-1);
for (let i = 0; i < 64; i++) DEC[B64_TAB[i]] = i;
DEC[B64_URL_TAB[62]] = 62;
DEC[B64_URL_TAB[63]] = 63;
DEC[EQ] = 0;

export const createBase64Encoder = (urlSafe, bufferCapacity = 1024) => {
	if (bufferCapacity < 8) bufferCapacity = 8;
	const buf = new Uint8Array(bufferCapacity);
	const tab = urlSafe ? B64_URL_TAB : B64_TAB;
	const pad = urlSafe ? 0 : EQ;
	let tail = 0;

	/**
	 * @param {Uint8Array} input
	 * @returns {Generator<Uint8Array, void, unknown>} 本次编码产生的片段
	 */
	function *encode(input) {
		const inputLen = input.length;
		let inputPtr = 0;
		let outputPtr = 0;

		if (tail > 0) {
			while (tail < 3 && inputPtr < inputLen) buf[tail++] = input[inputPtr++];
			if (tail < 3) return;
			tail = 0;

			const a = buf[0], b = buf[1], c = buf[2];
			buf[outputPtr++] = tab[a >> 2];
			buf[outputPtr++] = tab[((a & 0x03) << 4) | (b >> 4)];
			buf[outputPtr++] = tab[((b & 0x0f) << 2) | (c >> 6)];
			buf[outputPtr++] = tab[c & 0x3f];
		}

		const globalEnd = inputLen - 3;
		const chunkSize = ((bufferCapacity >> 2) - 1) * 3;

		while (inputPtr < globalEnd) {
			for (const localEnd = Math.min(inputPtr + chunkSize, globalEnd); inputPtr < localEnd; inputPtr += 3) {
				const a = input[inputPtr], b = input[inputPtr + 1], c = input[inputPtr + 2];
				buf[outputPtr++] = tab[a >> 2];
				buf[outputPtr++] = tab[((a & 0x03) << 4) | (b >> 4)];
				buf[outputPtr++] = tab[((b & 0x0f) << 2) | (c >> 6)];
				buf[outputPtr++] = tab[c & 0x3f];
			}

			yield buf.subarray(0, outputPtr);
			outputPtr = 0;
		}

		while (inputPtr < inputLen) buf[tail++] = input[inputPtr++];
	}

	const finish = () => {
		let outPtr = 0;

		if (tail > 0) {
			const a = buf[0];
			const b = tail > 1 ? buf[1] : 0;
			const c = tail === 2;

			buf[outPtr++] = tab[a >> 2];
			buf[outPtr++] = tab[((a & 0x03) << 4) | (b >> 4)];
			if (pad || c) buf[outPtr++] = c ? tab[(b & 0x0f) << 2] : pad;
			if (pad) buf[outPtr++] = pad;

			tail = 0;
		}

		return buf.subarray(0, outPtr);
	};

	return {encode, finish};
}

export const createBase64Decoder = (bufferCapacity = 1024) => {
	if (bufferCapacity < 8) bufferCapacity = 8;
	const buf = new Uint8Array(bufferCapacity);
	let tail = 0;

	const emit4 = () => {
		const v0 = buf[0],
			v1 = buf[1],
			v2 = buf[2],
			v3 = buf[3];

		const n = v0 << 18 | v1 << 12 | v2 << 6 | v3;
		//if (n < 0) throw new Error("Invalid chars found");
		buf[0] = n >>> 16;
		buf[1] = n >>> 8 & 255;
		buf[2] = n & 255;
		tail = 0;
	}

	/**
	 * @param {string} input
	 * @returns {Generator<Uint8Array, void, unknown>} 本次解码产生的片段
	 */
	function *decode(input) {
		const inputLen = input.length;
		let inputPtr = 0;
		let outputPtr = 0;

		if (tail) {
			while (tail < 4 && inputPtr < inputLen) buf[tail++] = DEC[input.charCodeAt(inputPtr++)];
			if (tail < 4) return;
			emit4();
			outputPtr = 3;
		}

		const globalEnd = inputLen - 4;
		const chunkSize = (bufferCapacity / 3) | 0;

		while (inputPtr < globalEnd) {
			for (const localEnd = Math.min(inputPtr + chunkSize, globalEnd); inputPtr < localEnd; inputPtr += 4) {
				const v0 = DEC[input.charCodeAt(inputPtr)],
					v1 = DEC[input.charCodeAt(inputPtr + 1)],
					v2 = DEC[input.charCodeAt(inputPtr + 2)],
					v3 = DEC[input.charCodeAt(inputPtr + 3)];
				const n = v0 << 18 | v1 << 12 | v2 << 6 | v3;
				//if (n < 0) throw new Error("Invalid chars found");
				buf[outputPtr++] = n >>> 16;
				buf[outputPtr++] = n >>> 8 & 255;
				buf[outputPtr++] = n & 255;
			}

			yield buf.subarray(0, outputPtr);
			outputPtr = 0;
		}

		while (inputPtr < inputLen) buf[tail++] = DEC[input.charCodeAt(inputPtr++)];
	}

	const finish = () => {
		const t = tail;
		if (!t) return buf.subarray(0, 0);
		if (t === 1) throw new Error("Invalid padding");
		buf.fill(EQ, t, 4);
		emit4();
		return buf.subarray(0, t - 1);
	};

	return {decode, finish};
};

const ASCII_DECODER = /* #__PURE__ */ new TextDecoder('ascii');

export const base64Encode = (input, urlSafe, bufferCapacity = 1024) => {
	const byteInput = typeof input === 'string' ? UTF8_TEXT_ENCODER.encode(input) : input;
	const fullOutLen = ((byteInput.length + 2) / 3 | 0) * 4;

	const encoder = createBase64Encoder(urlSafe, Math.min(fullOutLen, bufferCapacity));
	const generator = encoder.encode(byteInput);

	let str = '';
	for (const chunk of generator) {
		str += ASCII_DECODER.decode(chunk);
	}
	str += ASCII_DECODER.decode(encoder.finish());
	return str;
}

export const base64DecodeToUint8Array = (input, bufferCapacity = 4096) => {
	if (typeof input !== 'string') input = ASCII_DECODER.decode(input);
	const fullOutLen = ((input.length + 3) / 4 | 0) * 3;
	const buffer = new Uint8Array(fullOutLen);

	const encoder = createBase64Decoder(Math.min(fullOutLen, bufferCapacity));
	const generator = encoder.decode(input);

	let index = 0;
	for (const chunk of generator) {
		buffer.set(chunk, index);
		index += chunk.length;
	}
	const chunk = encoder.finish();
	buffer.set(chunk, index);
	index += chunk.length;
	return buffer.subarray(0, index);
}

const streamOptions = { stream: true };

export const base64DecodeToString = (input, charset, bufferCapacity = 4096) => {
	if (typeof input !== 'string') input = ASCII_DECODER.decode(input);
	const fullOutLen = ((input.length + 3) / 4 | 0) * 3;

	const encoder = createBase64Decoder(Math.min(fullOutLen, bufferCapacity));
	const generator = encoder.decode(input);
	const dec = new TextDecoder(charset);

	let str = '';
	for (const chunk of generator) {
		str += dec.decode(chunk, streamOptions);
	}
	str += dec.decode(encoder.finish());
	return str;
}

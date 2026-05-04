const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const TAB = /* #__PURE__ */ new Uint8Array(CHARS.split("").map(c => c.charCodeAt(0)));

export const createBase64Encoder = (bufferCapacity = 1024) => {
	let buf = new Uint8Array(bufferCapacity);
	let tailLen = 0;

	/**
	 * @param {Uint8Array} input
	 * @returns {Generator<Uint8Array, void, unknown>} 本次编码产生的片段视图（不含 leftover）
	 */
	function *encode(input) {
		const inputLen = input.length;
		let inputPtr = 0;
		let outputPtr = 0;

		if (tailLen > 0) {
			while (tailLen < 3 && inputPtr < inputLen) buf[tailLen++] = input[inputPtr++];
			if (tailLen < 3) return;

			const [a, b, c] = buf;
			tailLen = 0;

			buf[outputPtr++] = TAB[a >> 2];
			buf[outputPtr++] = TAB[((a & 0x03) << 4) | (b >> 4)];
			buf[outputPtr++] = TAB[((b & 0x0f) << 2) | (c >> 6)];
			buf[outputPtr++] = TAB[c & 0x3f];
		}

		const globalEnd = inputLen - 3;
		const chunkSize = ((bufferCapacity >> 2) - 1) * 3;

		while (inputPtr < globalEnd) {
			for (const localEnd = Math.min(inputPtr + chunkSize, globalEnd); inputPtr < localEnd; inputPtr += 3) {
				const a = input[inputPtr], b = input[inputPtr + 1], c = input[inputPtr + 2];
				buf[outputPtr++] = TAB[a >> 2];
				buf[outputPtr++] = TAB[((a & 0x03) << 4) | (b >> 4)];
				buf[outputPtr++] = TAB[((b & 0x0f) << 2) | (c >> 6)];
				buf[outputPtr++] = TAB[c & 0x3f];
			}

			yield buf.subarray(0, outputPtr);
			outputPtr = 0;
		}

		while (inputPtr < inputLen) buf[tailLen++] = input[inputPtr++];
	}

	const finish = () => {
		let outPtr = 0;

		if (tailLen > 0) {
			const a = buf[0];
			const b = tailLen > 1 ? buf[1] : 0;
			const PAD = 61; // '='

			buf[outPtr++] = TAB[a >> 2];
			buf[outPtr++] = TAB[((a & 0x03) << 4) | (b >> 4)];
			buf[outPtr++] = tailLen === 2 ? TAB[(b & 0x0f) << 2] : PAD;
			buf[outPtr++] = PAD;

			tailLen = 0;
		}

		return buf.subarray(0, outPtr);
	};

	return {encode, finish};
}
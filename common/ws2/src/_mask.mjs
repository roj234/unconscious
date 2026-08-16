
const swap32 = (v) => ((v & 0xff) << 24) | (((v >>> 8) & 0xff) << 16) | (((v >>> 16) & 0xff) << 8) | (v >>> 24);

function mask8(buffer, offset, length, mask) {
	for (let i = 0; i < length; i++) buffer[offset + i] ^= mask >>> ((3 - (i & 3)) << 3);
}

function mask32(buffer, offset, length, mask) {
	const headLen = (4 - ((buffer.byteOffset + offset) & 3)) & 3;
	const pre = headLen < length ? headLen : length;
	for (let i = 0; i < pre; i++) buffer[offset + i] ^= mask >>> ((3 - i) << 3);

	mask = (mask << (8 * pre)) | (mask >>> (32 - 8 * pre));

	const start = offset + pre;
	const rest = length - pre;
	const blocks = rest >>> 2;
	if (blocks) {
		const m = swap32(mask);
		const view = new Uint32Array(buffer.buffer, buffer.byteOffset + start, blocks);
		for (let i = 0; i < blocks; i++) view[i] ^= m;
	}

	const post = start + (blocks << 2);
	for (let i = 0; i < (rest & 3); i++) buffer[post + i] ^= mask >>> ((3 - i) << 3);
}

function mask64(buffer, offset, length, mask) {
	const headLen = (8 - ((buffer.byteOffset + offset) & 7)) & 7;
	const pre = headLen < length ? headLen : length;
	for (let i = 0; i < pre; i++) buffer[offset + i] ^= mask >>> ((3 - (i & 3)) << 3);

	mask = (mask << (8 * (pre & 3))) | (mask >>> (32 - 8 * (pre & 3)));

	const start = offset + pre;
	const rest = length - pre;
	const blocks = rest >>> 3;
	if (blocks) {
		const m32 = BigInt(swap32(mask) >>> 0);
		const m64 = m32 | (m32 << 32n);
		const view = new BigUint64Array(buffer.buffer, buffer.byteOffset + start, blocks);
		for (let i = 0; i < blocks; i++) view[i] ^= m64;
	}

	const post = start + (blocks << 3);
	for (let i = 0; i < (rest & 7); i++) buffer[post + i] ^= mask >>> ((3 - (i & 3)) << 3);
}

/**
 * XOR Mask (原地)
 * @param {Buffer} buffer
 * @param {number} offset
 * @param {number} length
 * @param {number} mask BE int32
 */
function _mask(buffer, offset, length, mask) {
	if (length <= 24) return mask8(buffer, offset, length, mask);
	if (length <= 256) return mask32(buffer, offset, length, mask);
	return mask64(buffer, offset, length, mask);
}

export let mask = _mask;

if (!process.env.WS_NO_BUFFER_UTIL)
try {
	const nativeUnmask = (await import('bufferutil')).unmask;
	const NATIVE_MIN = 768;
	const maskBuf = Buffer.allocUnsafe(4);
	mask = (buffer, offset, length, mask) => {
		if (length >= NATIVE_MIN) {
			maskBuf.writeUInt32BE(mask >>> 0, 0);
			nativeUnmask(buffer.subarray(offset, offset + length), maskBuf);
			return;
		}

		_mask(buffer, offset, length, mask);
	}
} catch {}
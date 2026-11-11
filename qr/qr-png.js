import {crc32} from "@roj234/jszip/io";
import {UTF8_TEXT_ENCODER} from "@roj234/shared";
import generateQRCode from "./qr.js";

const concatBytes = (a, b) => {
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
};

const pngChunk = (type, data) => {
	const t = UTF8_TEXT_ENCODER.encode(type);
	const out = new Uint8Array(12 + data.length);
	const v = new DataView(out.buffer);
	v.setUint32(0, data.length);
	out.set(t, 4);
	out.set(data, 8);
	v.setUint32(8 + data.length, crc32(concatBytes(t, data)));
	return out;
};

/**
 * Render a monochrome (1-bit grayscale) PNG of a QR code as a Blob.
 *
 * @param {QRInputType} data
 * @param {QRCodePNGOptions} options
 * @returns {Promise<Blob>}
 */
export const renderQRCodeToPNG = async (data, options = {}) => {
	const { modules, size } = generateQRCode(data, options);
	const border = options.border ?? 1;
	const scale = options.scale ?? 1; // repeat each module `scale` times in both axes
	const width = (size + border * 2) * scale;
	const height = width;

	// 1-bit grayscale scanlines, filter type 0 (None). dark→0(black), light→1(white)
	const stride = (width + 7) >> 3;
	const raw = new Uint8Array((stride + 1) * height);
	let p = 0;
	for (let y = 0; y < height; y++) {
		raw[p++] = 0;
		let byte = 0, bits = 0;
		const my = Math.floor(y / scale) - border;
		for (let x = 0; x < width; x++) {
			const mx = Math.floor(x / scale) - border;
			const dark = mx >= 0 && my >= 0 && mx < size && my < size && modules[my * size + mx] !== 0;
			byte = (byte << 1) | (dark ? 0 : 1);
			if (++bits === 8) { raw[p++] = byte; byte = 0; bits = 0; }
		}
		if (bits > 0) raw[p++] = byte << (8 - bits);
	}

	const cs = new CompressionStream('deflate');
	const compressed = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(cs)).arrayBuffer());

	const ihdr = new Uint8Array(13);
	const dv = new DataView(ihdr.buffer);
	dv.setUint32(0, width);
	dv.setUint32(4, height);
	ihdr[8] = 1;  // bit depth
	ihdr[9] = 0;  // color type: grayscale
	ihdr[10] = 0; // compression method
	ihdr[11] = 0; // filter method
	ihdr[12] = 0; // interlace

	const sig = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

	return new Blob(
		[sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', compressed), pngChunk('IEND', new Uint8Array(0))],
		{ type: 'image/png' }
	);
};

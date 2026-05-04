
const te = /* #__PURE__ */ new TextEncoder();
const HEX_CHARS = '0123456789abcdef'.split('');
const K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
	0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
	0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
	0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
	0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
	0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
	0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
	0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
	0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

export class SHA256 {
	constructor() {
		const buf = new Uint8Array(64);
		this.buffer = buf;
		this.view = new DataView(buf.buffer);
		this.pos = this.lenH = this.lenL = 0;

		this.state = new Uint32Array([
			0x6a09e667,
			0xbb67ae85,
			0x3c6ef372,
			0xa54ff53a,
			0x510e527f,
			0x9b05688c,
			0x1f83d9ab,
			0x5be0cd19
		]);
		this.W = new Uint32Array(64);
	}

	/**
	 * 追加数据
	 * @param {string|Uint8Array} data
	 * @returns {this}
	 */
	update(data) {
		let {_hash, pos, buffer, lenH, lenL} = this;
		if (_hash) throw new Error('实例已完成');

		// 字符串统一转为 Uint8Array
		if (typeof data === 'string') {
			data = te.encode(data);
		} else if (!(data instanceof Uint8Array)) {
			throw new TypeError('输入必须为 string 或 Uint8Array');
		}

		let offset = 0;
		while (offset < data.length) {
			const remaining = 64 - pos;
			const toCopy = Math.min(remaining, data.length - offset);
			buffer.set(data.subarray(offset, offset + toCopy), pos);
			pos += toCopy;
			offset += toCopy;

			if (pos === 64) {
				this._processBlock();

				lenL = (lenL + 512) >>> 0;
				if (lenL < 512) {
					lenH = (lenH + 1) >>> 0;
				}
				pos = 0;
			}
		}

		this.pos = pos;
		this.lenL = lenL;
		this.lenH = lenH;
		return this;
	}

	/**
	 * 完成哈希计算
	 * @param {'hex'|'arraybuffer'} [format='arraybuffer']
	 * @returns {string|ArrayBuffer}
	 */
	digest(format ) {
		let {buffer, pos, view, _hash, lenH, lenL, state} = this;

		if (!_hash) {
			const bits = pos * 8;

			buffer[pos] = 0x80;
			buffer.fill(0, pos + 1);

			// 若剩余空间不足 8 字节存放长度，则处理该块后再开新块
			if (pos >= 56) {
				this._processBlock();
				buffer.fill(0, 0, 56);
			}

			// 计算包含缓冲区的完整消息位长度
			const sumLow = lenL + bits;
			const carry = sumLow > 0xFFFFFFFF ? 1 : 0;

			view.setUint32(56, lenH + carry);
			view.setUint32(60, sumLow);

			this._processBlock();

			const out = new Uint8Array(state.buffer);
			const outView = new DataView(state.buffer);
			for (let i = 0; i < 8; i++) {
				outView.setUint32(i * 4, state[i]);
			}
			_hash = this._hash = out;
		}

		if (format === 'hex') {
			let hex = '';
			for (let i = 0; i < 32; i++) {
				const byte = _hash[i];
				hex += HEX_CHARS[(byte >>> 4)] + HEX_CHARS[(byte & 0xf)];
			}
			return hex;
		} else if (format === 'arraybuffer') {
		}
		return _hash.buffer;
	}

	toString() {
		return this.digest('hex');
	}

	/** 处理一个 64 字节块，更新内部状态 */
	_processBlock() {
		const {W, view, state} = this;

		for (let i = 0; i < 16; i++) {
			W[i] = view.getUint32(i * 4);
		}

		for (let i = 16; i < 64; i++) {
			const w15 = W[i - 15];
			const s0 = (
				((w15 >>> 7) | (w15 << 25)) ^
				((w15 >>> 18) | (w15 << 14)) ^
				(w15 >>> 3)
			) >>> 0;
			const w2 = W[i - 2];
			const s1 = (
				((w2 >>> 17) | (w2 << 15)) ^
				((w2 >>> 19) | (w2 << 13)) ^
				(w2 >>> 10)
			) >>> 0;
			W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
		}

		let a = state[0];
		let b = state[1];
		let c = state[2];
		let d = state[3];
		let e = state[4];
		let f = state[5];
		let g = state[6];
		let h = state[7];

		for (let i = 0; i < 64; i++) {
			// Sigma1(e)
			const S1 = (
				((e >>> 6) | (e << 26)) ^
				((e >>> 11) | (e << 21)) ^
				((e >>> 25) | (e << 7))
			) >>> 0;
			// Ch(e, f, g)
			const ch = (e & f) ^ (~e & g);
			// temp1 = h + S1 + ch + K[i] + W[i]
			const temp1 = (h + S1 + ch + K[i] + W[i]) | 0;
			// Sigma0(a)
			const S0 = (
				((a >>> 2) | (a << 30)) ^
				((a >>> 13) | (a << 19)) ^
				((a >>> 22) | (a << 10))
			) >>> 0;
			// Maj(a, b, c)
			const maj = (a & b) ^ (a & c) ^ (b & c);
			// temp2 = S0 + maj
			const temp2 = (S0 + maj) | 0;

			h = g;
			g = f;
			f = e;
			e = (d + temp1) | 0;
			d = c;
			c = b;
			b = a;
			a = (temp1 + temp2) | 0;
		}

		state[0] += a;
		state[1] += b;
		state[2] += c;
		state[3] += d;
		state[4] += e;
		state[5] += f;
		state[6] += g;
		state[7] += h;
	}

	static hash(data, format = 'hex') {
		const instance = new SHA256();
		instance.update(data);
		return instance.digest(format);
	}
}

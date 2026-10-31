const SLAB = 65536; // via microbenchmark

export class ContinuousFrame {
	#data = [];
	#slab = null;
	#commit = 0;
	#used = 0;
	#length = 0;

	constructor(first) {
		this.first = first;
	}

	get length() { return this.#length; }

	/**
	 * @param {Buffer} f
	 */
	append(f) {
		const len = f.length;
		this.#length += len;

		const slab = this.#slab;
		if (slab !== null && this.#used + len <= slab.length) {
			f.copy(slab, this.#used);
			this.#used += len;
			return;
		}

		if (len > (SLAB >> 1)) {
			if (slab !== null && this.#used > this.#commit) {
				this.#data.push(slab.subarray(this.#commit, this.#used));
				this.#commit = this.#used;
			}
			this.#data.push(Buffer.from(f));
			return;
		}

		if (slab !== null && this.#used > this.#commit) {
			this.#data.push(slab.subarray(this.#commit, this.#used));
		}

		this.#slab = Buffer.allocUnsafe(SLAB);
		f.copy(this.#slab, 0);
		this.#commit = 0;
		this.#used = len;
	}

	payload() {
		const slab = this.#slab;
		const n = this.#data.length;
		let r;
		if (n === 0) {
			r = slab.subarray(this.#commit, this.#used);
		} else {
			const arr = Array(n + (slab?1:0));
			for (let i = 0; i < n; i++) arr[i] = this.#data[i];
			if(slab) arr[n] = slab.subarray(this.#commit, this.#used);
			r = Buffer.concat(arr, this.#length);
		}
		return r;
	}

	clear() {
		this.#data.length = 0;
		this.#slab = null;
		this.#commit = 0;
		this.#used = 0;
		this.#length = 0;
	}
}

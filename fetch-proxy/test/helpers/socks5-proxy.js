import net from 'node:net';

/**
 * 一个只实现 CONNECT + 可选 username/password 认证的 SOCKS5 代理，用于测试。
 *
 * @param {Object} [options]
 * @param {boolean} [options.requireAuth]
 * @param {string} [options.username]
 * @param {string} [options.password]
 * @param {number} [options.reply] CONNECT 回复码，0 表示成功
 * @param {number} [options.method] 强制问候回复的认证方法（例如 0xff 表示无可用方法）
 * @param {{host: string, port: number}} [options.dial] 握手成功后实际连接的地址
 * @param {(info: {atyp: number, addr: Buffer, port: number}) => void} [options.onConnect]
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
export async function startSocks5Proxy({
	requireAuth = false,
	username = 'user',
	password = 'pw',
	reply = 0,
	method,
	dial,
	onConnect,
} = {}) {
	const sockets = new Set();

	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		socket.on('error', () => socket.destroy());

		let state = 0; // 0=greeting 1=auth 2=connect 3=tunneling -1=done
		let buffer = Buffer.alloc(0);
		let upstream = null;

		const send = data => {
			if (!socket.destroyed) socket.write(data);
		};

		socket.on('data', chunk => {
			if (state === 3) {
				upstream?.write(chunk);
				return;
			}
			buffer = Buffer.concat([buffer, chunk]);

			for (;;) {
				if (state === 0) {
					if (buffer.length < 2) return;
					const count = buffer[1];
					if (buffer.length < 2 + count) return;
					const methods = buffer.subarray(2, 2 + count);
					buffer = buffer.subarray(2 + count);

					if (method !== undefined) {
						send(Buffer.from([5, method]));
						state = -1;
						return;
					}
					if (requireAuth && !methods.includes(2)) {
						send(Buffer.from([5, 0xff]));
						state = -1;
						return;
					}
					send(Buffer.from([5, requireAuth ? 2 : 0]));
					state = requireAuth ? 1 : 2;
				} else if (state === 1) {
					if (buffer.length < 2) return;
					const ulen = buffer[1];
					if (buffer.length < 2 + ulen + 1) return;
					const plen = buffer[2 + ulen];
					if (buffer.length < 3 + ulen + plen) return;
					const user = buffer.subarray(2, 2 + ulen).toString('utf8');
					const pass = buffer.subarray(3 + ulen, 3 + ulen + plen).toString('utf8');
					buffer = buffer.subarray(3 + ulen + plen);

					if (user !== username || pass !== password) {
						send(Buffer.from([1, 1]));
						state = -1;
						return;
					}
					send(Buffer.from([1, 0]));
					state = 2;
				} else if (state === 2) {
					if (buffer.length < 4) return;
					const atyp = buffer[3];
					let total;
					if (atyp === 1) total = 10;
					else if (atyp === 4) total = 22;
					else if (atyp === 3) {
						if (buffer.length < 5) return;
						total = 4 + 1 + buffer[4] + 2;
					} else {
						send(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0]));
						state = -1;
						return;
					}
					if (buffer.length < total) return;

					const request = buffer.subarray(0, total);
					const info = {atyp, addr: Buffer.from(request.subarray(4, total - 2)), port: request.readUInt16BE(total - 2)};
					buffer = buffer.subarray(total);
					onConnect?.(info);

					if (reply !== 0) {
						send(Buffer.from([5, reply, 0, 1, 0, 0, 0, 0, 0, 0]));
						state = -1;
						return;
					}

					send(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
					state = 3;

					if (buffer.length) {
						// CONNECT 之后同一包里可能还有客户端数据
						setImmediate(() => upstream?.write(buffer));
					}

					if (!dial) return;

					upstream = net.connect({host: dial.host, port: dial.port});
					upstream.on('data', data => send(data));
					upstream.on('error', () => socket.destroy());
					socket.on('close', () => upstream?.destroy());
					return;
				} else {
					return;
				}
			}
		});
	});

	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

	return {
		port: server.address().port,
		close: () => new Promise(resolve => {
			for (const socket of sockets) socket.destroy();
			server.close(resolve);
		}),
	};
}

import http from 'node:http';
import https from 'node:https';
import {Readable} from "node:stream";

const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** Duck-type check: Node.js Readable stream (has .pipe) */
const isNodeStream = body => typeof body?.pipe === 'function';

/**
 * @param {URL} url
 * @param {RequestInit} init
 * @returns {Promise<Response>}
 */
function makeRequest(url, { method, headers: headersInit, body, signal, agent, ...rest }) {
	const transport = url.protocol === 'https:' ? https : http;
	const headers = Object.create(null);

	if (headersInit) {
		if (headersInit[Symbol.iterator]) {
			for (const [k, v] of headersInit) headers[k.toLowerCase()] = v;
		} else {
			for (const [k, v] of Object.entries(headersInit)) headers[k.toLowerCase()] = v;
		}
	}
	headers['host'] ??= url.host;

	let bodyBuffer, bodyStream;
	if (body != null) {
		if (body instanceof ReadableStream) body = Readable.fromWeb(body);
		if (isNodeStream(body)) {
			bodyStream = body;
		} else {
			if (body instanceof Uint8Array) body = Buffer.from(body);
			if (Buffer.isBuffer(body)) bodyBuffer = body;
			else {
				const flag2 = body instanceof URLSearchParams;
				if (typeof body === 'string' || flag2) {
					bodyBuffer = Buffer.from(String(body), 'utf-8');
					headers['content-type'] ??= body instanceof URLSearchParams ? 'application/x-www-form-urlencoded;charset=UTF-8' : 'text/plain;charset=UTF-8';
				}
			}

			if (bodyBuffer) {
				headers['content-length'] = String(bodyBuffer.length);
			} else {
				const response = new Response(body);
				bodyStream = Readable.fromWeb(response.body);
				if (body instanceof Blob)
					headers['content-length'] = String(body.size);
			}
		}
	}

	const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']')
		? url.hostname.slice(1, -1)
		: url.hostname;

	const options = {
		method,
		hostname,
		port: url.port || (url.protocol === 'https:' ? 443 : 80),
		path: url.pathname + url.search,
		headers,
		rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0',
		...rest
	};

	if (agent != null) options.agent = typeof agent === 'function' ? agent(url) : agent;

	return new Promise((resolve, reject) => {
		const req = transport.request(options, (res) => {
			const statusCode = res.statusCode;
			if (statusCode < 200) {
				req.destroy();
				const status = res.statusMessage ? `${statusCode} ${res.statusMessage}` : statusCode;
				return reject(new TypeError(`fetch failed: unexpected upgrade response ${status}`));
			}

			const stream = NULL_BODY_STATUS.has(statusCode) ? null : Readable.toWeb(res);

			const resHeaders = new Headers();
			for (const [k, v] of Object.entries(res.headers)) {
				if (Array.isArray(v)) {
					for (const item of v) resHeaders.append(k, item);
				} else {
					resHeaders.append(k, v);
				}
			}

			const response = new Response(stream, {
				status: statusCode,
				statusText: res.statusMessage,
				headers: resHeaders,
			});

			// Patch readonly properties
			Object.defineProperty(response, 'url', {
				get: () => url.href,
				configurable: true,
				enumerable: true,
			});
			Object.defineProperty(response, 'redirected', {
				get: () => false,
				configurable: true,
				enumerable: true,
			});
			Object.defineProperty(response, 'type', {
				get: () => 'basic',
				configurable: true,
				enumerable: true,
			});

			resolve(response);
		});

		req.on('error', reject);
		req.on('upgrade', (res, socket) => {
			socket.destroy();
			const status = res.statusMessage ? `${res.statusCode} ${res.statusMessage}` : res.statusCode;
			reject(new TypeError(`fetch failed: unexpected upgrade response ${status}`));
		});

		if (bodyStream) {
			bodyStream.pipe(req);
			bodyStream.on('error', (err) => req.destroy(err));
		} else {
			if (bodyBuffer) req.end(bodyBuffer);
			else req.end();
		}

		if (signal) {
			const onAbort = () => req.destroy(new DOMException('Aborted', 'AbortError'));
			if (signal.aborted) return onAbort();
			signal.addEventListener('abort', onAbort, { once: true });
			req.on('close', () => signal.removeEventListener('abort', onAbort));
		}
	});
}

/**
 * @param {string | URL | Request} input
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
async function _fetch(input, {
	method,
	headers,
	body,
	signal,
	redirect,
	maxRedirects = 20, // unofficial
	...rest
} = {}) {
	let url;

	if (typeof input === 'string') {
		url = new URL(input);
	} else if (input instanceof URL) {
		url = new URL(input.href);
	} else if (input && typeof input === 'object' && 'url' in input) {
		url = new URL(input.url);
		method ??= input.method;
		headers ??= input.headers;
		body ??= input.body;
		redirect ??= input.redirect;
		signal ??= input.signal;
	} else {
		throw new TypeError('Invalid fetch input');
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:')
		throw new TypeError(`Unsupported protocol: ${url.protocol}`);

	const init = {
		method: (method ?? 'GET').toUpperCase(),
		headers,
		body,
		signal,
		...rest // agent
	};

	let response = await makeRequest(url, init);

	if (redirect == null || redirect === 'follow') {
		let redirectCount = 0;
		const _maxRedirects = parseInt(maxRedirects);

		while (
			REDIRECT_STATUS.has(response.status) &&
			redirectCount < _maxRedirects
		) {
			const location = response.headers.get('location');
			if (!location) break;

			url = new URL(location, url);

			// 301/302/303 → GET, drop body; 307/308 → keep method & body
			if (response.status !== 307 && response.status !== 308) {
				init.method = 'GET';
				delete init.body;
			}

			if (init.body instanceof ReadableStream || isNodeStream(init.body)) {
				throw new DOMException('重定向失败：流无法重放', 'NotSupportedError');
			}

			await response.body?.cancel();

			redirectCount++;
			response = await makeRequest(url, init);
			Object.defineProperty(response, 'redirected', {
				get: () => true,
				configurable: true,
				enumerable: true,
			});
		}
	} else if (redirect === 'error') {
		if (REDIRECT_STATUS.has(response.status)) {
			throw new TypeError('Redirect not allowed');
		}
	}

	return response;
}

export { _fetch as fetch };

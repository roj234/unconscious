'use strict';

import Buffer from "./buffer-polyfill.js";

const DENY_NAME = 'SecurityError';

/**
 * @type {Record<string, { value: string, domain: RegExp }>}
 */
let secrets = {};

/**
 * @type {RegExp}
 */
let allowlist;

/**
 * 更新凭据
 */
export const setSecrets = ([argWhitelist, argEnv]) => {
	for (const [key, value] of Object.entries(argEnv)) {
		const dom = typeof value.domain;
		if (dom === 'string') value.domain = new RegExp(value.domain, 'i');
	}
	secrets = argEnv;
	allowlist = argWhitelist;
}

function resolveURL(input) {
	if (input instanceof URL) return input;
	const raw = input instanceof Request ? input.url : input;
	try {
		return new URL(raw);
	} catch {
		throw new DOMException(`Relative url is not allowed: `+raw, DENY_NAME);
	}
}

/**
 * @param {WorkerGlobalScope} newGlobal
 */
export const setupNetworkGuard = (newGlobal) => {
	const secureFetchPattern = /\$env:([A-Za-z_][A-Za-z0-9_]*)(?::([A-Za-z0-9_]+))?\$/g;
	const regexTest = RegExp.prototype.test;

	function assertAllowed(input) {
		const url = resolveURL(input);
		if (allowlist && !regexTest.call(allowlist, url.href)) throw new DOMException(`This url is not in whitelist: ${url}`, DENY_NAME);
		return url;
	}

	if (typeof XMLHttpRequest === 'function') {
		const proto = XMLHttpRequest.prototype;
		const originalOpen = proto.open;
		proto.open = function open(method, url, ...rest) {
			assertAllowed(url);
			return originalOpen.call(this, method, url, ...rest);
		};
		newGlobal.XMLHttpRequest = XMLHttpRequest;
	}

	const readHeaders = (h) => {
		if (!h) return [];
		if (h instanceof Headers) return h.entries();
		if (Array.isArray(h)) return h.map(p => [String(p[0]), String(p[1])]);
		return Object.entries(h);
	};

	if (typeof fetch === 'function') {
		const originalFetch = fetch;
		newGlobal.fetch = function (input, init) {
			let url;
			try {
				url = assertAllowed(input).toString();
			} catch (e) {
				return Promise.reject(e);
			}

			const tmp = { ...init, referrerPolicy: 'same-origin' };

			let headers = tmp.headers;
			if (headers) {
				let hasMatch = false;

				const pairs = readHeaders(headers).map(([k, v]) => {
					const out = v.replace(secureFetchPattern, (_, name, transform) => {
						const def = secrets[name];
						if (!def) throw new DOMException("未找到安全环境变量 "+name, DENY_NAME);
						if (!def.domain?.test(url)) throw new DOMException("安全环境变量 "+name+" 不允许在该URL上使用", DENY_NAME);

						let value = def.value;
						if (transform) value = Buffer.from(value).toString(transform);

						hasMatch = true;
						return value;
					});
					return [k, out];
				});

				if (hasMatch) tmp.headers = new Headers(pairs);
			}

			return originalFetch(input, tmp);
		};
		newGlobal.Headers = Headers;
	}

	for (const name of 'WebSocket EventSource WebTransport WebSocketStream'.split(' ')) {
		const Original = self[name];
		if (typeof Original === 'function') {
			newGlobal[name] = new Proxy(Original, {
				construct(target, args, newTarget) {
					if (args.length > 0) assertAllowed(args[0]);
					return Reflect.construct(target, args, newTarget);
				}
			});
		}
	}
}
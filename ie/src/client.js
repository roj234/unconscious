// HMR 客户端
const HMR_PATH = '/@ie/client';
const HMR_PROTOCOL = 'hmr';

// region 错误浮层
let overlay = null;

function openOverlay() {
	if (overlay) return overlay;
	overlay = document.createElement('div');
	overlay.id = 'ie-error-overlay';
	overlay.style.cssText = [
		'position:fixed', 'inset:0', 'z-index:2147483646', 'display:flex',
		'align-items:flex-start', 'justify-content:center', 'padding-top:5vh',
		'background:rgba(8,8,12,.72)', 'font-family:ui-monospace,SFMono-Regular,Consolas,monospace',
	].join(';');
	overlay.innerHTML = `
<div style="width:min(1100px,100%);background:#1b1b22;color:#f2f2f2;border:1px solid #ff5a5a;box-shadow:0 24px 64px rgba(0,0,0,.6)">
  <div style="display:flex;align-items:center;gap:10px;padding:11px 14px;border-bottom:1px solid #33333d;background:#232330">
    <span style="color:#ff6b6b;font-weight:700">错误</span>
    <span data-ie-where style="color:#8aa;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
    <button data-ie-close style="margin-left:auto;background:#2f2f3a;color:#ddd;border:0;border-radius:6px;padding:5px 10px;cursor:pointer;font:inherit;font-size:12px">关闭 (Esc)</button>
  </div>
  <pre data-ie-body style="margin:0;padding:14px;white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.6;color:#ffd7d7;max-height:70vh;overflow:auto"></pre>
</div>`;
	overlay.children[0].addEventListener('click', e => {
		if (!e.target.closest('[data-ie-close]')) e.stopPropagation();
	});
	overlay.addEventListener('click', closeOverlay);
	document.addEventListener('keydown', event => {
		if (event.key === 'Escape') closeOverlay();
	});
	return overlay;
}
const closeOverlay = () => overlay?.remove();

function showError(err, kind = 'server') {
	if (!BROWSER) return console.error(err);

	const node = openOverlay();
	document.documentElement.appendChild(node);

	const where = node.querySelector('[data-ie-where]');
	const body = node.querySelector('[data-ie-body]');
	const loc = err.loc?.line ? `:${err.loc.line}${err.loc.column ? ':' + err.loc.column : ''}` : '';
	const id = String(err.id || '').replace(location.origin, '').replace(/^\/@fs\//, '');
	where.textContent = id ? `${id}${loc}` : (err.plugin ? `插件 ${err.plugin}` : '');
	body.textContent = [err.message, err.frame, err.stack].filter(Boolean).join('\n\n');
}

// endregion

let connectedTime = 0;

const hotModules = new Map();
const listeners = new Map();

const BROWSER = 'document' in globalThis;

const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${HMR_PATH}`, HMR_PROTOCOL);

ws.onopen = () => {
	connectedTime = Date.now();
	console.debug(`[ie] connected.`);
	if (BROWSER) {
		const s = document.querySelector('[data-error-url]');
		if (s) fetch(s.dataset.errorUrl);
	}
};
ws.onmessage = async event => {
	let payload;
	try {
		payload = JSON.parse(event.data);
	} catch {
		return;
	}

	switch (payload.type) {
		case 'full-reload': location.reload(); return;
		case 'css-update':
			if (!BROWSER) return;
			for (const update of payload.updates) {
				for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
					const url = new URL(link.href, location.href);
					if (url.pathname !== update.path) continue;
					url.searchParams.set('t', update.timestamp);
					link.href = url.href;
				}
			}
			closeOverlay();
			return;
		case 'update':
			for (const update of payload.updates) {
				const boundary = update.acceptedPath || update.path;

				const record = hotModules.get(boundary);
				if (!record?.accepted) { location.reload(); return; }

				let url = boundary + (boundary.includes('?') ? '&' : '?')+'t='+update.timestamp+"&pv="+connectedTime;

				try {
					const mod = await import(/* @vite-ignore */ url);

					for (const dispose of record.dispose) dispose();
					for (const callback of record.callbacks) callback(mod);
				} catch {
					// 服务端会回调的
					return;
				}
			}
			closeOverlay();
			return;
		case 'custom':
			for (const callback of listeners.get(payload.event) || []) callback(payload.data);
			return;
		case 'error':
			// TODO 转换失败应该由服务端下发
			showError({
				module: payload.module,
				...(payload.err || {message: String(payload.err)})
			});
			return;
	}
};
ws.onclose = () => {
	console.debug(`[ie] server connection lost. Polling for restart...`);

	const url = `${location.protocol}//${location.host}${HMR_PATH}`;
	const reconnect = () => fetch(url, {
		signal: AbortSignal.timeout(1000),
		cache: "no-store"
	}).then(res => {
		if (res.status === 200) location.reload();
	}, () => {}).finally(() => {
		setTimeout(reconnect, 1000);
	});
	reconnect();
};

export function createHotContext(path) {
	const record = {path, accepted: false, callbacks: [], dispose: [], data: {}};
	hotModules.set(path, record);

	return {
		data: record.data,
		accept(callback, _deps, _fn) {
			record.accepted = true;
			if (typeof callback === 'function') record.callbacks.push(callback);
			else if (typeof _deps === 'function') record.callbacks.push(_deps);
			else if (typeof _fn === 'function') record.callbacks.push(_fn);
		},
		acceptExports() { record.accepted = true; },
		dispose(callback) { record.dispose.push(callback); },
		prune() {},
		decline() {},
		invalidate(message) {
			console.warn('[ie] module invalidated:', message);
			location.reload();
		},
		on(event, callback) {
			let list = listeners.get(event);
			if (!list) listeners.set(event, list = []);
			list.push(callback);
		},
		off(event, callback) {
			const list = listeners.get(event);
			if (list) listeners.set(event, list.filter(cb => cb !== callback));
		},
		send(event, data) { ws.send(JSON.stringify({ type: 'custom', event, data})); },
	};
}

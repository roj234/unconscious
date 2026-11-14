import {after, test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {Readable} from 'node:stream';
import {fetch} from '../fetch.js';

const readBody = req => new Promise(resolve => {
	const chunks = [];
	req.on('data', chunk => chunks.push(chunk));
	req.on('end', () => resolve(Buffer.concat(chunks)));
});

const slowTimers = new Set();
const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, 'http://localhost');
	const body = await readBody(req);

	switch (url.pathname) {
		case '/hello':
			res.writeHead(200, {'content-type': 'text/plain', 'x-test': 'yes'});
			res.end('hello');
			return;
		case '/echo':
			res.writeHead(200, {'content-type': 'application/json'});
			res.end(JSON.stringify({method: req.method, headers: req.headers, body: body.toString('utf8')}));
			return;
		case '/redirect-body':
			res.writeHead(302, {location: '/hello'});
			res.end('moved');
			return;
		case '/redirect-empty':
			res.writeHead(302, {location: '/hello'});
			res.end();
			return;
		case '/redirect-307':
			res.writeHead(307, {location: '/echo'});
			res.end();
			return;
		case '/redirect-loop':
			res.writeHead(302, {location: '/redirect-loop'});
			res.end();
			return;
		case '/no-content':
			res.writeHead(204);
			res.end();
			return;
		case '/not-modified':
			res.writeHead(304);
			res.end();
			return;
		case '/reset-content':
			res.writeHead(205);
			res.end();
			return;
		case '/set-cookie':
			res.setHeader('set-cookie', ['a=1', 'b=2']);
			res.writeHead(200);
			res.end('ok');
			return;
		case '/slow':
			res.writeHead(200);
			res.write('part1');
			slowTimers.add(setTimeout(() => res.end('part2'), 1000));
			return;
		case '/big':
			res.writeHead(200);
			res.end('x'.repeat(200000));
			return;
		case '/binary':
			res.writeHead(200);
			res.end(Buffer.from([0, 1, 2, 255]));
			return;
		case '/switching':
			res.writeHead(101);
			res.end();
			return;
		default:
			res.writeHead(404);
			res.end('nope');
	}
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
	for (const timer of slowTimers) clearTimeout(timer);
	server.closeAllConnections();
	await new Promise(resolve => server.close(resolve));
	http.globalAgent.destroy();
});

test('GET：状态、响应头、url、type、redirected', async () => {
	const response = await fetch(`${base}/hello`);
	assert.equal(response.status, 200);
	assert.equal(response.statusText, 'OK');
	assert.equal(response.type, 'basic');
	assert.equal(response.redirected, false);
	assert.equal(response.url, `${base}/hello`);
	assert.equal(response.headers.get('content-type'), 'text/plain');
	assert.equal(response.headers.get('x-test'), 'yes');
	assert.equal(await response.text(), 'hello');
});

test('method 会被规范化为大写，自定义 header 会转发', async () => {
	const response = await fetch(`${base}/echo`, {method: 'patch', headers: {'X-Custom': 'v'}});
	const data = await response.json();
	assert.equal(data.method, 'PATCH');
	assert.equal(data.headers['x-custom'], 'v');
	assert.equal(data.headers.host, new URL(base).host);
});

test('字符串 body：自动 content-type / content-length', async () => {
	const response = await fetch(`${base}/echo`, {method: 'POST', body: 'hello'});
	const data = await response.json();
	assert.equal(data.body, 'hello');
	assert.equal(data.headers['content-type'], 'text/plain;charset=UTF-8');
	assert.equal(data.headers['content-length'], '5');
});

test('URLSearchParams body', async () => {
	const response = await fetch(`${base}/echo`, {method: 'POST', body: new URLSearchParams({a: '1', b: '2'})});
	const data = await response.json();
	assert.equal(data.body, 'a=1&b=2');
	assert.equal(data.headers['content-type'], 'application/x-www-form-urlencoded;charset=UTF-8');
	assert.equal(data.headers['content-length'], '7');
});

test('Uint8Array / Buffer body', async () => {
	const u8 = await fetch(`${base}/echo`, {method: 'POST', body: new Uint8Array([104, 105])});
	const u8Data = await u8.json();
	assert.equal(u8Data.body, 'hi');
	assert.equal(u8Data.headers['content-length'], '2');
	assert.equal(u8Data.headers['content-type'], undefined);

	const buf = await fetch(`${base}/echo`, {method: 'POST', body: Buffer.from('buf')});
	const bufData = await buf.json();
	assert.equal(bufData.body, 'buf');
	assert.equal(bufData.headers['content-length'], '3');
});

test('Blob body', async () => {
	const response = await fetch(`${base}/echo`, {method: 'POST', body: new Blob(['blobby'])});
	const data = await response.json();
	assert.equal(data.body, 'blobby');
	assert.equal(data.headers['content-length'], '6');
});

test('Node Readable body', async () => {
	const response = await fetch(`${base}/echo`, {method: 'POST', body: Readable.from(['abc', 'def'])});
	const data = await response.json();
	assert.equal(data.body, 'abcdef');
});

test('Request 输入（无 body）', async () => {
	const request = new Request(`${base}/echo`, {method: 'PUT'});
	const response = await fetch(request);
	const data = await response.json();
	assert.equal(data.method, 'PUT');
});

test('redirect: follow（空 body 的 302）', async () => {
	const response = await fetch(`${base}/redirect-empty`);
	assert.equal(response.status, 200);
	assert.equal(response.redirected, true);
	assert.equal(response.url, `${base}/hello`);
	assert.equal(await response.text(), 'hello');
});

test('redirect: manual 不跟随', async () => {
	const response = await fetch(`${base}/redirect-empty`, {redirect: 'manual'});
	assert.equal(response.status, 302);
	assert.equal(response.headers.get('location'), '/hello');
	assert.equal(response.redirected, false);
});

test('redirect: error 直接抛 TypeError', async () => {
	await assert.rejects(fetch(`${base}/redirect-empty`, {redirect: 'error'}), TypeError);
});

test('307 保留 method 与 body', async () => {
	const response = await fetch(`${base}/redirect-307`, {method: 'POST', body: 'abc'});
	assert.equal(response.status, 200);
	assert.equal(response.redirected, true);
	const data = await response.json();
	assert.equal(data.method, 'POST');
	assert.equal(data.body, 'abc');
});

test('不可重放的流在重定向时抛出异常', async () => {
	const stream = new ReadableStream({
		pull(controller) {
			controller.close();
		}
	})
	await assert.rejects(
		fetch(`${base}/redirect-307`, {method: 'POST', body: stream}),
		error => error.name === 'NotSupportedError',
	);
});

test('maxRedirects 限制重定向次数', async () => {
	const response = await fetch(`${base}/redirect-loop`, {maxRedirects: 3});
	assert.equal(response.status, 302);
	assert.equal(response.redirected, true);
});

test('null body 状态码：204 / 205 / 304', async () => {
	for (const path of ['/no-content', '/reset-content', '/not-modified']) {
		const response = await fetch(base + path);
		assert.equal(response.body, null, `${path} 不应有 body`);
	}
});

test('多个 set-cookie 保留', async () => {
	const response = await fetch(`${base}/set-cookie`);
	assert.deepEqual(response.headers.getSetCookie(), ['a=1', 'b=2']);
});

test('二进制响应', async () => {
	const response = await fetch(`${base}/binary`);
	assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([0, 1, 2, 255]));
});

test('大响应体不会被截断', async () => {
	const response = await fetch(`${base}/big`);
	assert.equal((await response.text()).length, 200000);
});

test('请求前 abort 会拒绝', async () => {
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		fetch(`${base}/hello`, {signal: controller.signal}),
		error => error.name === 'AbortError',
	);
});

test('响应头到达后 abort 会中断 body', async () => {
	const controller = new AbortController();
	const response = await fetch(`${base}/slow`, {signal: controller.signal});
	controller.abort();
	await assert.rejects(async () => response.text());
});

test('response.body.cancel() 正常 resolve', async () => {
	const response = await fetch(`${base}/hello`);
	await response.body.cancel();
});

test('不支持的协议和错误码', async () => {
	await assert.rejects(fetch('ftp://example.com/'), /Unsupported protocol/);
	await assert.rejects(
		fetch(`${base}/switching`),
		error => error.name === 'TypeError',
	);
});

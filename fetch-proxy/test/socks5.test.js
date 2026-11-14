import {after, test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import {fetch} from '../fetch.js';
import {createSocks5Agent} from '../socks5-agent.js';
import {startSocks5Proxy} from './helpers/socks5-proxy.js';
import {selfSignedCert} from './helpers/selfsigned.js';

// 目标 HTTP 服务：无论从哪个入口进来都回显路径。
const target = http.createServer((req, res) => {
	res.writeHead(200, {'content-type': 'text/plain'});
	res.end(`target:${req.url}`);
});
await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
const targetPort = target.address().port;

const tlsCert = selfSignedCert('localhost');
const tlsTarget = https.createServer({key: tlsCert.key, cert: tlsCert.cert}, (req, res) => {
	res.writeHead(200, {'content-type': 'text/plain'});
	res.end('secure');
});
await new Promise(resolve => tlsTarget.listen(0, '127.0.0.1', resolve));
const tlsPort = tlsTarget.address().port;

const proxies = [];
async function proxy(options = {}) {
	const instance = await startSocks5Proxy({dial: {host: '127.0.0.1', port: targetPort}, ...options});
	proxies.push(instance);
	return instance;
}

after(async () => {
	target.closeAllConnections?.();
	tlsTarget.closeAllConnections?.();
	await Promise.all(proxies.map(p => p.close()));
	await new Promise(resolve => target.close(resolve));
	await new Promise(resolve => tlsTarget.close(resolve));
	http.globalAgent.destroy();
	https.globalAgent.destroy();
});

/** 等待一次 agent.createConnection，返回抓到的 CONNECT 请求信息。 */
function connectWith(agent, host, port = 80) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('createConnection 超时')), 5000);
		agent.createConnection({host, port}, (error, socket) => {
			clearTimeout(timer);
			if (error) {
				reject(error);
				return;
			}
			socket.destroy();
			resolve();
		});
	});
}

test('createSocks5Agent：按协议缓存并区分 http / https', () => {
	const getAgent = createSocks5Agent('socks5://127.0.0.1:1080');
	const a = getAgent(new URL('http://a/'));
	const b = getAgent(new URL('http://b/'));
	const c = getAgent(new URL('https://c/'));
	assert.equal(a, b, 'http 应复用同一个 agent');
	assert.notEqual(a, c, 'https 应使用另一个 agent');
	assert.equal(c, getAgent(new URL('https://d/')), 'https 应复用同一个 agent');
	a.destroy();
	c.destroy();
});

test('HTTP over SOCKS5：域名目标', async () => {
	const socks = await proxy();
	const agent = createSocks5Agent(`socks5://127.0.0.1:${socks.port}`);
	const response = await fetch(`http://localhost:${targetPort}/via-domain`, {agent});
	assert.equal(response.status, 200);
	assert.equal(await response.text(), 'target:/via-domain');
});

test('HTTP over SOCKS5：IPv4 目标使用 ATYP=1', async () => {
	let info;
	const socks = await proxy({onConnect: value => { info = value; }});
	const agent = createSocks5Agent(`socks5://127.0.0.1:${socks.port}`);
	await fetch(`http://127.0.0.1:${targetPort}/ip`, {agent});
	assert.equal(info.atyp, 1);
	assert.deepEqual([...info.addr], [127, 0, 0, 1]);
});

test('CONNECT：IPv6 目标编码为 16 字节 ATYP=4', async () => {
	let info;
	const socks = await proxy({onConnect: value => { info = value; }});
	const agent = createSocks5Agent(`socks5://127.0.0.1:${socks.port}`);
	const httpAgent = agent(new URL('http://x/'));
	await connectWith(httpAgent, '::1');
	assert.equal(info.atyp, 4);
	assert.equal(info.addr.toString('hex'), '00000000000000000000000000000001');
	httpAgent.destroy();
});

test('HTTP over SOCKS5：username/password 认证（含百分号解码）', async () => {
	const socks = await proxy({
		requireAuth: true,
		username: 'us er',
		password: 'p@ss',
	});
	const agent = createSocks5Agent(`socks5://us%20er:p%40ss@127.0.0.1:${socks.port}`);
	const response = await fetch(`http://example.com/auth`, {agent});
	assert.equal(response.status, 200);
	assert.equal(await response.text(), 'target:/auth');
});

test('HTTPS over SOCKS5', async () => {
	const socks = await proxy({dial: {host: '127.0.0.1', port: tlsPort}});
	const result = await fetch(
		`https://localhost:${tlsPort}/`,
		{
			socks5: `socks5://127.0.0.1:${socks.port}`,
			rejectUnauthorized: false,
		},
	);
	assert.equal(result.status, 200);
});

test('SOCKS5 认证失败会 reject', async () => {
	const socks = await proxy({requireAuth: true, username: 'user', password: 'pw'});
	const agent = createSocks5Agent(`socks5://user:wrong@127.0.0.1:${socks.port}`);
	await assert.rejects(
		fetch('http://example.com/', {agent}),
		/authentication failed/,
	);
});

test('没有可接受的认证方法会 reject', async () => {
	const socks = await proxy({method: 0xff});
	const agent = createSocks5Agent(`socks5://127.0.0.1:${socks.port}`);
	await assert.rejects(
		fetch('http://example.com/', {agent}),
		/no acceptable authentication method/,
	);
});

test('CONNECT 失败码会映射成可读错误', async () => {
	const socks = await proxy({reply: 5});
	const agent = createSocks5Agent(`socks5://127.0.0.1:${socks.port}`);
	await assert.rejects(
		fetch('http://example.com/', {agent}),
		/SOCKS5: Connection refused/,
	);
});

test('未知地址类型会 reject', async () => {
	// 正常代理不会回 atyp=9，这里直接用一个只会回错误 atyp 的假服务器
	const net = await import('node:net');
	const sockets = new Set();
	const fake = net.createServer(socket => {
		sockets.add(socket);
		socket.on('error', () => {});
		let stage = 0;
		socket.on('data', () => {
			if (stage === 0) {
				socket.write(Buffer.from([5, 0]));
				stage = 1;
			} else if (stage === 1) {
				socket.write(Buffer.from([5, 0, 0, 9, 0, 0, 0, 0, 0, 0]));
				stage = 2;
			}
		});
	});
	await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
	const agent = createSocks5Agent(`socks5://127.0.0.1:${fake.address().port}`);
	try {
		await assert.rejects(
			fetch('http://example.com/', {agent}),
			/unknown address type/,
		);
	} finally {
		for (const socket of sockets) socket.destroy();
		await new Promise(resolve => fake.close(resolve));
	}
});

test('CONNECT：IPv4-mapped IPv6 应编码为 ...ffff7f000001', {todo: '我草了这玩意真有人用吗'}, async () => {
	let info;
	const socks = await proxy({onConnect: value => { info = value; }});
	const agent = createSocks5Agent(`socks5://127.0.0.1:${socks.port}`);
	const httpAgent = agent(new URL('http://x/'));
	await connectWith(httpAgent, '::ffff:127.0.0.1');
	assert.equal(info.atyp, 4);
	assert.equal(info.addr.toString('hex'), '00000000000000000000ffff7f000001');
	httpAgent.destroy();
});

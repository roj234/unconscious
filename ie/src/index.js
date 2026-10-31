import path from 'node:path';
import http from 'node:http';
import {createServer} from './dev.js';
import {build} from './build.js';
import {resolveConfig} from './config.js';
import {createLogger, sendText} from './utils.js';
import {safeStat, serveFile} from "../utils/serveFile.js";
import {getContentType} from "../utils/mimeTypes.js";

/** 简单静态服务器，用于 ie preview */
export async function preview(options = {}) {
	const config = await resolveConfig({...options, command: 'build'});
	const outDir = path.resolve(config.root, options.outDir || config.build.outDir || 'dist');

	const log = createLogger('ie:preview');
	if (!(await safeStat(outDir)).isDirectory()) throw new Error(`目录不存在: ${outDir}（先运行 ie build）`);

	const server = http.createServer(async (req, res) => {
		let pathname = req.url.split('?', 1)[0];
		if (pathname.startsWith('/@fs/')) pathname = pathname.slice(4);
		let file = path.join(outDir, pathname);

		let stat = await safeStat(file);
		if (stat.isDirectory()) {
			file = path.join(file, 'index.html');
			stat = await safeStat(file);
		}
		// SPA路由兼容
		if (!stat.isFile() && (req.headers.accept || '').includes('text/html')) {
			file = path.join(outDir, 'index.html');
			stat = await safeStat(file);
		}
		if (!stat.isFile()) return sendText(res, 404, 'Not Found');

		await serveFile({ req, res }, {
			type: getContentType(file),
			lastModified: stat.mtimeMs,
			size: stat.size,
			volatile: true
		}, file);
	});

	const port = options.port ?? config.server.port ?? 4173;
	const host = options.host ?? config.server.host ?? 'localhost';

	await new Promise(r => server.listen(port, host, r));

	log.info(`http://${host}:${server.address().port}/`);
	return {
		server,
		close: () => new Promise(r => server.close(r))
	};
}

export const version = '0.1.0';
export {createServer, build, resolveConfig};
export * from "./plugin.js";

#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {build, createServer, preview, version} from './src/index.js';

const {values, positionals} = parseArgs({
	allowPositionals: true,
	options: {
		config: {type: 'string', short: 'c'},
		mode: {type: 'string', short: 'm'},
		port: {type: 'string', short: 'p'},
		host: {type: 'string', short: 'H'},
		outDir: {type: 'string', short: 'o'},
		help: {type: 'boolean', short: 'h'},
		version: {type: 'boolean', short: 'v'},
	},
});

if (values.help) {
	console.log(`ie ${version} — A bit more than half of vItE

用法:
  ie [dev] [root]        开发
  ie build [root]        构建
  ie preview [root]      预览

选项:
  -c, --config <file>    配置文件 (默认 vite.config.js)
  -m, --mode <mode>      模式 (development / production)
  -p, --port <port>      端口
  -H, --host <host>      监听地址
  -o, --outDir <dir>     输出目录
`);
	process.exit(0);
}
if (values.version) {
	console.log(version);
	process.exit(0);
}

const command = positionals[0] ?? 'dev';
const root = positionals[1] ?? process.cwd();
const common = {
	root,
	configFile: values.config,
	mode: values.mode,
	port: values.port ? Number(values.port) : undefined,
	host: values.host,
};

if (command === 'build') {
	await build({...common, outDir: values.outDir});
} else if (command === 'preview') {
	const server = await preview({...common, outDir: values.outDir});
	const close = () => server.close().then(() => process.exit(0));
	process.on('SIGINT', close);
	process.on('SIGTERM', close);
} else if (command === 'dev' || command === 'serve') {
	const server = await createServer(common);
	const close = () => server.close().then(() => process.exit(0));
	process.on('SIGINT', close);
	process.on('SIGTERM', close);
} else {
	console.error(`未知命令: ${command}`);
	process.exit(1);
}
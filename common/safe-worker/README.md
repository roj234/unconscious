
## safe-worker

10KB(minified)的零依赖JS沙箱

优点：
- 支持ESM (你可以当我写了一个ESBuild)
- 基于WebWorker (很安全)
- 与Host互操作 (通过ESM模块)
- 体积小
- 支持权限控制 (wasm, net, storage) 以及基于前缀的访问控制

缺点：
- 所有Host函数都是异步的，parser不会转换它们，需要主动在使用它们的代码里await
- 我觉得很安全（实际不排除存在风险的可能）
- 可能不支持某些特别新的语法
- OPFS没有访问控制，而且我直接删掉了caches和indexedDB的列举函数

示例：
```js
import {bundleModule, createModule} from "safe-worker";

const systemModule = new Map;
systemModule.set("host", { module: {
	hello() {
		return "hello from host module";
	}
} });

class Sandbox {
	instance;

	constructor(code) {
		this.code = code;
	}

	async call(method, args) {
		if (!this.instance) {
			this.instance = createModule(systemModule, null, this.code);
			await this.instance.ready;
		}

		let t;
		const result = this.instance.module[method](args);
		const timeout = new Promise((_, reject) => {
			t = setTimeout(() => {
				reject(new Error("脚本执行超时 (5s)"));
				this.instance.destroy();
				this.instance = null;
			}, 5000);
		});
		result.finally(() => clearTimeout(t));
		return Promise.race([result, timeout]);
	}
}

const createSandboxEnvironment = async (archive) => {
	const archiveModule = new Map(systemModule);
	archiveModule.set("script.js", { code: archive });
	// 可以在这个Map中添加更多模块
	// 控制权限并编译
	const code = bundleModule(archiveModule, 'script.js', 'mod_', ['wasm']);
	return new Sandbox(code);
}

createSandboxEnvironment(`
import {hello} from 'host';
export async function fn() {
	return await hello();
}

`).then(env => {
	env.call("fn").then(console.log);
});
```
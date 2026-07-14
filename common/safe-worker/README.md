
# safe-worker

24KB（minified）的零依赖 WebWorker 沙箱。
- 好吧，现在模拟模块越来越多了，fs，console，Buffer polyfill……都来了，以后体积显然会更大

优点：
- 模块按需加载 (替换上一个版本把所有模块打包到一起，然后动态生成Worker的方案)
- 非常安全，没有 eval 没有 AsyncGeneratorFunction 没有 import() 没有 setTimeout 字符串
- 与 Host（通过编程API）导出的模块互操作
- 体积小
- 控制台转发
- 模拟的 Node fs/promises, path 和 Buffer 模块
- 权限控制 (fs, wasm, net, db) 以及基于前缀的访问控制 (应用于 OPFS caches indexedDB)
- text 和 json 导入属性 `import text from './data.txt' with { type: 'text' }`

缺点：
- 所有Host函数都是异步的，parser不会转换它们，需要主动在使用它们的代码里await
- 循环引用只保证基础可用
  - 由于要使用合法的 JS 支持循环引用，同时相对来说要一点性能，我没有用 Proxy，而是直接用 lambda 更新
  - 代价是（反正你的IDE会报错的）你可以对导入的变量赋值！它们是 let 不是 const！
- 无 Live binding 机制

### 快速开始

```js
import { createSandbox } from "safe-worker";

const handlers = {
  // 模块加载器：沙箱内 import 文件时回调
  load: (moduleName, isSystemModule) => {
    if (isSystemModule) throw new Error('Module '+moduleName+' not found');
    // 返回模块源码字符串
    return fs.readFile(moduleName, 'utf-8');
  },

  // RPC 端点：沙箱内 fs.readFile() 等方法通过此通道调用主线程
  rpc: (method, args, transfer) => {
    // method: 'read' | 'write' | 'append' | 'mkdir' | 'delete' | 'list' | 'stat' | 'copy'
    // transfer: 用于零拷贝传输 ArrayBuffer
    return fileSystem[method](...args);
  },

  // 日志：沙箱内 console.log / error / warn 等回调
  log: (line) => {
    console.log('[sandbox]', line);
  }
};

// 只开放 fs 权限，不开放 net / wasm / db
const sandbox = createSandbox(handlers, ['fs'], { name: "test sandbox" });

// 初始化（启用 lockdown 安全限制）
await sandbox.initialize();

// 执行代码
await sandbox.execute(
  'inline.js',                         // 模块路径（用于相对导入解析）
  `
    import { readFile } from 'fs';
    const data = await readFile('./config.json');
    console.log('loaded:', data);
    export default JSON.parse(data);
  `,
  { /* this 上下文，通过 this.xxx 访问 */ }
);

// 在 Host 侧异步调用沙箱中的模块
const exports = await sandbox.loadModule('shared-utils');
const three = await exports.plus(1, 2);

// 销毁
sandbox.destroy('任务完成');
```

### 宿主模块

```js
const hostModules = new Map();
hostModules.set('host-api', {
  async fetchData(id) {
    const res = await fetch(`/api/${id}`);
    return res.json();
  }
});

const sandbox = createSandbox(handlers, ['fs'], { hostModules });
```

沙箱内代码：

```js
import { fetchData } from 'host-api';
const data = await fetchData(42);  // RPC 到主线程执行
```

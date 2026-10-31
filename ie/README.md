# ie

> （vItE 的一半，顺便致敬一下自己造轮子的 MSIE）

极简 Vite 类似物：支持我用到的所有API，并且能开发和构建。

依赖：
- `picomatch`：`createFilter`。
- `chokidar`：更好的 fs.watch
- `esbuild`
- `rollup`
- `postcss`

## 用法

```bash
ie dev
ie build
ie preview
```

兼容部分 vite 插件，提供部分 vite API，支持 HMR。

甚至默认配置也是 vite.config.js，原理也和 vite 差不多，只不过我不想要那么多依赖

> 没有不了解的功能 = 更少的漏洞

## 权衡

- 我爱ESM，所以没有什么CJS支持。
- 暂不支持 optimizeDeps 预打包步骤
- import 解析是 AI 写的 parser，可能不支持所有情况（很快会换成我的worker里面的）
- @fs 没有做权限控制，可以读取任意文件 —— 这又不是让你开放到公网的
- 稍微不同的 HMR 作用域算法，也许比 vite 好（WIP）
- 稍微不同的 modulePreload 实现
- 支持的 API 和选项都只是 vite 的一部分，并且不一定和 vite 完全兼容。
- 我会尽量做到回落。但既然我已经不用vite了，那就接受有一天配置会分叉吧
- 不支持 SSR 不支持 CJS 不支持 import.meta.glob 也不支持增量构建（vite真有这个吗？？）
- import.meta.hot.send 未实现
- 没有TypeScript相关功能，除了 strip
- 不支持 inline worker

## 方案

- esbuild 预处理 (仅 ts / tsx)
- transform
- rollup 打包
- esbuild 压缩

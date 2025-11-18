# Unconscious v1.7.0

'上一代' 轻量级响应式框架，直接操作真实 DOM，提供细粒度更新和高性能。专注于最小化运行时开销，支持现代函数组件和丰富的 JSX 扩展语法。
- Svelte家的Vue风味的React

## You have been warned
- [Injector.js](Injector.js)会修改node_modules中部分文件的内容
- - 修改了babel以暴露一些parser的内部API
- - 修改了Vite WebWorker Polyfill的代码，理论上不影响现代浏览器

## 特点

✅ **真实 DOM 操作**
- 放弃虚拟 DOM，直接修改真实 DOM 元素，实现属性/文本节点的精确更新
- 更多 JSX 灵活性：支持 React 之外的语法，如事件装饰器（结合 CSS 选择器和修饰符）和元素装饰器
- 示例：`<ol onclick.child(":scope>li").prevent={handler}>`，委托事件到特定子元素

📦 **微型体积**  
下面是未进行 tree-shaking 的大小

| 版本     | 功能范围                  | Minfied大小 |
|--------|---------------------------|-----------|
| Normal | 完整功能（包括动画、存储、异步） | 9.5KB     |
| Micro  | 基础 JSX 语法支持         | 1KB       |

⚡ **极速性能**
- 异步合并更新，减少重绘
- 细粒度响应式：浅代理模式（`$update` 手动触发）或自动依赖追踪（`$computed`）
- 列表渲染优化：`$foreach` 复用 DOM 元素，支持 key-based diff

🔥 **便捷现代**
- 原生支持 Vite 热重载（HMR），函数组件状态无缝迁移
- 带有完善的类型定义，支持 TypeScript 开发和构建
- 响应式动画管理（`$animate` 返回 Promise）
- 全局存储（`$store`）：LocalStorage 持久化 + 跨标签页同步
- 异步状态管理：`$asyncState` 处理 loading/error，`$asyncComponent` 懒加载

## 快速开始

### 安装
```bash
npm install
```

### 示例
Unconscious 采用函数组件设计，支持 props 和 children。使用 `preserveState` 标记内部状态为响应式（HMR 时状态迁移）。  
以下示例展示事件装饰器（`onclick.children`）和元素装饰器（`@styles`）。条件表达式 `? :` 是语法糖，会编译为 `$computed(() => ...)`。

```jsx
import {$state, $computed, preserveState} from "unconscious";
// 函数组件
export default function Counter() {
	// 响应式状态
	const count = preserveState($state(0));
	// 计算属性（自动追踪依赖）
	const double = $computed(() => count.value * 2);

	return <div onclick.children("button")={() => count.value++}>
        {count.value === 1 ? "Counts" : "Count"}: {count} (Double: {double}) <br />
        <button @styles={{color: "red"}}> +1 </button>
    </div>;
}
```

在项目中，直接导入并挂载：

```js
import {appendChildren} from "unconscious";
appendChildren(document.body, [<Counter/>]);
```

这些导出语法支持组件热更新
```js
export function Component() {}
export const Component = () => {}
```

这些导出语法支持重载，但不支持组件热更新，并有一些限制
```js
export default () => {}

// t 必须是 let或var，如果是const将在重载时报错
let t = '';
export {t}
```

### 全功能示例
- 点击查看[全功能示例](example/src/main.js)，这个示例使用了后面介绍的所有函数
- 要理解示例代码，我假设你对JSX语法有一定了解，使用或了解过Vue和React
- 本文中的示例由AI编写，我也不知道能不能跑，全功能示例是我写的，100%能跑

### 异步状态
- `$asyncState(fetcher, param?)`：管理 Promise 状态（`loading`、`error`、`value`）。参数变化时自动重取。
- `$asyncComponent(loader, loading, error)`：懒加载组件（`loading`/`error` 回调）。

示例：
```jsx
const state = $asyncState(async (page) => {
  const res = await fetch(`/api?page=${page}`);
  return res.json();
}, $state(1));

function List() {
  return (
    <div>
      {state.loading ? "加载中..." : state.error ? "错误" : state.value?.map(item => <div>{item}</div>)}
    </div>
  );
}
```

## API

### 响应式核心
| 方法                          | 说明                                                                 |
|-------------------------------|----------------------------------------------------------------------|
| `$state(obj, deep)`           | 创建响应式代理对象（`deep` 为 true 启用深度代理）                    |
| `$watch(target, callback, triggerNow)` | 监听变化，支持返回清理函数（`triggerNow` 默认 true 立即执行）        |
| `$computed(fn, lazy, dependencies)` | 创建计算属性（`lazy` 延迟计算；`dependencies` 手动指定依赖）         |
| `$unwatch(target, callback)`  | 取消监听                                                             |
| `$update(target)`             | 手动触发更新（支持数组，多变量共用监听器只触发一次）                 |
| `unconscious(reactive)`       | 获取响应式对象的原始值                                               |
| `isReactive(obj)`             | 检查是否为响应式对象                                                 |

### 工具函数
| 方法                          | 说明                                                                 |
|-------------------------------|----------------------------------------------------------------------|
| `appendChildren(parent, children)` | 插入子元素（支持响应式；触发 `append` 自定义事件，`detail` 为父元素） |
| `$foreach(array, renderFn, keyFn?)` | 动态列表渲染（复用 DOM，支持 key 函数优化 diff）                     |
| `$animate(element, options)`  | CSS 动画（返回 Promise，options: `{duration, easing, from, to}`）    |
| `$forElse(array, renderFn, emptyEl)` | 带空状态的列表（数组为空时显示 `emptyEl`）                           |


## 内置功能

### 元素装饰器
绑定响应式样式或类。

```jsx
const color = $state("#ff0000");
const bold = $state(false);

// 请注意，下面这些**全部**都是编译器实现的语法糖，使用它们有很多注意事项
// 1. 如果存在响应式的"style"或"class"，那么不应该再使用"style:xx"语法糖，否则它们会相互覆盖
// 2. 但是非响应式的"style"可以，例如
<div class="test" class:bold={bold}>非响应式属性可以和【响应式子属性】一起使用</div>
// 3. 默认style支持使用属性，例如
<div style={{fontSize: "16px"}}>style支持使用属性</div>
// 4. 但不支持响应式，你需要显式的写：
<div style:reactive={{color, fontSize: "16px"}}>style显式使用响应式属性</div>
// 这是为了优化性能的妥协，毕竟编译器很难确认这个参数是否是响应式的，但程序员很容易
// 5. class不支持直接用对象
<div class={{test: true}}>说真的，你写那么多true，却不使用响应式，很好玩吗（）</div>
// 6. 除非也响应式
<div class:reactive={{test: true, bold}}>class必须使用响应式属性才能用对象</div>

```

// 这是浏览器的处理  
响应式样式支持驼峰（`fontSize`）或连字符（`background-color`）格式。

### 事件装饰器
结合修饰符（`.prevent`、`.stop`、`.left` 等）和选择器（`.children("li")`、`.delegate(".btn")`）实现委托。

```jsx
<ol onclick.prevent.children(":scope>li")={(e) => console.log(e.delegateTarget)}>
  <li>点击我（仅直接 li）</li>
</ol>
```

- `.prevent`：`e.preventDefault()`
- `.stop`：`e.stopPropagation()`
- `.children(selector)`：直接子元素匹配
- `.delegate(selector)`：任意层级委托（`e.delegateTarget` 为匹配元素）
- `.left`/`.middle`/`.right`：鼠标键过滤
- 也可自定义，只要不是上述名称，就会调用作用域内的装饰器函数

### 动态列表
```jsx
const items = $state([1, 2, 3]);

function DynamicList() {
  return (
    <div>
      {$foreach(items, (item) => <button>{item}</button>, (item) => item)}
      {/* 或带空状态 */}
      {$forElse(items, (item) => <li>{item}</li>, <p>空列表</p>)}
    </div>
  );
}
```

支持异步：结合 `$forElseAsyncState` 处理 loading/error。

### 动画管理
响应式动画集成 Promise，便于条件渲染。

```jsx
const visible = $state(true);

const AnimatedBox = $computed((oldValue) => {
	if (!visible.value) {
		// 淡出并移除
		$animate(oldValue, {
			duration: 500,
			easing: "ease",
			from: {opacity: 1},
			to: {opacity: 0}
		}).then((success) => {
			if (success) return null; // 移除元素
		});
		return oldValue;
	}

	let newEl = oldValue || <div>动画内容</div>;
	cancelAnimation(newEl); // 中止旧动画

	$animate(newEl, {
		duration: 500,
		easing: "ease",
		from: {opacity: 0},
		to: {opacity: 1}
	});

	return newEl;
});
```

`cleanupAnimation(el)` 中止动画，返回 Promise 以 `false` 拒绝。

### 全局存储
响应式 + 持久化，支持跨标签页同步。

```jsx
const user = $store('user', { name: '游客', token: '' }, { persist: true });

// 自动保存到 LocalStorage（配置立即或延迟）
user.name = "用户";
user.token = "123456";
```

配置（Vite 环境变量）：
```js
// 命名空间前缀
UC_PERSIST_STORE = 'myapp'; // 默认 'default'

// 立即保存（true）或延迟（false：beforeunload/visibilitychange/60s）
UC_IMMEDIATE_STORE = false;

// 启用 Fragment
UC_REACTIVE_FRAGMENT = false;
```

序列化：默认 JSON，支持自定义（e.g., `AS_IS` 用于简单类型）。

## 响应式元素细节

### `appendChildren`
**必须使用**此函数添加响应式根节点，支持动态消失逻辑。

```js
appendChildren(document.body, [<Counter />, "文本"]); // 支持 Fragment

// 自定义事件：元素添加时触发
el.addEventListener("append", (e) => {
  console.log("父元素:", e.detail);
});
```

对比原生 `appendChild`：后者无法处理响应式更新（如元素变为 null/移除）。

### Fragment 支持
响应式变量可返回数组(Fragment)，如果未用到可以禁用UC_REACTIVE_FRAGMENT减少打包大小

## 开发与生产
- 很多错误检查只在开发时有效，请注意，如果【忽略开发时的错误】可能在production中造成内存溢出、死循环等问题
- Baseline widely available: Chrome 107

*Unconscious：觉醒你的 DOM。*
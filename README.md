# Unconscious (蕨了)

'上一代' 轻量级响应式框架，直接操作真实 DOM，提供细粒度更新和高性能。专注于最小化运行时开销，支持现代函数组件和丰富的 JSX 扩展语法。
- 参考Svelte的Vue风味React

## 设计哲学

- `unconscious` 是本框架核心函数的名称
  - 它从响应式对象中提取不具备更新能力的原始对象
  - 因为响应式对象是"有意识的"，它知道自己什么时候要更新，原始数据是"无意识的"
- 这个框架和它的名字一样——没有自己的意识。它不替开发者做决定。开发者*需要*清醒地知道每一行代码在做什么。
  - 事件监听没有包装，没有代理（除非你自己在修饰符里加），你自己决定挂在哪个元素上，不会替你提升到window
  - 响应式不是自然而然的，你只能用 {reactiveVariable} 或者 {() => ...} 这两种语法，后者自动生成一个计算属性
    - 否则，它们只会在调用时执行一次
- 它不是让你轻松写出高性能应用的框架，也不能让你用更少的代码写出应用，甚至AI也不懂它；
- 它只是一个诚实的框架：如何操作DOM，请*自己*决定。
- 我不建议在任何协作项目中使用这个框架，它是为一个人理解所有代码的项目设计的。

## 特点

⚡ **高性能**
- 不使用虚拟DOM，不存在Diff过程，元素何时更新、如何更新完全由开发者决定。
- 这带来的是更高的性能，更小的内存，以及极高的开发难度（至少对比React和Vue那些宝宝巴士来说）
- 但我还是希望能确定的知道代码会干什么，而不是“修改的VDOM会在下一个微任务上进行Diff并选择性更新”

📦 **轻量级**  
下面是未进行 tree-shaking 的大小

| 版本     | 功能范围                  | Minfied大小 |
|--------|---------------------------|-----------|
| Normal | 完整功能（包括动画、存储、异步） | 9.5KB     |
| Micro  | 基础 JSX 语法支持         | 1KB       |

🔥 **现代化**
- 更多 JSX 灵活性：支持 React 之外的语法，如事件装饰器（结合 CSS 选择器和修饰符）和元素装饰器
  - 示例：`<ol onclick.child(":scope>li").prevent={handler}>`，委托事件到特定子元素
- 支持 Vite 热重载（HMR）
- 完善的类型定义，支持 TypeScript 开发和构建
- 提供大量开箱即用的附加模块，例如动画管理，store，Promise组件，虚拟列表等

❌ **文档缺失和过时**
- 单人项目的宿命，因为更新文档对我来说是一个完全没有回报的事情
- 所以，有什么新功能自己翻 commit history 吧

## 快速开始

### 安装
```bash
npm install
```

### 示例
一个计数器组件，我尽可能多的使用了不被IDE兼容的语法糖，这些糖有的我写了IDE兼容的workaround，但很不幸没有文档

```jsx
import {$state, $computed, unconscious} from "unconscious";
// 函数组件
export default function Counter() {
	// 响应式状态
	const count = $state(0);
	// 计算属性（自动追踪依赖）
	const double = $computed(() => count.value * 2);

	return <div onclick.children("button")={() => count.value++}>
        {() => unconscious(count) === 1 ? "Counts" : "Count"}: {count} (Double: {double}) <br />
        <button @styles={{color: "red"}}> +1 </button>
    </div>;
}
```

### 示例
- 要理解示例代码，我假设你对JSX语法有一定了解，使用或了解过Vue和React
- 点击查看或者在本地运行[全功能示例](example/src/main.js)，这个示例使用了后面介绍的所有函数
- 示例也可能过时，另外现在不建议使用 `x.value` 取值，请使用 `unconscious(x)`

## API

请直接阅读 `types.d.ts`  
它控制 IDE 补全，所以是我唯一积极维护的【文档】  
很多新 API 都没有在示例中出现，毕竟它是两年前写的了，例如 $vforeach $stampLock $derived 等  
可以直接看我其他项目怎么用的。

还有一些事：
- `a && b` 会被翻译成 `a ? b : null`
- HMR 不是只应用于模块的，它处理所有JS代码，并且使用的是类似代理模块的方案（vite 自己都说不建议）
- 因此很容易因为 stale reference 造成该整页刷新的时候没刷新。例如JS模块重载后，旧的class实例还是旧模块
- 我从来不用深度响应，它已经被 $derived 和 $computed 部分取代，主要是它不符合这个框架整体的设计哲学，因此，它可能在未来被删除。
- 为了实现JSX新语法，我会修改node_modules的代码，当然你可以使用pnpm，因为这些修改都是opt-in的不破坏原版功能。

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
- 最低浏览器: Chrome 107

## common 文件夹
这个文件夹里有很多有意思的东西 (换句话说，这是 JavaScript 版本的 [RojLib](https://github.com/Roj234/RojLib))
- deepEqual
- msgpack
- NestedMap
- json-schema-utils
- StreamJsonParser
- zip-io

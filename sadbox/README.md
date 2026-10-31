# @roj234/sadbox: Agent放手去做，Overlayfs替你兜底

## 简介

> 一个"不需要权限提升"的沙箱。

不像某些Agent沙箱，它们拒绝写入，审批命令，这个沙箱方案给你一种截然不同的体验。

它不是最安全的：
- 它无法防止Host层的LPE（当然，那些仅仅拒绝写入的沙箱也不行）
- 它也无法防止那些不 well-known 的秘密泄露，他能防止 cat /etc/passwd 但不能防止你的 api 密钥放在桌面上
- 大部分沙箱，都能阻止Agent恶意或意外的运行命令，读取敏感文件或破坏操作系统。

但它：
- 能防止 Agent 犯傻：沙箱内所有文件操作都不影响宿主，这意味着即便误删整个工作区、包括.git，都能一键恢复。
- Agent 的需求是无法预知的，比起"执行时协商"的权限模型，我更喜欢在结束时裁决，一次决策代替 N 次打断，解放你的双手。
- 就像在新分支开发，提交，最后只 cherry-pick 工作区内的文件到 host，其它修改全部丢弃——其实不是丢弃，因为根本没有"修改"。

naming sadbox: Agent 辛辛苦苦写了几百K的 token 被你撤回时，它是否也会哭泣？

## API

```js
import { createSandbox, isSandboxed } from 'sadbox'

// path 可省略，除非 Sandboxie 安装在非默认位置
const manager = createSandbox({ path: 'C:/Program Files/Sandboxie-Plus' })
// 显式命名空间：createSandbox({ namespace: 'my-project' })

const box = manager.create('test', {
  fileWhitelist: ['C:/Users/me/Documents'], // -> WriteDirectPath（直写）
  fileBlacklist: ['C:/Windows/System32/x'], // -> ClosedFilePath（禁读）
  network: false,                            // -> BlockNetworkFiles + Template BlockPorts
  storagePath: 'D:/sandbox-storage',         // -> FileRootPath（绝对路径，原样使用）
})

const pid = box.start(['notepad.exe', 'a.txt'])   // 返回进程 PID
box.start('raw "command line" string')            // 原始字符串透传
box.start(['node', 'run.js'], { cwd: 'D:/work' }) // 指定工作目录
// Linux 上 start() 是异步的：await box.start([...])

box.kill(pid)          // boolean
box.killAll()
box.listPids()         // number[]
box.getStoragePath()   // 沙箱存储根（绝对路径）

manager.list()         // 仅本命名空间内的沙箱
manager.delete(id)
manager.deleteAll()
```

## 命名空间隔离（namespace）

- `namespace` 缺省为使用方项目根（`node_modules` 的上级目录），每个项目有独立命名空间，
  `deleteAll()` 只删除本命名空间内的沙箱。显式传 `namespace` 可固定命名空间，
  项目目录移动后已有沙箱仍可管理。
- `id` 最大长度为20字符，不得包含任何 charCode <= 32 的字符

## 与原始设计的差异

| 项 | 设计 | 实现 |
| --- | --- | --- |
| 运行时 | 纯 JS、零依赖 | 原生 Node-API 插件（C） |
| Windows 配置管理 | SbieIni.exe + 串行写队列 | napi 调用 SbieDll.dll |
| 提权 | 管理员子进程 IPC 桥 | 略过，实际无需管理员即可管理沙箱 |
| 平台 | windows/linux/macOS 三实现 | Windows（SbieDll）+ Linux（bwrap + overlayfs），macOS 待做 |

## Windows 架构

- 所有操作直接调用 Sandboxie 用户态 API（`SbieDll.dll`），不经过 `Start.exe`，它是 Win32 应用程序，在控制台会话上，错误=弹窗=永久挂起。
- JS 层负责命名空间解析、命令转义等，核心逻辑位于 napi 层
- 插件只用 Node-API（ABI 稳定），用 Node v24 编译在 Node v20 加载运行，不需要重新编译。
- 依赖 x64 机器，已安装的 `SbieDll.dll`，Node ≥ 16（编译用 `NAPI_VERSION=8`）。

## Linux 架构

> Linux代码为100%AI生成，只保证能用（我在VM里让它测试了），不保证可靠性、性能等

Linux 的 API 有以下问题，之后再修：
- AI不知道犯什么蠢非要把前缀语义做的和windows一样，linux连盘符都没SHA怎么可能一样
- 创建了一大堆临时挂载点，可能影响文件系统性能（我也不知道）
- 创建了一大堆环境变量，我也不知道要干啥
- 靠创建文件传递PID，有些过于low了
- 中心化的 registry.json 根本没处理并发读写，多进程可能直接丢数据
- path参数被吞掉了总是放在什么 .local 里面——我本来想让它接收 bwarp 可执行文件位置什么的吗，感觉不如指定这个目录的位置

- 运行时为 `bwrap`（bubblewrap），COW 采用 overlayfs：
  - root 下用内核 overlayfs（`mount -t overlay`）；
  - 非 root 下用 `fuse-overlayfs`（内核 overlayfs 无法在用户命名空间内挂载，
    这是 rootless 容器的标准做法），走 `/dev/fuse`，同样无需提权。
- 沙箱内先以 bwrap 建好 mount/pid/net/user 命名空间，helper
  （`src/linux-helper.sh`）把宿主根只读视图挂为 overlay lower，
  沙箱目录的 `upper/ work/` 挂为 upper/work，再 chroot 进合并视图；
  白名单路径以 RW bind 直写宿主，黑名单路径以空 tmpfs 或 `/dev/null` 遮蔽。
- 进程模型：`bwrap` 与目标程序全程 `exec`（PID 不变），`start()` 返回的
  pid 就是沙箱内进程；`--unshare-pid` 使目标为 pid ns 的 init，
  kill 它即清空整个沙箱，`killAll()`/`delete()` 因此可靠。
- `listPids()` 通过 `/proc/*/ns/pid` 的命名空间 inode 匹配进程。
- 安全收尾：chroot 后 `setpriv --bounding-set=-all` 丢弃全部 capabilities，
  防止逃逸 chroot 或卸载 COW 层。用户命名空间内 uid 0 映射宿主用户，
  **权限不提升**。
- `start()` 在 Linux 上为 **async API**：返回 `Promise<pid>`，使用 `await box.start([...])`。
  bwrap 会 fork 子进程执行目标，宿主 pid 通过 `--json-status-fd` 获取；
  helper 挂载完成后写 ready 标记，JS 侧异步轮询（≤10s），失败读 `setup.log` 抛 `ESTART`。
  （Windows 版 `start()` 仍为同步返回 pid。）

### Linux 依赖与预检

| 依赖 | 场景 |
| --- | --- |
| `bwrap` | 必选（`apt install bubblewrap`），可用 `SADBOX_BWRAP` 覆盖 |
| root 或 `fuse-overlayfs` | COW 实现；`SADBOX_FUSE_OVERLAYFS` 可覆盖 |
| `/dev/fuse` | 非 root 时 |
| 非特权用户命名空间 | 非 root 且 bwrap 未 setuid 时（`kernel.unprivileged_userns_clone=1`） |

存储根默认 `$SADBOX_STORAGE` 或 `~/.local/share/sadbox`（Windows 上为沙箱
配置的 `FileRootPath`）。`createSandbox({path})` 的 `path` 参数在 Linux 上忽略。

Linux 实现为纯 JS（`src/linux-impl.js`），无需编译、无 prebuilds。

## Windows 限制

限制来自 Sandboxie 自身行为，与实现语言无关。

- 本库应在宿主（非沙箱）进程中运行。在沙箱内，`create`/`delete` 被 SbieSvc 以
  `STATUS_NOT_SUPPORTED` 拒绝，`list()` 返回空，`listPids` 枚举的是调用者所在沙箱。
- `killAll`、`delete`、`deleteAll` 拒绝作用于调用者当前运行所在的沙箱。
- 进程枚举上限为 512（`API_MAX_PIDS`）。
- `start()` 不支持 `env`（SbieDll_RunSandboxed 无环境变量参数）。
- 配置上锁（ConfigLock）检测没有稳定的 C 导出函数。

## 构建

```bash
npm run build
npm test
```

默认路径可通过环境变量覆盖，包括 `TOOLCHAIN`（llvm-mingw 目录）、`NODE_EXE`、
`NODE_HEADERS`（默认仓库内 include/node）。

测试需要宿主进程和真实 Sandboxie，在沙箱内运行时自动跳过。

## 路线图

- Windows 已完成：基于 SbieDll
- Linux 已完成：bwrap + overlayfs（root：内核 overlay；非 root：fuse-overlayfs）。
  详见 `docs/linux-design.md`。
- macOS 待做：占位符。

TODO: 资源限制，内存，磁盘IOPS，CPU
- Sandboxie已天生支持资源限制，但不支持IOPS限制
- Linux需要cgroup

## 许可证

MIT

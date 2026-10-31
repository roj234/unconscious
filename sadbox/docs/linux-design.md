# sadbox Linux 实现设计

> 目标：在不改动对外 API（`src/sadbox.js` / `src/sadbox.d.ts`）的前提下，
> 为 Linux 提供与 Windows 版语义一致的 COW 全权沙箱：
> **bwrap（bubblewrap）+ overlayfs**，非特权运行。

---

## 1. 现状分析（Windows 实现是怎么工作的）

### 1.1 分层

```
sadbox.js（ESM 入口，平台分发 + 命名空间解析）
   └── win-impl.js（JS 壳：加载 prebuilds/win32-x64/sadbox.node、
                    命令转义、Sandbox 包装 Proxy）
        └── win-impl.c（Node-API 原生插件）
             └── SbieDll.dll（Sandboxie 用户态 API，运行时动态加载）
```

- `sadbox.js`：`switch (process.platform)` 选择实现，Windows 之外直接 throw；
  命名空间默认值 = `node_modules` 上级目录（项目根），并透传给实现层。
- `win-impl.js`：只做三件事——加载预编译 `.node`、把 `start()` 的
  字符串/数组参数转成 Windows 命令行、把原生对象包一层 Proxy。
- `win-impl.c`：核心逻辑全在 C 里（命名空间前缀、id 校验、策略落盘、
  进程枚举、kill、删除），全部通过 `SbieDll_*` / `SbieApi_*` 调用 Sandboxie。

### 1.2 关键语义（Linux 必须保持等价）

| 语义 | Windows 实现 | 说明 |
| --- | --- | --- |
| 命名空间 | 前缀 `SJ_` + `sha256(namespace)` 前 16 hex + `_`，id ≤ 20 且不含 ≤32 的字符 | `section = 前缀 + id`，`deleteAll`/`list` 只扫本前缀 |
| fileWhitelist | `WriteDirectPath` | 直写宿主，不进 COW |
| fileBlacklist | `ClosedFilePath` | 禁读/禁访问 |
| network=false | `BlockNetworkFiles` + `Template BlockPorts` | 断网 |
| storagePath | `FileRootPath`，原样使用、创建父目录 | 沙箱存储根 |
| start | `SbieDll_RunSandboxed`，返回 pid；支持原始字符串（命令行）或数组 | |
| kill/killAll/listPids | Sbie 进程枚举 | |
| getStoragePath | 解析后的沙箱根（绝对路径） | |
| 自毁保护 | `guard_self_destruction`：拒绝 kill/delete 自己所在的沙箱 | |
| 幂等 create | 先删旧配置行再写新策略 | 重复 create 等同 re-apply |
| 诊断 | `getVersion` / `getBoxPath` | 仅调试用 |
| isSandboxed | SbieApi_QueryProcess(当前进程) == 0 | |

### 1.3 平台无关注意点

- 前缀哈希必须与 Windows 一致（UTF-16LE 字节的 SHA-256 前 8 字节 hex），
  这样同一命名空间在双平台上得到相同沙箱名，便于迁移。
- `start()` 是**同步返回 pid** 的 API，Linux 实现也不能改异步（见 §5.2 就绪握手）。
- 出错码风格：`ESBIEDLL` / `EARG` / `ESTART` / `ESELF` 等保持一致。

---

## 2. Linux 技术选型

### 2.1 沙箱运行时：bwrap（bubblewrap）

- 非特权创建 mount / pid / net / user namespace，无需 root（userns 可用时）。
- `bwrap ... -- cmd args`：bwrap 完成 setup 后 `exec` 目标，**PID 不变**，
  正好满足 `start()` 返回"沙箱内进程 PID"的契约（详见 §5.1）。
- 依赖清单：`bwrap`（必选）、`chroot`（coreutils/busybox）、
  非 root 时 `fuse-overlayfs` + `/dev/fuse`；root 时可用内核 overlayfs。

### 2.2 COW 层：overlayfs 的两种挂法

**关键事实：内核 overlayfs 没有设置 `FS_USERNS_MOUNT`，无法在用户命名空间里挂载**
（这也是 rootless podman 改用 fuse-overlayfs 的原因）。因此：

| 场景 | COW 实现 | 说明 |
| --- | --- | --- |
| root（初始 userns 有 CAP_SYS_ADMIN） | 内核 `mount -t overlay` | 快、无额外依赖；用 `trusted.*` xattr |
| 普通用户（Agent 常态） | `fuse-overlayfs` | 走 FUSE，天然支持 user ns；用 `user.*` xattr |

helper 根据 `SADBOX_ROOT` 自动二选一，优先内核 overlay，否则 fuse-overlayfs。

### 2.3 overlay upper 不能位于 lower 内部（重叠检查）

内核与 fuse-overlayfs 都会拒绝 **upperdir 位于 lowerdir 路径之内**（"overlapping
lower and upper path"）。因为 lower 是"整个宿主根"，任何放
`~/.local/share/sadbox` 下的 upper 都在 lower 里 → 冲突。解法（见 §3 挂载布局）：
**lower 挂到 `/lower` 这个独立顶层路径，upper/work 绑到 `/sadbox-upper`、`/sadbox-work`**，
三者是不同 mount，路径互不从属，天然规避重叠检查。

### 2.4 网络

- `--unshare-all` 已含 `--unshare-net`；`network: true` 时追加 `--share-net` 恢复宿主网络；
  `network: false` 保持 net ns 隔离（仅 loopback），等价于 BlockPorts。

---

## 3. 挂载布局（核心）

```
bwrap --unshare-all [--share-net]
  --ro-bind / /lower            # 宿主根只读视图 = overlay lower 层
  --bind <沙箱目录> /sadbox-meta   # ready / setup.log / whitelist.map 等宿主可见文件
  --bind <沙箱目录>/upper /sadbox-upper   # overlay upperdir（COW 落盘处）
  --bind <沙箱目录>/work  /sadbox-work    # overlay workdir
  --bind <白名单路径> /sadbox-wl-0 …      # 直写源（RW），按索引与 whitelist.map 对应
  [--bind /dev/fuse /dev/fuse]           # 非 root + fuse-overlayfs 时
  --proc /proc --dev /dev --tmpfs /tmp
  --setenv SADBOX_* …
  -- /lower/bin/sh /lower<包路径>/linux-helper.sh -- <命令 argv…>

linux-helper.sh（在 userns 内以 uid 0 运行，先于 payload）：
  mount overlay lowerdir=/lower upperdir=/sadbox-upper workdir=/sadbox-work /merged
  mkdir + mount proc/sys/dev/tmp/run/dev/shm 于 /merged 内（虚拟文件系统不进 lower）
  对白名单路径：mount --bind /sadbox-wl-N  /merged<路径>   # 直写宿主
  对黑名单路径：目录→tmpfs 覆盖；文件→/dev/null 覆盖        # 禁读
  echo ready > /sadbox-meta/ready                          # 宿主同步轮询
  chroot /merged + setpriv 丢弃全部 capabilities → exec 目标
```

要点：

1. `/lower` 是"整个宿主根"的**只读**视图，overlay lower 用它；
   沙箱内 `/` 的 COW 视图 = `/merged`，`chroot /merged` 后一切写入进 upper。
2. 单独文件系统（独立分区/NFS）上的路径不在 `/lower` 视图内；
   sandbox 目录本身通过独立的 `/sadbox-meta`、`/sadbox-upper`、`/sadbox-work`
   bind 挂入，因此 **storagePath 可以放在任意文件系统**（包括 `/dev/shm`）。
3. 白名单直写：先在 ns 根部用 `--bind <宿主路径> /sadbox-wl-N` 得到 RW 源，
   再由 helper 覆盖到 `/merged` 对应位置（覆盖 COW 视图）。
4. 黑名单禁读：目录被空 tmpfs 遮住（内容 ENOENT），文件被 `/dev/null` 遮住；
   与 Sandboxie `ClosedFilePath`"拒绝访问"语义近似（目录本身可见但为空）。
5. 丢 caps：`setpriv --bounding-set=-all --inh-caps=-all --no-new-privs`
   在 chroot **之后**执行，防止 payload 利用 CAP_SYS_CHROOT/CAP_SYS_ADMIN
   逃逸 chroot 或卸载 COW 层直写宿主（`/lower` 是只读的，逃逸也只能读）。

---

## 4. API 映射表（linux-impl.js）

| API | 实现 |
| --- | --- |
| `createSandbox({namespace, path})` | preflight 探测（bwrap / fuse-overlayfs / /dev/fuse / userns 探针）；`path` 在 Linux 忽略（文档说明） |
| `manager.create(id, policy)` | `SJ_<hash16>_<id>` 目录 + `upper/ work/ merge/` + `meta.json`；`storagePath` 作为该沙箱独立 base；写 `registry.json` 索引（保证 `list()` 能找到自定义存储路径的沙箱） |
| `manager.list()` | 读 `registry.json`，过滤本前缀 |
| `manager.delete/deleteAll()` | `killAll()`（自毁保护）→ `rm -rf` 沙箱目录 + 更新 registry |
| `box.start(cmd, {cwd})` | 数组→直接 argv；字符串→`/bin/sh -c`（对应 Windows 原始命令行语义）；组装 bwrap argv，spawn，同步就绪握手，记录 pid |
| `box.kill(pid)` | 先确认 pid 属于本沙箱 pid ns，再 SIGKILL；不存在返回 false |
| `box.killAll()` | SIGKILL 该 pid ns 内全部进程（杀掉 ns init 即全灭）+ 记录中的 pid |
| `box.listPids()` | 读 `/proc/*/ns/pid`，与记录的 init pid 的 ns inode 比对 |
| `box.getStoragePath()` | 沙箱目录（绝对路径） |
| `getVersion()` | `bwrap --version`（失败回退 sadbox 版本号） |
| `getBoxPath(name)` | `{root, upper, work, merge}`（对应 Windows `{file,key,ipc}`） |
| `isSandboxed` | `SADBOX=1` 环境变量 或 `/proc/self/ns/pid ≠ /proc/1/ns/pid` |

---

## 5. 进程模型

### 5.1 PID 语义

`spawn('bwrap', …)` 的 pid 就是沙箱内目标程序的 pid：

```
bwrap ──exec──> /bin/sh helper ──exec──> chroot ──exec──> setpriv ──exec──> sh -c ──exec──> 目标程序
（全程 exec，pid 不变）
```

`--unshare-all` 含 `--unshare-pid`：目标程序是该 pid ns 的 init（ns 内 pid 1）；
**kill init → 内核清空整个 ns**，`killAll()` 因此可靠。

### 5.2 同步就绪握手（start 保持同步）

- helper 完成全部 mount 后写 `/sadbox-meta/ready`（宿主可见）；
- JS 侧 `Atomics.wait` 分片轮询（≤10s）：ready 出现 → 返回 pid；
  进程先退或超时 → 读 `setup.log` 抛出 `ESTART`。
- 目标程序 stdout/stderr 直接 `inherit` 到终端（Windows 版是 SW_HIDE，Linux 版保留输出更实用）。

### 5.3 listPids

- 记录 `pids` 文件（init pid 提示）；
- `listPids()` 对 `/proc/*/ns/pid` 求 inode，与记录的 ns inode 匹配。
  同 uid 进程可读，无需 root。pid 复用风险：kill 前二次校验 ns inode。

---

## 6. 权限、安全边界与依赖

### 6.1 权限模型

- 非 root：userns 内 uid 0 ↔ 宿主普通用户，**权限不提升**；
  写 upper 落盘后属主仍是宿主用户（"cherry-pick" 文件可直接用）。
- root：内核 overlayfs，行为一致，只是挂载实现不同。
- `setuid` 程序（sudo 等）在 userns 内对映射外的 uid 无效，天然免疫。

### 6.2 与 Windows 相同的定位

> 防"Agent 犯傻"，不防 LPE、不防同 uid 恶意代码读宿主文件
> （读宿主 = 不屏蔽即可见，与 Sandboxie 默认行为对齐；可用 fileBlacklist 显式关闭）。

### 6.3 依赖与预检（preflight）

| 依赖 | 用途 | 缺失时的错误提示 |
| --- | --- | --- |
| `bwrap` | 沙箱运行时 | 提示安装（apt/dnf install bubblewrap）或 `SADBOX_BWRAP` |
| root 或 `fuse-overlayfs` | COW | 提示安装 fuse-overlayfs 或改以 root 运行 |
| `/dev/fuse`（非 root） | FUSE 挂载 | 提示设备缺失 |
| userns 可用（非 root、非 setuid bwrap） | ns 隔离 | 探针 `bwrap --unshare-all --ro-bind / /lower -- true`；提示 `kernel.unprivileged_userns_clone=1` |

环境变量覆盖：`SADBOX_STORAGE`（默认 `~/.local/share/sadbox`）、`SADBOX_BWRAP`、
`SADBOX_FUSE_OVERLAYFS`。

---

## 7. 边界情况

1. **upper 位于 lower 内** → 用 `/lower` + `/sadbox-upper` 布局规避（§2.3）。
2. **storagePath 在独立文件系统** → 通过独立 bind（`/sadbox-meta` 等）挂入，不受 `/lower` 限制。
3. **userns 被内核禁用**（Debian 默认）→ preflight 报错并给 sysctl 提示；或安装 setuid bwrap。
4. **overlay 需要 xattr**：root 用 trusted.*；非 root 的 fuse-overlayfs 用 user.*（无需配置）。
5. **workdir 残留**（上次异常退出）→ start 时若该沙箱无存活进程则清空 workdir。
6. **id 校验**：与 Windows 一致（≤20、无 ≤32 字符），另拒绝 `/`（目录安全）。
7. **原始字符串命令** → `/bin/sh -c`；数组 → argv 直传（无需转义）。
8. **cwd**：默认 `process.cwd()`（在 merged 内解析），不存在时回退 `/`。
9. **/proc、/sys、/dev、/tmp 不进 lower**（宿主是独立 mount），helper 在 merged 内重建。
10. **无 pty**：与 Windows 一致（无控制台）；需要时可后续加 pty 支持。

---

## 8. 验证计划

- preflight 失败路径：bwrap 缺失 / fuse 缺失 / /dev/fuse 缺失 / userns 禁用。
- 生命周期：create → start(sleep) → listPids 可见 → kill → killAll → delete。
- COW 语义：沙箱内写 `/workspace` 文件 → 宿主对应路径不变；删除沙箱目录后写消失。
- 白名单：写入 whitelist 路径 → 宿主直接可见。
- 黑名单：`cat /etc/passwd`（黑名单内）→ 无内容/失败。
- 网络：`network:false` 时 `curl` 外部失败、loopback 正常。
- 自毁保护：沙箱内调用 killAll/delete 抛 `ESELF`。
- 恢复：`deleteAll` 只清理本命名空间。

---

## 9. 文件清单（改动）

| 文件 | 动作 |
| --- | --- |
| `src/linux-impl.js` | 新增：Linux 纯 JS 实现（零编译，无需 prebuilds） |
| `src/linux-helper.sh` | 新增：沙箱内挂载/安全 helper |
| `src/sadbox.js` | 修改：`case 'linux'` 分发 |
| `test/linux.test.js` | 新增：Linux 生命周期测试（非 Linux 自动 skip） |
| `test/host.test.js` | 修改：Windows 专属用例加平台门 |
| `README.md` / `package.json` | 更新平台状态与依赖说明 |

---

## 10. 路线图

- **Linux 已完成**：bwrap + overlayfs（root：内核 overlay；非 root：fuse-overlayfs）。
- macOS 待做：占位（可选 bwrap-mac 或自行实现 seatbelt/proot 方案）。

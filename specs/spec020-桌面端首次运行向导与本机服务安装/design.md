# 设计文档 - 桌面端首次运行向导与本机服务安装

状态：Draft

## 1. 概述

### 1.1 目标

- 让桌面客户端在没有服务可连时，用图形界面引导用户把服务装好或连上，全程不需要终端。
- 把"装服务"这件事收敛成一份跨平台 Node 脚本，桌面端和 `install.sh` 共用，不再各写一套。
- 补齐开机自启在 Windows 上的空缺，并把自启从 pm2 换成操作系统自带机制。
- 让安装过程可见、可取消、可重试，失败能说清是哪一步出的问题。

### 1.2 覆盖需求

- `requirements.md` 需求 1：首次运行的角色选择
- `requirements.md` 需求 2：客户端模式的连接引导
- `requirements.md` 需求 3：服务端模式的一键安装
- `requirements.md` 需求 4：服务端参数设置
- `requirements.md` 需求 5：连不上服务时的首屏引导
- `requirements.md` 需求 6：install.sh 接入统一安装器

### 1.3 技术约束

- 前端：React + TypeScript，只改 `apps/user-app`，文案走统一 i18n 字典。
- 界面规范：向导是整页流程，不是模态框；其中"查看安装日志""确认重新安装"这类浮层必须用现有 `DesktopModal`（移动端用 `MobileSheet`），不得手写弹层壳。动手前先读 `docs/开发设计规范/20260419-前端页面与样式设计规范.md` 和 `docs/开发设计规范/20260419-模态框与按钮设计规范.md`。
- 桌面壳：Tauri v2（Rust），命令注册在 `apps/desktop/src-tauri/src/lib.rs` 的 `invoke_handler`。前端普通命令调用走 `apps/user-app/src/platform/platform-adapter.ts` 的 `invokeDesktopCommand`（内部直接调 `window.__TAURI_INTERNALS__.invoke`，返回 `{ok, value}` 或 `{ok, errorCode, detail}`）；`desktop_bridge_plugin.rs` 注入的 `window.CodingNSDesktop` 只用于 iframe / 预览场景转发，新增普通命令不需要动它。
- 桌面壳当前**没有** shell 执行权限，也没有 sidecar，执行安装必须新增 Rust 命令。
- 前端已有 Tauri 事件监听先例：`apps/user-app/src/platform/platform-provider.tsx:160` 通过动态 `import("@tauri-apps/api/event")` 订阅 Rust 的 `app.emit`。
- 配置存储：桌面端 `client-runtime-config.json`（`app_config_dir` 下），读写实现在 `apps/desktop/src-tauri/src/config.rs`。
- 服务端包：`@jingyi0605/codingns`，CLI 入口 `bin/codingns.mjs`，命令为 `start / plugins / assistant / ...`。
- 安装器脚本必须**零外部依赖**，只用 Node 内置模块。原因见 §2.2。
- 安装全程不得请求管理员权限。

## 2. 架构

### 2.1 系统结构

整件事分成三层，每层只干自己那份活。

```
┌──────────────────────────────────────────────────────────┐
│ 第一层：界面（apps/user-app）                              │
│   /setup 向导页、四个步骤组件、连接测试、安装进度展示         │
│   连不上服务时的首屏空态卡片                                │
└───────────────────────┬──────────────────────────────────┘
                        │ Tauri invoke（命令）
                        │ Tauri event（进度回推）
┌───────────────────────▼──────────────────────────────────┐
│ 第二层：桌面壳（apps/desktop/src-tauri，Rust）              │
│   host_setup.rs      环境探测：Node、端口、已有安装          │
│   node_runtime.rs    私有 Node 的下载、校验、解压            │
│   host_installer.rs  拉起安装器子进程、解析进度、支持取消      │
│   config.rs          配置新增向导完成标记                    │
└───────────────────────┬──────────────────────────────────┘
                        │ 子进程 + JSON Lines 进度
┌───────────────────────▼──────────────────────────────────┐
│ 第三层：安装器（packages/codingns/scripts/host-install.mjs）│
│   装服务包、写自启、启停服务、健康检查、写安装状态             │
│   零依赖，只用 node: 内置模块                                │
└──────────────────────────────────────────────────────────┘
                        ▲
                        │ 同一个脚本，传不同参数
                 install.sh（命令行 / 服务器用户）
```

为什么要分三层，而不是让 Rust 直接调 npm：

- **Rust 不适合写安装业务逻辑**。npm 参数、包路径规则、三平台自启文件格式，这些用 Node 写一遍比用 Rust 写三遍省事。
- **安装器不能依赖 npm 包自己的依赖**。它在"包装好之前"就要运行，所以必须是零依赖单文件。这也是为什么它不能直接 import `packages/codingns` 里的其他模块。
- **界面不碰系统**。前端只调命令、收事件，所有系统操作都在 Rust 和安装器里，便于测试和排查。

### 2.1.1 这个安装任务为什么不进 Host 的 TaskManager

按 `specs/spec001.2-后端任务调度与主线程压力治理/20260412-后台任务接入规范.md` 的要求，后台任务应该走 Host 的 `TaskManager`。这个安装任务**不适用**，原因是它执行的时候 Host 还不存在 —— 装完之前没有后端进程，也就没有 TaskManager 可以注册。

所以这里的进度上报不走 Host 的任何接口，而是走桌面端自己的进程内事件：

- 安装任务由 Rust 侧持有，同一时间只允许一个，用 `taskId` 标识。
- 进度通过 Tauri 事件推给前端，**前端不做轮询**，符合规范里"轮询要由状态变化驱动"的要求。
- 安装结束后 Rust 侧销毁任务状态，前端只在向导页面存活期间保留订阅。

等 Host 装好之后，后续的服务更新仍然走现有 Host 侧链路（`apps/host/src/modules/client/service-update-task-service.ts` + PM2/自启），不由本 Spec 改动。

### 2.2 安装器为什么必须零依赖

安装器的调用时机有两个：

1. 桌面端向导里，服务包还没装，安装器要先跑起来把包装上。
2. `install.sh` 里，`npm install -g @jingyi0605/codingns` 刚结束，安装器在包目录里。

第 1 种情况下，安装器运行时机器上可能连一个 npm 包都没有。所以它只能用 `node:fs`、`node:path`、`node:child_process`、`node:os`、`node:crypto` 这些内置模块，不能 import 任何第三方包。

### 2.3 模块职责

| 模块 | 职责 | 输入 | 输出 |
| --- | --- | --- | --- |
| `SetupWizardPage`（新增） | 向导壳，管步骤前进后退和状态 | 用户点击、环境快照 | 各步骤组件渲染 |
| `setup-wizard-store`（新增） | 向导状态机，记住角色、参数、进度 | 步骤动作 | 可订阅状态 |
| `desktop-host-setup`（新增，前端） | 封装 Tauri 命令与事件，屏蔽平台差异 | 参数对象 | 环境快照、进度事件 |
| `host_setup.rs`（新增） | 探测 Node / npm / 端口 / 已有安装 | 探测选项 | `HostSetupEnvironmentSnapshot` |
| `node_runtime.rs`（新增） | 下载校验解压私有 Node，或复用系统 Node | 目标版本 | Node 可执行文件路径 |
| `host_installer.rs`（新增） | 拉安装器子进程、逐行解析进度、转发事件、支持取消 | 安装参数 | 进度事件、安装结果 |
| `host-install.mjs`（新增） | 全部安装业务：装包、自启、启停、健康检查、状态落盘 | 命令行参数 | JSON Lines 进度与结果 |
| `config.rs`（改） | 新增向导完成标记字段 | 配置补丁 | 配置文件 |
| `LoginPage`（改） | 连不上时展示空态与引导动作 | 探测结果 | 空态卡片 |
| `install.sh`（改） | 安装步骤改为调用安装器，新增桌面端安装选项 | 用户选择 | 调用安装器、下载安装包 |

### 2.4 关键流程

#### 2.4.1 向导入口判定

应用启动后，在路由层判断要不要进向导：

1. 读配置里的 `onboardingCompletedAt`，有值就直接进正常流程。
2. 没有值，但存在 host profile 且 `lastConnectedAt` 不为空 —— 说明是老用户升级上来的，直接补写 `onboardingCompletedAt` 并进正常流程。
3. 没有值，且本机扫描到可达的 Host —— 直接写 profile 和完成标记，进正常流程。
4. 以上都不满足 —— 进 `/setup`。

这套顺序保证老用户不会被突然弹出来的向导打断，也让"本机已经有服务"的用户少点几步。

#### 2.4.2 环境探测

在向导的服务端分支进入参数设置之前执行，四项探测并行，谁先回来先显示谁：

1. **系统信息**：`std::env::consts::OS` + `ARCH`，映射成展示用的名称。
2. **Node 运行时**：先看 `~/.codingns/runtime/node/` 下有没有可用的私有 Node；没有就在 `PATH` 里找系统 Node，跑 `node -v` 解析版本。只要有一个满足 `>= 22.19.0` 就算可用，并记录用的是哪一个。
3. **已有安装**：读 `<数据目录>/runtime/install-state.json`，另外检查三平台的自启配置文件是否存在。
4. **端口占用**：对目标端口做一次本地监听尝试，能绑上就是可用，绑不上就是被占用。

每项探测都有独立超时，超时的那项返回"检测中"状态，用户可以先往下走，不阻塞。

#### 2.4.3 Node 运行时准备

只在环境检测判定"没有可用 Node"时执行：

1. 按 `平台-架构` 拼出下载地址，主源 `https://nodejs.org/dist/`，失败回落 `https://npmmirror.com/mirrors/node/`。
2. 下载 `SHASUMS256.txt`，取出目标文件的 SHA256。
3. 下载压缩包，边下边算哈希，下完比对；不一致直接丢弃并报错。
4. 解压到 `~/.codingns/runtime/node/`。macOS 的 `tar.gz` 用 `tar -xzf`，Windows 的 `zip` 用 PowerShell 的 `Expand-Archive`。
5. 校验解压后的 `bin/node`（Windows 是 `node.exe`）能跑起来并返回正确版本。

版本固定成跟仓库 `.nvmrc` 与 `packages/codingns/package.json` 的 `engines` 一致的大版本，避免出现"桌面端装的 Node 跑不动服务端"。

#### 2.4.4 服务端安装

用户点"开始安装"后，Rust 拉起安装器子进程，安装器按固定顺序推进并把进度写成 JSON Lines，Rust 逐行读出来转成 Tauri 事件推给前端。

安装器的步骤顺序：

1. `prepare-runtime` —— 确认 Node 可用，建好数据目录和日志目录。
2. `install-package` —— 用私有 prefix 执行 `npm install -g --prefix <prefix> @jingyi0605/codingns@<版本>`。官方源失败自动切镜像重试一次。
3. `verify-package` —— 读包目录下的 `package.json`，确认版本和 `bin/codingns.mjs` 存在。
4. `configure-autostart` —— 用户开了自启才执行，写对应平台的自启文件并加载。
5. `start-service` —— 启动 Host 进程，或交给自启机制拉起。
6. `health-check` —— 轮询 `http://127.0.0.1:<端口>/` 直到有响应，最多等 60 秒。
7. `write-state` —— 写 `install-state.json`，记下所有参数和路径。

自启放在第 4 步、健康检查之前，但真正的**启用**动作（`launchctl bootstrap` / `systemctl enable` / `schtasks /Create`）放在健康检查通过之后。这样服务起不来时不会留下一个每次开机都失败的自启项。

#### 2.4.5 客户端连接配置

1. 用户在向导里选连接方式，填地址。
2. 前端做格式校验（必须是 `http` 或 `https` 开头，能解析出主机和端口）。
3. Rust 侧发起一次探测：请求 `<地址>/api/client/host-version`，10 秒超时。
4. 成功则把地址写进 host profile。直连写 `kind: "custom"`（局域网地址写 `lan`），中继写 `relayTunnel` 字段，复用现有 `buildRelayEntryConfigPatch`。
5. 失败按错误类型给不同提示：连不上主机 / 连上了但不是 CodingNS 服务 / 超时。

#### 2.4.6 安装器怎么被桌面端拿到

安装器脚本在构建桌面端时从 `packages/codingns/scripts/host-install.mjs` 复制到 `apps/desktop/src-tauri/resources/host-install.mjs`，并在 `tauri.conf.json` 的 `bundle.resources` 里声明。运行时通过 Tauri 的 resource 目录解析出绝对路径再执行。

这样做的原因：离线可用，而且桌面端带的安装器和它同版本，不会出现"客户端 2.1 装了个 2.0 的安装器"。

## 3. 组件和接口

### 3.1 核心组件

覆盖需求：1、2、3、4、5、6

- **`SetupWizardPage`**：向导壳。管角色、步骤切换、返回、跳过。桌面端走整页，移动端不参与。
- **`RoleStep`**：角色选择，含"检测到本机已有服务"卡片。
- **`ClientConnectionStep`**：连接方式选择 + 地址填写 + 测试连接。
- **`ServerEnvironmentStep`**：环境检测结果展示。
- **`ServerOptionsStep`**：端口、数据目录、自启、局域网访问。
- **`ServerInstallStep`**：安装进度、取消、失败重试、日志查看。
- **`host-install.mjs`**：安装器，动作有 `check / install / uninstall / start / stop / restart / status / autostart`。
- **`HostConnectionEmptyState`**：登录页在连不上时展示的空态卡片，复用现有空态样式基线。

### 3.2 数据结构

覆盖需求：1、3、4

#### 3.2.1 向导配置字段（写进 `client-runtime-config.json`）

| 字段 | 类型 | 必填 | 说明 | 约束 |
| --- | --- | --- | --- | --- |
| `onboardingCompletedAt` | `string \| null` | 否 | 向导完成时间 | ISO 时间字符串，null 表示没走过 |
| `onboardingRole` | `"client" \| "server" \| null` | 否 | 用户选的角色 | 仅用于统计和后续引导 |

Rust 侧 `DesktopRuntimeConfig` 和前端 `ClientRuntimeConfig` 都要加这两个字段，且 `config.rs` 的补丁合并逻辑要按现有写法（`if patch.x.is_some()`）处理。

#### 3.2.2 `HostSetupEnvironmentSnapshot`（环境快照）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `platform` | `string` | 是 | `macos` / `windows` / `linux` |
| `arch` | `string` | 是 | `arm64` / `x64` |
| `nodeStatus` | `"system" \| "private" \| "missing" \| "probing"` | 是 | Node 来源 |
| `nodeVersion` | `string \| null` | 否 | 检测到的版本号 |
| `nodePath` | `string \| null` | 否 | 可执行文件路径 |
| `plannedNodeVersion` | `string` | 是 | 没有可用 Node 时准备下载的版本 |
| `downloadSizeBytes` | `number \| null` | 否 | 预计下载体积 |
| `existingInstall` | `ExistingHostInstall \| null` | 否 | 已有安装信息 |
| `portCheck` | `PortCheckResult` | 是 | 目标端口占用情况 |
| `dataDirExists` | `boolean` | 是 | 数据目录是否已存在 |

#### 3.2.3 `ExistingHostInstall`（已有安装）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `packageVersion` | `string` | 是 | 已装的服务端版本 |
| `packageRoot` | `string` | 是 | 包所在绝对路径 |
| `installPrefix` | `string` | 是 | npm 私有 prefix |
| `port` | `number` | 是 | 上次安装用的端口 |
| `dataDir` | `string` | 是 | 数据目录 |
| `autostartEnabled` | `boolean` | 是 | 是否配了自启 |
| `autostartKind` | `"launchd" \| "systemd" \| "schtasks" \| "pm2" \| null` | 否 | 自启方式，`pm2` 表示是旧版 install.sh 装的 |
| `running` | `boolean` | 是 | 当前是否有进程在跑 |

#### 3.2.4 `HostInstallProgressEvent`（进度事件）

安装器往 stdout 写的每一行都是这个结构，Rust 解析后原样转发给前端。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | `"step" \| "log" \| "download" \| "result" \| "error"` | 是 | 事件类型 |
| `stepId` | `string` | 否 | 步骤标识，`type=step` 时必有 |
| `status` | `"pending" \| "running" \| "done" \| "failed" \| "skipped"` | 否 | 步骤状态 |
| `label` | `string` | 否 | 展示用步骤名（前端再按 i18n 映射一次） |
| `message` | `string` | 否 | 日志内容 |
| `receivedBytes` | `number` | 否 | 下载进度 |
| `totalBytes` | `number` | 否 | 下载总量 |
| `code` | `string` | 否 | 错误码，`type=error` 时必有 |
| `data` | `object` | 否 | `type=result` 时的结果数据 |

#### 3.2.5 `install-state.json`（安装状态落盘）

放在 `<数据目录>/runtime/install-state.json`，用于下次启动识别已有安装、以及卸载。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `schemaVersion` | `number` | 固定 1 |
| `installedAt` | `string` | 安装时间 |
| `packageName` | `string` | `@jingyi0605/codingns` |
| `packageVersion` | `string` | 版本 |
| `installPrefix` | `string` | npm 私有 prefix |
| `packageRoot` | `string` | 包绝对路径 |
| `nodeBinary` | `string` | 使用的 Node 可执行文件 |
| `nodeSource` | `"system" \| "private"` | Node 来源 |
| `listenHost` | `string` | 监听地址 |
| `port` | `number` | 端口 |
| `dataDir` | `string` | 数据目录 |
| `autostartEnabled` | `boolean` | 是否开机自启 |
| `autostartKind` | `string \| null` | 自启方式 |
| `autostartPath` | `string \| null` | 自启文件路径 |

### 3.3 接口契约

覆盖需求：2、3、4、5、6

#### 3.3.1 Tauri 命令：`probe_host_setup_environment`

- 类型：Function（前端 invoke）
- 输入：`{ port?: number, dataDir?: string }`
- 输出：`HostSetupEnvironmentSnapshot`
- 校验：`port` 必须在 1–65535；`dataDir` 必须是非空绝对路径或可展开的 `~` 开头路径
- 错误：`INVALID_PORT`、`INVALID_DATA_DIR`、`PROBE_TIMEOUT`

#### 3.3.2 Tauri 命令：`run_host_installer`

- 类型：Function（前端 invoke）
- 输入：
  ```ts
  {
    port: number;
    dataDir: string;
    listenHost: "127.0.0.1" | "0.0.0.0";
    autostart: boolean;
    reuseExisting?: boolean;
    registry?: string;
  }
  ```
- 输出：`{ taskId: string }`（立即返回，进度通过事件推）
- 校验：端口范围；数据目录不能是系统目录（`/`、`C:\Windows` 等）
- 错误：`INSTALLER_NOT_FOUND`、`INSTALL_ALREADY_RUNNING`

#### 3.3.3 Tauri 命令：`cancel_host_installer`

- 类型：Function
- 输入：`{ taskId: string }`
- 输出：`{ cancelled: boolean }`
- 错误：`TASK_NOT_FOUND`

#### 3.3.4 Tauri 命令：`get_host_install_state`

- 类型：Function
- 输入：无
- 输出：`ExistingHostInstall | null`
- 说明：读安装状态文件 + 探测进程是否在跑

#### 3.3.5 Tauri 命令：`probe_host_endpoint`

- 类型：Function
- 输入：`{ baseUrl: string, timeoutMs?: number }`
- 输出：`{ reachable: boolean, kind: "codingns" | "other" | "unreachable", version: string | null }`
- 校验：`baseUrl` 必须是合法 http/https URL
- 错误：`INVALID_URL`

#### 3.3.6 Tauri 命令：`ensure_node_runtime`

- 类型：Function
- 输入：`{ version: string }`
- 输出：`{ nodePath: string, source: "system" | "private" }`
- 说明：有可用系统 Node 直接返回；否则触发下载，进度走事件

#### 3.3.7 Tauri 事件：`codingns://host-setup/progress`

- 类型：Event
- 载荷：`{ taskId: string } & HostInstallProgressEvent`
- 说明：Rust 每解析出安装器一行就 `app.emit` 一次，前端订阅后按 `taskId` 过滤
- 前端订阅方式：沿用现有 `apps/user-app/src/platform/platform-provider.tsx:160` 的做法 —— 动态 `import("@tauri-apps/api/event")` 后调 `listen()`，并在组件卸载时 `unlisten()`
- 事件名常量与载荷类型定义放前端（参考 `apps/user-app/src/platform/desktop/window-events.ts` 的写法），Rust 侧事件名保持一致

#### 3.3.8 安装器命令行契约

- 类型：CLI
- 调用：`node host-install.mjs <action> [options]`
- 动作与参数：

| 动作 | 关键参数 | 说明 |
| --- | --- | --- |
| `check` | `--data-dir` | 输出已有安装 JSON，没有则输出 `null` |
| `install` | `--port --data-dir --host --autostart --registry --package --version` | 完整安装 |
| `start` / `stop` / `restart` | `--data-dir` | 进程控制 |
| `status` | `--data-dir` | 输出运行状态 JSON |
| `autostart` | `--enable` / `--disable`，加 `--data-dir` | 单独配置自启 |
| `uninstall` | `--data-dir --purge` | 卸载，`--purge` 连数据一起删 |

- 输出：stdout 每行一个 `HostInstallProgressEvent` JSON，最后一行是 `result` 或 `error`
- 退出码：`0` 成功，`1` 一般失败，`2` 参数错误，`3` 需要管理员权限（正常情况下不会出现）
- 错误码：`NODE_UNAVAILABLE`、`NPM_NOT_FOUND`、`NPM_INSTALL_FAILED`、`PACKAGE_VERIFY_FAILED`、`AUTOSTART_FAILED`、`START_FAILED`、`HEALTH_CHECK_TIMEOUT`、`PORT_IN_USE`、`PERMISSION_DENIED`

## 4. 数据与状态模型

### 4.1 数据关系

- 一份安装状态文件（`install-state.json`）对应一次服务端安装，不存在多份。
- 一个 host profile 对应一个可连接的服务地址。服务端模式装完后写入的 profile 用固定 id `local-host`，重复安装时更新而不是新增。
- 向导完成标记存在桌面配置里，跟安装状态文件相互独立：用户可能完成了向导但没有装服务（纯客户端），也可能装了服务但清过桌面配置。

### 4.2 状态流转

向导状态机：

| 状态 | 含义 | 进入条件 | 退出条件 |
| --- | --- | --- | --- |
| `idle` | 未开始 | 应用启动且未完成过向导 | 用户选择角色 |
| `role-selected` | 已选角色 | 用户点了两个角色之一 | 进入对应分支第一步 |
| `client-endpoint` | 客户端填地址 | 选了客户端 | 测试连接成功或用户返回 |
| `server-environment` | 服务端环境检测 | 选了服务端 | 检测完成 |
| `server-options` | 服务端填参数 | 环境检测完成 | 用户点开始安装 |
| `server-installing` | 安装中 | 用户确认安装 | 安装成功 / 失败 / 被取消 |
| `completed` | 已完成 | 分支走到最后一步 | —— |

安装任务状态：

| 状态 | 含义 | 进入条件 | 退出条件 |
| --- | --- | --- | --- |
| `pending` | 排队中 | 命令已接收 | 子进程启动 |
| `running` | 安装中 | 子进程已启动 | 成功 / 失败 / 取消 |
| `succeeded` | 成功 | 健康检查通过 | —— |
| `failed` | 失败 | 某一步返回错误 | 用户重试 |
| `cancelled` | 已取消 | 用户点取消 | 用户重新发起 |

## 5. 错误处理

### 5.1 错误类型

- `NODE_DOWNLOAD_FAILED`：下载 Node 失败，网络不通或镜像不可用。
- `NODE_CHECKSUM_MISMATCH`：Node 包哈希对不上，属于安全事件，必须拒绝使用。
- `NPM_INSTALL_FAILED`：npm 装包失败，可能是网络、权限或原生依赖编译问题。
- `PORT_IN_USE`：端口被别的程序占了。
- `AUTOSTART_FAILED`：写自启文件或加载失败。
- `HEALTH_CHECK_TIMEOUT`：服务进程起来了但一直没响应。
- `PERMISSION_DENIED`：往目标目录写失败。
- `ENDPOINT_UNREACHABLE` / `ENDPOINT_NOT_CODINGNS`：客户端连接测试的两类失败。

### 5.2 错误响应格式

安装器输出：

```json
{
  "type": "error",
  "code": "NPM_INSTALL_FAILED",
  "message": "安装 CodingNS 服务包失败",
  "detail": "npm 返回码 1，完整输出见日志文件",
  "logPath": "/Users/x/.codingns/runtime/logs/install-2026-01-01T00-00-00.log"
}
```

前端展示时用 `code` 去 i18n 字典取用户能看懂的说明，`detail` 折叠在"查看详情"里。

### 5.3 处理策略

1. **输入校验错误**（端口非法、目录非法）：就地提示，不发起安装。
2. **网络类错误**（下载失败、npm 失败）：自动重试一次并切换镜像源；仍失败则提示检查网络并给出"重试"。
3. **端口占用**：提示占用并推荐一个可用端口，用户确认后改端口重来，不自动改。
4. **健康检查超时**：保留已装好的服务，提示"服务已安装但没能启动"，提供"查看日志""重新启动""重新安装"。
5. **取消**：终止子进程树。已经装好的包不回滚（回滚一半的 npm 安装更容易把环境搞坏），但不写自启、不写完成状态，下次进入向导能识别出"装了一半"。

## 6. 正确性属性

### 6.1 属性 1：老用户不被向导打断

*对于任何* 已经在用 CodingNS 的用户配置，升级桌面端后首次启动都应该满足：直接进入正常流程，不出现向导页面。

**验证需求：** 需求 1

### 6.2 属性 2：安装中途退出不留自启残骸

*对于任何* 在自启配置写入之前被中断的安装，系统都应该满足：本机不存在任何指向 CodingNS 的开机自启项。

**验证需求：** 需求 3

### 6.3 属性 3：安装参数如实生效

*对于任何* 用户填写的端口和数据目录，安装完成后都应该满足：`install-state.json` 里的值、自启文件里的值、实际监听的值三者一致。

**验证需求：** 需求 4

### 6.4 属性 4：两条安装入口结果一致

*对于任何* 相同的安装参数，通过桌面端向导安装和通过 `install.sh` 安装都应该满足：产出的目录结构、安装状态文件和自启方式完全一致。

**验证需求：** 需求 6

## 7. 测试策略

### 7.1 单元测试

- 向导状态机：角色切换、前后步骤、跳过、失败重试的状态迁移。
- 地址校验与规范化：直连地址、中继域名、非法输入。
- 环境探测结果解析：Node 版本比较、端口检查结果、已有安装读取（用临时目录造假数据）。
- 安装器进度解析：JSON Lines 逐行解析、残缺行、非 JSON 行、错误行。
- 安装器纯函数部分：自启文件内容生成（三平台各一份快照）、包路径推导、参数校验。

### 7.2 集成测试

- 安装器 `check` / `status` / `uninstall` 在临时数据目录下的完整往返。
- `install` 动作在 mock npm 下的步骤顺序与状态落盘（不真的联网装包）。
- Rust 侧命令：`probe_host_setup_environment`、`probe_host_endpoint`、`cancel_host_installer`。
- 首屏空态的渲染条件：可达 / 不可达 / 扫描到本机服务三种情况。

### 7.3 端到端测试

- macOS 干净用户账号：从空配置走到服务装好、登录页指向本机地址。
- Windows 干净用户账号：同上，并确认计划任务已创建、服务能起来。
- 已有 Host 的机器：打开桌面端不进向导。
- `install.sh` 全流程：确认自启由安装器写入，Windows 上首次具备自启。
- 取消与失败：安装中途取消后，确认没有自启残留、下次进入向导能识别半完成状态。

### 7.4 验证映射

| 需求 | 设计章节 | 验证方式 |
| --- | --- | --- |
| `requirements.md` 需求 1 | §2.4.1、§4.2 | 状态机单测 + 老用户配置的 e2e |
| `requirements.md` 需求 2 | §2.4.5、§3.3.5 | 地址校验单测 + 真实探测集成测试 |
| `requirements.md` 需求 3 | §2.4.3、§2.4.4、§3.3.2 | 安装器集成测试 + 干净机器 e2e |
| `requirements.md` 需求 4 | §3.2.5、§6.3 | 参数生效的属性检查 + 端口占用 e2e |
| `requirements.md` 需求 5 | §3.1 | 首屏空态三态渲染测试 |
| `requirements.md` 需求 6 | §2.1、§6.4 | install.sh 回放 + 两条入口结果比对 |

## 8. 风险与待确认项

### 8.1 风险

- **Windows 计划任务的隐藏窗口**。直接让计划任务跑 `node.exe` 会闪一个黑窗口。缓解办法是用一个 VBS 包装器以隐藏方式启动，但这属于比较老的技巧，需要在真实 Windows 上确认行为。这是整个方案里最不确定的一处。
- **私有 Node 与系统 Node 并存**。用户可能同时有系统 Node 和私有 Node，npm 全局包装到哪个 prefix 会影响 `codingns` 命令能不能在终端直接用。设计上引导用户走私有 prefix，但终端里敲 `codingns` 可能找不到，需要明确提示路径。
- **与旧版 pm2 安装共存**。已经用 `install.sh` 装过的机器上有 pm2 托管的自启项。如果用户又在桌面端装一次，可能出现两个 Host 抢同一个端口。方案里靠"检测已有安装"来规避，但检测逻辑必须覆盖 pm2 的 LaunchAgent 文件。
- **macOS 往 `/Applications` 复制客户端** 在部分机器上需要授权。`install.sh` 安装桌面端时默认装到 `~/Applications`，避免弹权限框。
- **Node 下载体积**。国内网络下从 `nodejs.org` 下载体验差，镜像回落必须真的可用，否则向导会卡在这一步。

### 8.2 待确认项

- 私有 Node 的版本是否跟随 `.nvmrc` 固定，还是取 `engines` 允许范围内的最新 22.x。建议跟随 `.nvmrc`，行为可预期。
- 向导是否需要采集"这台机器主要用来干什么"这类信息用于产品统计。当前设计只存本地，不上报。
- `install.sh` 安装桌面客户端时，macOS 是否要支持装到 `/Applications`（需要用户确认授权）还是只装 `~/Applications`。建议先只做后者。
- 桌面端向导在 Linux 上是否要完整支持（含自启）。当前设计支持，但验收优先级低于 macOS 和 Windows。

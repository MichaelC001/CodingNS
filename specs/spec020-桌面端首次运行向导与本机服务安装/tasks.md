# 任务清单 - 桌面端首次运行向导与本机服务安装（人话版）

状态：Draft

先看 `README.md` 了解整体要做什么，再看 `requirements.md` 和 `design.md`。下面每个任务都能单独交给一个人做，做完必须能自己验证。

## 阶段 1：先修首屏，再把向导的地基打好

这一阶段不碰安装逻辑，纯前端和配置。做完之后，即使后面的安装功能还没上，连不上服务的用户也不会再对着一片空白发呆。

- [ ] 1.1 建立 Spec 文档骨架
  - 状态：DONE
  - 这一步到底做什么：把需求、设计、任务三份文档写出来，固定范围和边界。
  - 做完你能看到什么：`specs/spec020-桌面端首次运行向导与本机服务安装/` 下有 `README.md`、`requirements.md`、`design.md`、`tasks.md`。
  - 先依赖什么：无
  - 主要改哪里：只新增文档，不动代码。
  - 这一步先不做什么：不写任何实现代码。
  - 怎么验证：人工检查三份文档里的范围说明、需求编号和任务依赖是否对得上。

- [x] 1.2 连不上服务时的首屏引导
  - 状态：DONE
  - 这一步到底做什么：桌面端连不上 Host 时，登录页不再只显示一个用不了的登录表单，而是明确说明"连不上这台电脑上的服务"，并给出两个动作：安装本机服务、改用其他地址。
  - 做完你能看到什么：在没有服务的机器上打开桌面端，登录页出现空态卡片和两个按钮；本机有可达服务时，卡片变成"连接这台电脑上的服务"一键连接。
  - 先依赖什么：1.1
  - 主要改哪里：`apps/user-app/src/features/auth/pages/LoginPage.tsx`、新增空态组件、`apps/user-app/src/i18n/zh-CN.ts` 和 `en-US.ts`、必要的样式基线。
  - 这一步先不做什么：不做向导页面，按钮先指向 1.4 的路由占位；不改探测逻辑本身。
  - 怎么验证：桌面端三态渲染测试（可达 / 不可达 / 扫描到本机服务）+ 手工在无服务机器上打开确认 3 秒内出画面。
  - 对应规范：动手前先读 `docs/开发设计规范/20260419-前端页面与样式设计规范.md`。

- [x] 1.3 配置模型新增向导字段
  - 状态：DONE
  - 这一步到底做什么：在桌面配置里加 `onboardingCompletedAt` 和 `onboardingRole` 两个字段，前后端都能读写。
  - 做完你能看到什么：`client-runtime-config.json` 里能出现这两个字段，前端 `clientConfigStore` 能读到。
  - 先依赖什么：1.1
  - 主要改哪里：`apps/desktop/src-tauri/src/config.rs`、`apps/user-app/src/config/client-config-types.ts`、`apps/user-app/src/config/client-config-service.ts`。
  - 这一步先不做什么：不做向导入口判定，也不做界面。
  - 怎么验证：`pnpm test:related -- apps/user-app/src/config/client-config-service.ts`，加一个配置往返用例。

- [x] 1.4 向导入口判定与路由
  - 状态：DONE
  - 这一步到底做什么：按 `design.md` §2.4.1 的顺序决定要不要进向导：完成过就不进；老用户自动补记完成；本机有可达服务就自动连并补记；其余情况进 `/setup`。
  - 做完你能看到什么：老配置启动后直接进登录页；空配置启动后进 `/setup`（此时可以是占位页）。
  - 先依赖什么：1.2、1.3
  - 主要改哪里：`apps/user-app/src/app/router.tsx`、新增守卫组件、`apps/user-app/src/bootstrap/bootstrap-app.ts`（只做非阻塞的初始化）。
  - 这一步先不做什么：不实现向导内部步骤；不阻塞首屏，判定逻辑必须异步且可降级。
  - 怎么验证：单测覆盖四种入口分支；手工用"有配置"和"清空配置"两种情况各启动一次。

- [x] 1.5 阶段检查：首屏与入口
  - 状态：DONE
  - 这一步到底做什么：确认首屏不阻塞、老用户不被向导打扰、空配置能进占位向导。
  - 先依赖什么：1.2、1.3、1.4
  - 怎么验证：桌面端手工走查 + `apps/user-app` 相关单测。

## 阶段 2：向导界面与客户端分支

这一阶段把向导的壳和"当客户端用"这条路做完。做完之后，已经有服务端的用户可以不看文档连上。

- [x] 2.1 向导页面骨架
  - 状态：DONE
  - 这一步到底做什么：建 `/setup` 整页向导，包含步骤指示、上一步/下一步、跳过，以及状态机 store。
  - 做完你能看到什么：能在一个空向导里前进后退，跳过能直接进登录页并写完成标记。
  - 先依赖什么：1.4
  - 主要改哪里：新增 `apps/user-app/src/features/setup/`（页面、步骤组件、store），`router.tsx` 换成真实页面。
  - 这一步先不做什么：不做各分支的具体内容，步骤先放占位。
  - 怎么验证：状态机单测（角色切换、前后步骤、跳过）；手工点一遍。
  - 对应规范：动手前先读 `docs/开发设计规范/20260419-前端页面与样式设计规范.md`。

- [x] 2.2 角色选择步骤
  - 状态：DONE
  - 这一步到底做什么：让用户选"连接到已有的服务"或"在这台电脑上安装服务"；如果扫描到本机有可达服务，额外显示一键连接卡片。
  - 做完你能看到什么：向导第一步有两个带说明的选项；本机有服务时上方多一张卡片。
  - 先依赖什么：2.1
  - 主要改哪里：`apps/user-app/src/features/setup/` 下新增角色步骤组件，复用 `localHostDiscoveryStore` 的扫描结果，补 i18n 文案。
  - 这一步先不做什么：不做连接测试，也不做安装。
  - 怎么验证：组件测试覆盖"有本机服务"和"没有本机服务"两种渲染。
  - 界面上要注意：文案不能说"服务端""客户端"就完事，要用一句话解释各自含义。

- [x] 2.3 连接探测命令
  - 状态：DONE
  - 这一步到底做什么：实现 `probe_host_endpoint`，对用户填的地址发起一次真实探测，区分"连不上""连上了但不是 CodingNS 服务""超时"三种结果。
  - 做完你能看到什么：前端传一个地址进去，能拿到 `reachable` / `kind` / `version` 三样结果。
  - 先依赖什么：1.1
  - 主要改哪里：新增 `apps/desktop/src-tauri/src/host_setup.rs`（可与 4.1 同一文件），在 `lib.rs` 的 `invoke_handler` 注册命令；前端在 `platform-adapter.ts` 里加一个走 `invokeDesktopCommand` 的调用封装。
  - 这一步先不做什么：不做批量探测，不做中继隧道的额外握手。
  - 怎么验证：Rust 单测覆盖非法 URL、超时、非 CodingNS 服务三种输入；手工连一台真实服务。

- [x] 2.4 客户端连接方式步骤
  - 状态：DONE
  - 这一步到底做什么：选"直接连接"或"通过 CodingNS 中继连接"，填地址，做格式校验，点测试连接得出真实结果。
  - 做完你能看到什么：填错地址当场提示；点测试连接能拿到成功或具体失败原因；成功后地址写进 host profile。
  - 先依赖什么：2.2、2.3
  - 主要改哪里：新增连接步骤组件、`apps/user-app/src/config/relay-entry.ts` 复用中继配置构造、i18n 文案。
  - 这一步先不做什么：不做二维码、不做分享链接生成。
  - 怎么验证：地址校验单测 + 真实探测集成测试 + 手工连一台真实服务。

- [x] 2.5 客户端分支收尾
  - 状态：DONE
  - 这一步到底做什么：把客户端分支走到最后，写完成标记、跳登录页，并保证登录页已经选中刚配的地址。
  - 做完你能看到什么：向导走完直接落在登录页，服务器地址就是刚填的那个。
  - 先依赖什么：2.4
  - 主要改哪里：向导 store 收尾逻辑、`client-config-store` 写入。
  - 这一步先不做什么：不改登录流程本身。
  - 怎么验证：端到端手工走一遍客户端分支。

- [x] 2.6 阶段检查：客户端分支
  - 状态：DONE
  - 这一步到底做什么：确认从空配置到连上远程服务全程无需终端。
  - 先依赖什么：2.1–2.5
  - 怎么验证：macOS 和 Windows 各手工走一遍（直连 + 中继各一次）。

## 阶段 3：统一安装器

这一阶段只做 `host-install.mjs` 这一个文件，它可以完全独立开发和测试，不依赖桌面端界面。做完之后命令行的 `install.sh` 就能用上它。

- [x] 3.1 安装器骨架与只读动作
  - 状态：DONE
  - 这一步到底做什么：搭出参数解析、JSON Lines 输出、日志落盘、退出码约定，实现 `check` / `status` 两个只读动作。
  - 做完你能看到什么：`node host-install.mjs check --data-dir /tmp/x` 能输出已有安装的 JSON 或 `null`。
  - 先依赖什么：1.1
  - 主要改哪里：新增 `packages/codingns/scripts/host-install.mjs`。
  - 这一步先不做什么：不实现 `install`，不碰自启，不联网。
  - 怎么验证：`pnpm test:related -- packages/codingns/scripts/host-install.mjs`；手工跑 `check` / `status` 看输出格式。
  - 硬约束：这个文件只能 import `node:` 内置模块，不允许有任何第三方依赖。

- [x] 3.2 install 动作：装包与校验
  - 状态：DONE
  - 这一步到底做什么：建目录结构，用私有 prefix 执行 npm 安装，校验包版本和 CLI 入口存在，官方源失败自动切镜像重试一次。
  - 做完你能看到什么：在临时目录里跑一次 `install`，包被装到私有 prefix 下，stdout 能看到逐步进度。
  - 先依赖什么：3.1
  - 主要改哪里：`packages/codingns/scripts/host-install.mjs`。
  - 这一步先不做什么：不写自启，不启动服务。
  - 怎么验证：用临时 prefix 和 `--registry` 指向本地 mock 跑集成测试；一次性手工真实安装验证。

- [x] 3.3 三平台开机自启
  - 状态：DONE
  - 这一步到底做什么：按平台生成并加载自启项 —— macOS 写 LaunchAgent plist，Linux 写 systemd user service，Windows 建计划任务（配 VBS 包装器避免闪窗）。
  - 做完你能看到什么：`autostart --enable` 之后，重启电脑服务能自己起来；`--disable` 之后自启项被干净移除。
  - 先依赖什么：3.2
  - 主要改哪里：`packages/codingns/scripts/host-install.mjs`；Windows 计划任务需要新增一个 VBS 模板。
  - 这一步先不做什么：不处理 pm2 旧自启的迁移（放到 5.1）。
  - 怎么验证：三平台自启文件内容快照测试；macOS 和 Windows 各做一次真实重启验证。
  - 注意：Windows 隐藏窗口这一处是整个方案最不确定的地方，需要优先在真机上确认。

- [x] 3.4 启停、健康检查与状态落盘
  - 状态：DONE
  - 这一步到底做什么：实现 `start` / `stop` / `restart` / `uninstall`，加 `install` 里的健康检查和 `install-state.json` 落盘。
  - 做完你能看到什么：装完能自己验证服务可访问；`install-state.json` 里端口、目录、自启方式都对得上；`uninstall --purge` 能清干净。
  - 先依赖什么：3.3
  - 主要改哪里：`packages/codingns/scripts/host-install.mjs`。
  - 这一步先不做什么：不做版本升级。
  - 怎么验证：安装器集成测试跑完整往返（check → install → status → restart → uninstall）；断言自启写入发生在健康检查之后。

- [x] 3.5 安装器单测与文档
  - 状态：DONE
  - 这一步到底做什么：给纯函数部分补测试，并把命令行契约写进文档。
  - 做完你能看到什么：自启文件生成、包路径推导、参数校验、进度行解析都有测试；`docs/` 下有一页安装器用法。
  - 先依赖什么：3.4
  - 主要改哪里：新增安装器测试文件、`specs/spec020-.../docs/` 下新增说明。
  - 这一步先不做什么：不做桌面端接入。
  - 怎么验证：`pnpm test:related -- packages/codingns/scripts/host-install.mjs`。

- [x] 3.6 阶段检查：安装器独立可用
  - 状态：DONE
  - 这一步到底做什么：确认这个脚本脱离桌面端也能独立完成一次完整安装。
  - 先依赖什么：3.1–3.5
  - 怎么验证：在一台干净机器上只用 `node host-install.mjs install ...` 装通一次。

## 阶段 4：桌面端接入安装链路

这一阶段把安装器接进桌面端：探测环境、准备 Node、跑安装、显示进度。做完之后向导的服务端分支就能用了。

- [x] 4.1 环境探测命令
  - 状态：DONE
  - 这一步到底做什么：实现 `probe_host_setup_environment`，返回 `design.md` §3.2.2 那个快照，四项探测并行且各自有超时。
  - 做完你能看到什么：前端能拿到系统、Node、已有安装、端口占用四组信息。
  - 先依赖什么：1.1、3.1
  - 主要改哪里：新增 `apps/desktop/src-tauri/src/host_setup.rs`，在 `lib.rs` 的 `invoke_handler` 注册命令；前端封装同 2.3。
  - 这一步先不做什么：不下载 Node，不装任何东西。
  - 怎么验证：Rust 单测 + 前端集成测试；手工在有/无 Node、端口占用/空闲的机器上各看一次。

- [x] 4.2 私有 Node 运行时准备
  - 状态：DONE
  - 这一步到底做什么：实现 `ensure_node_runtime`：优先复用系统 Node，没有就下载官方包、校验 SHA256、解压到 `~/.codingns/runtime/node/`。
  - 做完你能看到什么：没有 Node 的机器上，向导能自己把 Node 准备好并显示进度；哈希不对会明确报错并拒绝使用。
  - 先依赖什么：4.1
  - 主要改哪里：新增 `apps/desktop/src-tauri/src/node_runtime.rs`，`lib.rs` 注册命令，Cargo 依赖按需增加解压相关库。
  - 这一步先不做什么：不做 Node 版本管理和多版本共存。
  - 怎么验证：哈希校验失败路径的单测；手工断网测失败提示；真实下载一次确认可用。

- [x] 4.3 安装执行与进度推送
  - 状态：DONE
  - 这一步到底做什么：实现 `run_host_installer` / `cancel_host_installer` / `get_host_install_state`，拉子进程、逐行解析 JSON Lines、通过 `codingns://host-setup/progress` 事件推给前端，取消时能杀掉整个进程树。
  - 做完你能看到什么：前端能实时看到安装步骤变化；点取消能在 5 秒内停下来。
  - 先依赖什么：4.1、3.6
  - 主要改哪里：新增 `apps/desktop/src-tauri/src/host_installer.rs`，`lib.rs` 注册命令；前端新增事件订阅模块（参考 `apps/user-app/src/platform/platform-provider.tsx:160` 的 `listen()` 写法，事件名常量仿照 `window-events.ts`）。不需要改 `desktop_bridge_plugin.rs`，事件订阅走 `@tauri-apps/api/event`。
  - 这一步先不做什么：不做多任务并行，同一时间只允许一个安装任务。
  - 怎么验证：用一个假的安装器脚本（定时输出进度行）做集成测试；重点测取消和进程树清理。

- [x] 4.4 让桌面端带上安装器
  - 状态：DONE
  - 这一步到底做什么：构建桌面端时把 `packages/codingns/scripts/host-install.mjs` 复制进 Tauri resources 并在配置里声明，运行时按 resource 目录解析路径。
  - 做完你能看到什么：打出来的 `.app` 和 Windows 安装包里能找到这个脚本，且桌面端能执行它。
  - 先依赖什么：4.3
  - 主要改哪里：`apps/desktop/src-tauri/tauri.conf.json` 的 `bundle.resources`、`scripts/build-desktop.sh`、可能新增一个准备脚本。
  - 这一步先不做什么：不改签名流程。资源是 `tauri build` 阶段就写进 `.app` 的，早于 `release_macos` 里的 `sign_macos_app`（`scripts/build-desktop.sh:1127`），所以不影响签名和 notarization；也不要往包里塞任何 Mach-O 可执行文件。
  - 怎么验证：`bash scripts/build-desktop.sh macos` 后检查包内文件；跑一次真实安装。

- [x] 4.5 服务端分支界面
  - 状态：DONE
  - 这一步到底做什么：把环境检测、参数设置、安装进度三步界面做出来，串上 4.1–4.3 的命令。
  - 做完你能看到什么：用户能在界面里看到检测结果、改端口和目录、开关自启、点开始安装并看到逐步进度，失败能看日志和重试。
  - 先依赖什么：4.2、4.3、4.4、2.1
  - 主要改哪里：`apps/user-app/src/features/setup/` 下新增三个步骤组件、进度与日志展示、i18n 文案；端口校验和目录选择复用 bridge 的 `pickDirectory`。
  - 这一步先不做什么：不做安装包的下载器 UI，不做多语言之外的其他语言。
  - 怎么验证：组件测试覆盖各状态（检测中 / 完成 / 端口占用 / 安装失败 / 可取消）。

- [x] 4.6 服务端分支收尾与再次进入入口
  - 状态：DONE
  - 这一步到底做什么：装完自动写本机 host profile（固定 id `local-host`）、写完成标记、跳登录页；同时在设置页加一个入口，让已经完成过向导的用户还能回来装本机服务。
  - 做完你能看到什么：装完直接落在登录页，且指向本机服务地址；设置页的"连接与更新"里能看到"在这台电脑上安装服务"的入口，进去只走服务端分支，不会重置已有连接配置。
  - 先依赖什么：4.5
  - 主要改哪里：向导 store 收尾逻辑、`client-config-store` 写入、设置页对应分组（`apps/user-app/src/settings/` 下的连接设置面板）、i18n 文案。
  - 这一步先不做什么：不自动登录，仍然要用户输账号密码；不做"卸载本机服务"的入口。
  - 怎么验证：端到端手工走一遍服务端分支；再从设置页进入确认已有 host profile 没被清掉。

- [x] 4.7 阶段检查：服务端分支端到端
  - 状态：DONE
  - 这一步到底做什么：在干净机器上确认从打开客户端到登录成功全程无需终端。
  - 先依赖什么：4.1–4.6
  - 怎么验证：macOS 和 Windows 各用干净用户账号走一遍。

## 阶段 5：install.sh 接入与旧安装兼容

- [x] 5.1 install.sh 改为调用统一安装器
  - 状态：DONE
  - 这一步到底做什么：把 `install.sh` 里装服务、配自启、启动服务这几段换成调用 `host-install.mjs`，参数用用户在脚本里选的值。
  - 做完你能看到什么：`install.sh` 装完的结果和桌面端装出来的完全一致；Windows 上首次有开机自启。
  - 先依赖什么：3.6
  - 主要改哪里：`install.sh` 的 `install_or_resolve_codingns`、`install_or_resolve_pm2`、`resolve_pm2_start_script_path`、`start_pm2_service`、`configure_startup` 这几段。
  - 这一步先不做什么：不改脚本前面的语言选择、Node 安装、CLI 检测逻辑。
  - 怎么验证：`scripts/run-windows-install-replay.sh` 回放通过；macOS 上手工跑一次。

- [x] 5.2 识别并处理旧的 pm2 安装
  - 状态：DONE
  - 这一步到底做什么：检测到机器上有 pm2 托管的 CodingNS 时，明确告诉用户并给出选择，不能静默装出第二个服务抢端口。
  - 做完你能看到什么：旧 pm2 机器上，向导和 `install.sh` 都会提示"检测到已有 pm2 托管的服务"，并允许复用或迁移。
  - 先依赖什么：5.1
  - 主要改哪里：`host-install.mjs` 的 `check` 动作、`install.sh` 的提示分支、向导环境检测展示。
  - 这一步先不做什么：不做自动迁移，只提示和让用户选。
  - 怎么验证：在装了旧版的机器上验证检测结果；确认不会产生第二个监听进程。

- [x] 5.3 install.sh 新增桌面客户端安装选项
  - 状态：DONE
  - 这一步到底做什么：在安装流程末尾问一句"要不要顺便装桌面客户端"，选了就按平台下载安装包并安装（macOS 挂载 dmg 复制到 `~/Applications`，Windows 静默运行安装程序）。
  - 做完你能看到什么：命令行装完服务后，应用列表里也有桌面客户端；装失败只提示，不影响服务端。
  - 先依赖什么：5.1
  - 主要改哪里：`install.sh` 新增一段；下载地址从 GitHub Release 取，复用已有的镜像回落逻辑。
  - 这一步先不做什么：不装到 `/Applications`（避免弹授权），不做 Linux 桌面包。
  - 怎么验证：macOS 和 Windows 各手工跑一次；下载失败时确认服务端不受影响。

- [x] 5.4 阶段检查：install.sh 全流程
  - 状态：DONE
  - 这一步到底做什么：确认三条路径都通：只装服务、服务+客户端、Windows 下的完整流程。
  - 先依赖什么：5.1–5.3
  - 怎么验证：`bash scripts/verify-release-ci.sh` 里的回放段通过；手工补验 Windows 自启。

## 阶段 6：验收与收尾

- [x] 6.1 三平台端到端验收
  - 状态：DONE
  - 这一步到底做什么：按需求逐条走验收，记录证据。
  - 做完你能看到什么：`docs/` 下有一份验收记录，每条需求都有对应的验证结果。
  - 先依赖什么：4.7、5.4
  - 主要改哪里：新增 `specs/spec020-.../docs/20260xxx-验收记录.md`。
  - 怎么验证：macOS 干净账号、Windows 干净账号、老用户升级三种场景各走一遍。

- [x] 6.2 CI 接入
  - 状态：DONE
  - 这一步到底做什么：把安装器的测试挂进现有测试入口，把 Windows 安装回放扩展到覆盖新的自启逻辑。
  - 做完你能看到什么：改安装器会触发相关测试；`windows-install-replay` 工作流覆盖自启创建与清理。
  - 先依赖什么：5.4
  - 主要改哪里：`.github/workflows/windows-install-replay.yml`、`scripts/prepare-windows-install-replay.sh`、`scripts/verify-windows-install-replay.mjs`。
  - 这一步先不做什么：不新增独立工作流。
  - 怎么验证：本地跑 `pnpm test:related`；推一次 CI 看回放结果。

- [x] 6.3 文档收尾
  - 状态：DONE
  - 这一步到底做什么：更新面向用户的安装说明和开发说明，写清桌面端向导、安装器、自启三件事。
  - 做完你能看到什么：`docs/使用说明/` 下有向导使用说明，安装器命令行契约有单独一页。
  - 先依赖什么：6.1
  - 主要改哪里：新增用户说明文档；更新 `docs/使用说明/20260329-NPM包打包发布与离线安装说明.md` 里已经过时的 pm2 说法。
  - 这一步先不做什么：不动 README 的整体结构。
  - 怎么验证：按文档从头走一遍，确认没有过时描述。

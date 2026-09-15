# 任务清单 - spec010.8 Pi Agent CLI 适配接入（人话版）

状态：IN_PROGRESS

## 这份文档是干什么的

这份清单把 Pi Agent 接入拆成能单独实现和验证的步骤。每个任务都写明要改什么、完成后能看到什么、明确不做什么以及最小验证方式。

## 状态说明

- `TODO`：还没开始
- `IN_PROGRESS`：正在做
- `BLOCKED`：被外部问题卡住，必须写清恢复条件
- `IN_REVIEW`：已有实现，等待复核
- `DONE`：实现和验证都完成，并已回写本文件
- `CANCELLED`：取消，并写明原因

每完成一个任务，必须立即回写本文件；实现任务和文档回写应按仓库提交规则分开提交。

## 阶段 0：基线、目录和公共边界

- [x] 0.1 创建 Pi 版本和协议基线
  - 状态：DONE
  - 这一步到底做什么：固定 Pi `0.85.1`、Node 版本要求、安装方式、RPC 命令/事件和已知限制。
  - 做完你能看到什么：任何接手人都知道本 Spec 是基于哪个 Pi 版本设计的，不会拿旧版本猜协议。
  - 先依赖什么：无
  - 开始前先看：`docs/20260915-PiAgent协议与能力基线.md`、上游 RPC/SDK 文档。
  - 主要改哪里：`specs/spec010.8-PIAgentCLI适配接入/docs/20260915-PiAgent协议与能力基线.md`。
  - 这一步先不做什么：不接 Host，不发真实模型请求。
  - 怎么算完成：版本、安装命令、RPC smoke 结果、无 API key 限制和能力差异已经写清楚。
  - 怎么验证：已执行 `pi --version`、官方 `RpcClient` smoke、`git diff --check`；结果见 `docs/20260915-PiAgent协议与能力基线.md`。
  - 对应需求：需求 1、需求 12
  - 对应设计：§1、§10

- [ ] 0.2 定义 Pi Provider 的公共标识和能力边界
  - 状态：TODO
  - 这一步到底做什么：确定 provider id、配置字段、capability 初始值和 DSH 不适用的限制。
  - 做完你能看到什么：Provider catalog 可以区分 Pi、DSH 和其他 CLI，不会误把 subagent/完整权限能力显示给用户。
  - 先依赖什么：0.1
  - 开始前先看：`requirements.md` 需求 1、5、9、10；`design.md` §8。
  - 主要改哪里：`packages/session-sync-core/src/types.ts`（如需补公共字段）、Host 配置和 provider catalog。
  - 这一步先不做什么：不实现 RPC 进程和历史解析。
  - 怎么算完成：能力矩阵、limitations、runtimeVersion/protocolVersion 语义有明确测试断言。
  - 怎么验证：核心类型检查和 capability 单元测试。
  - 对应需求：需求 1、5、9、10
  - 对应设计：§8

### 阶段检查 0.3

- [ ] 0.3 阶段检查：基线和公共契约可以执行
  - 状态：TODO
  - 这一步到底做什么：确认版本、命名、能力和范围没有互相矛盾。
  - 做完你能看到什么：可以开始写运行时，不会边写边改 provider 语义。
  - 先依赖什么：0.1、0.2
  - 开始前先看：`requirements.md`、`design.md`、`tasks.md`。
  - 主要改哪里：阶段 0 文档和公共类型。
  - 这一步先不做什么：不扩展 DSH 不具备的 Pi 能力。
  - 怎么算完成：所有已知限制都有 capability 或 limitations 落点。
  - 怎么验证：人工走查、`git diff --check`。
  - 对应需求：需求 1、5、12
  - 对应设计：§1、§8、§11

## 阶段 1：实现严格 RPC 运行时

- [ ] 1.1 实现 PiRpcClient 和严格 JSONL 读取
  - 状态：TODO
  - 这一步到底做什么：封装 spawn、stdin 命令、stdout LF 分帧、请求 id、response/error 和 stderr 诊断。
  - 做完你能看到什么：Host 可以稳定发送 `get_state`、`prompt`、`abort` 等命令，不会被 Unicode 分隔符或混杂日志破坏。
  - 先依赖什么：0.3
  - 开始前先看：`requirements.md` 需求 2、3、4、11；`design.md` §3、§4。
  - 主要改哪里：`packages/session-sync-core/src/runtime/pi-rpc-client.ts`、测试 fixture。
  - 这一步先不做什么：不把事件转换成前端消息，不加载扩展。
  - 怎么算完成：非法 JSON、未知 response、超时、EOF、SIGTERM 和 stderr 都有明确处理。
  - 怎么验证：RPC fake executable 测试；不依赖真实 API key。
  - 对应需求：需求 2、3、4、11
  - 对应设计：§3、§4、§9

- [ ] 1.2 实现 PiRuntimeAdapter 的新建、继续、中断和运行中输入
  - 状态：TODO
  - 这一步到底做什么：实现 `ProviderRuntimeAdapter`，绑定 Pi session id/file，发送 prompt、steer、follow-up、clear_queue 和 abort。
  - 做完你能看到什么：ProviderRuntimeService 能像管理其他 CLI 一样启动和停止 Pi。
  - 先依赖什么：1.1
  - 开始前先看：`packages/session-sync-core/src/runtime/types.ts`、`design.md` §3。
  - 主要改哪里：`packages/session-sync-core/src/runtime/pi-runtime.ts`、`packages/session-sync-core/src/index.ts`、runtime 测试。
  - 这一步先不做什么：不实现历史发现、Fork、Plan UI。
  - 怎么算完成：accepted、completed、interrupted、failed 四类路径都有稳定 Promise 和事件。
  - 怎么验证：`pnpm --dir packages/session-sync-core build`；点名 Pi runtime 测试。
  - 对应需求：需求 1、2、4、11
  - 对应设计：§3、§4、§9

- [ ] 1.3 实现文本、思考、工具和终态归一化
  - 状态：TODO
  - 这一步到底做什么：把 Pi message/tool 事件转换为 `NormalizedMessage` 和 `RuntimeEventInput`，合并增量并保留 raw ref。
  - 做完你能看到什么：消息时间线能实时显示文本、思考、工具调用和工具结果，且不会重复堆叠 delta。
  - 先依赖什么：1.2
  - 开始前先看：`requirements.md` 需求 3；`design.md` §4；现有 Command Code/Codex runtime normalizer。
  - 主要改哪里：`packages/session-sync-core/src/runtime/pi-event-normalizer.ts`、fixture 和测试。
  - 这一步先不做什么：不把未知扩展 UI 当成普通文本消息。
  - 怎么算完成：agent_end 不提前终止，agent_settled 才完成；未知事件可追踪。
  - 怎么验证：事件序列 fixture、工具调用重放测试。
  - 对应需求：需求 3
  - 对应设计：§4

### 阶段检查 1.4

- [ ] 1.4 阶段检查：Pi RPC 主运行链路通过 fake fixture
  - 状态：TODO
  - 这一步到底做什么：用 fake Pi 进程跑通新建、prompt、事件、steer、follow-up、abort 和失败。
  - 做完你能看到什么：不需要真实模型密钥就能证明主运行链路没有生命周期漏洞。
  - 先依赖什么：1.1、1.2、1.3
  - 开始前先看：阶段 1 全部代码和测试。
  - 主要改哪里：阶段 1 相关文件。
  - 这一步先不做什么：不接前端，不跑真实模型。
  - 怎么算完成：所有终态只出现一次，stdin/stdout 和挂起 Promise 都能清理。
  - 怎么验证：核心包点名测试和 `pnpm --dir packages/session-sync-core build`。
  - 对应需求：需求 2、3、4、11、12
  - 对应设计：§3、§4、§9、§10

## 阶段 2：模型、附件和交互桥

- [ ] 2.1 接入模型列表和模型切换
  - 状态：TODO
  - 这一步到底做什么：用 Pi RPC 模型列表填充 provider model options，并实现 set_model。
  - 做完你能看到什么：用户可以查看 Pi 模型并切换，错误不会破坏当前选择。
  - 先依赖什么：1.4
  - 开始前先看：`requirements.md` 需求 5；`design.md` §8。
  - 主要改哪里：Pi provider adapter、Host provider catalog、相关测试。
  - 这一步先不做什么：不实现远程 provider discovery，不伪造 DSH provider 列表。
  - 怎么算完成：模型 id/provider/thinking level 的映射有测试。
  - 怎么验证：模型目录 fixture、Host catalog 测试。
  - 对应需求：需求 5
  - 对应设计：§8、§10

- [ ] 2.2 实现图片和文件附件协议
  - 状态：TODO
  - 这一步到底做什么：图片转 Pi image content；普通文件按内容注入或受控路径协议发送。
  - 做完你能看到什么：图片可以被 Pi 读取，文件附件不会越权暴露路径，也不会静默丢失。
  - 先依赖什么：1.4
  - 开始前先看：`requirements.md` 需求 6；`design.md` §7.1、§7.2；现有 DSH attachmentRootDir 校验。
  - 主要改哪里：Pi runtime、附件路径校验、fixture 和 Host 集成测试。
  - 这一步先不做什么：不把任意外部文件复制到 Pi 全局目录。
  - 怎么算完成：图片大小/MIME/路径边界和大文件回退策略都有测试。
  - 怎么验证：附件集成测试；路径越界必须失败。
  - 对应需求：需求 6
  - 对应设计：§7.1、§7.2、§9

- [ ] 2.3 实现扩展 UI 到 CodingNS 交互的桥
  - 状态：TODO
  - 这一步到底做什么：接收 Pi `extension_ui_request`，转成 CodingNS interaction，并按原 id 回写 response。
  - 做完你能看到什么：Pi 扩展的 select/confirm/input/editor 不会卡住进程，前端能显示等待用户交互。
  - 先依赖什么：1.4
  - 开始前先看：`requirements.md` 需求 9；`design.md` §7.3；现有 `session-permission-request-service`。
  - 主要改哪里：Pi runtime、Host permission/interaction bridge、事件 DTO、测试。
  - 这一步先不做什么：不把普通 confirm 伪装成带完整文件权限范围的 DSH approval。
  - 怎么算完成：超时、取消、进程退出、重复 response 都有明确行为。
  - 怎么验证：Host interaction 集成测试和 response id 回放。
  - 对应需求：需求 9
  - 对应设计：§7.3、§9

- [ ] 2.4 提供 RPC 兼容的 question 工具
  - 状态：TODO
  - 这一步到底做什么：实现只依赖 select/confirm/input/editor 的 Pi 扩展，替代依赖 TUI custom 的 question/questionnaire 示例。
  - 做完你能看到什么：Pi 在 RPC 下可以向用户提问并等待回答，不会返回 UI not available。
  - 先依赖什么：2.3
  - 开始前先看：`requirements.md` 需求 9；上游扩展 UI 协议；`design.md` §7.3。
  - 主要改哪里：受控 Pi extension 文件、扩展版本锁定配置、RPC fixture。
  - 这一步先不做什么：不支持 TUI 专属 custom widget。
  - 怎么算完成：单问题、多选项、取消、超时和自由输入均能回到模型上下文。
  - 怎么验证：扩展 UI fixture；人工跑一次隔离 RPC。
  - 对应需求：需求 9
  - 对应设计：§7.3、§10

## 阶段 3：Plan Mode 和会话文件

- [ ] 3.1 固定并加载 Plan Mode 扩展
  - 状态：TODO
  - 这一步到底做什么：把可信的 Plan Mode 扩展版本固定到 Pi 启动配置，确认 edit/write 限制和扩展来源。
  - 做完你能看到什么：Pi 能在只读计划模式下运行，扩展缺失时能力自动关闭。
  - 先依赖什么：2.3、2.4
  - 开始前先看：`requirements.md` 需求 10；`design.md` §7.4；Pi plan-mode 示例源码。
  - 主要改哪里：Pi 配置、扩展包/资源目录、capability mapper、测试 fixture。
  - 这一步先不做什么：不允许工作区任意扩展自动获得权限。
  - 怎么算完成：Plan Mode 启动、扩展加载失败和工具限制都有可观察结果。
  - 怎么验证：受控扩展 fixture、工具 allowlist 测试。
  - 对应需求：需求 10、11
  - 对应设计：§7.4、§8

- [ ] 3.2 实现 Plan 审批回传和执行状态
  - 状态：TODO
  - 这一步到底做什么：把 Execute/Stay/Refine 的 select 请求接到 CodingNS UI，并继续消费扩展 follow-up/custom message。
  - 做完你能看到什么：用户可以批准执行计划、继续修改计划或停留在只读模式。
  - 先依赖什么：3.1
  - 开始前先看：`requirements.md` 需求 10；`design.md` §7.4。
  - 主要改哪里：Pi UI bridge、Host runtime event、前端交互门控、集成测试。
  - 这一步先不做什么：不承诺 DSH 的完整审批范围模型。
  - 怎么算完成：审批请求、用户选择、扩展 follow-up、取消和进程退出都不丢状态。
  - 怎么验证：Plan RPC 回放和前端交互测试。
  - 对应需求：需求 10
  - 对应设计：§7.4、§10

- [ ] 3.3 实现 Pi session JSONL 扫描和增量读取
  - 状态：TODO
  - 这一步到底做什么：扫描指定 session 根目录，解析 session/message 树，按文件指纹和偏移增量读取。
  - 做完你能看到什么：Pi 已有会话能出现在列表中，新增历史不会重复读取整文件。
  - 先依赖什么：1.4
  - 开始前先看：`requirements.md` 需求 7、11；`design.md` §5；后台任务接入规范。
  - 主要改哪里：`packages/session-sync-core/src/providers/pi.ts`、`pi-session-jsonl-reader.ts`、Host TaskManager 接入和测试。
  - 这一步先不做什么：不把 Pi JSONL 当成 CodingNS 主数据库，不在 watcher 里同步读大文件。
  - 怎么算完成：cwd 过滤、尾行、文件替换、未知 entry、游标和增量消息都有测试。
  - 怎么验证：Pi JSONL fixture、helper/task 测试、`pnpm test:related -- ...`。
  - 对应需求：需求 7、11、12
  - 对应设计：§5、§10

### 阶段检查 3.4

- [ ] 3.4 阶段检查：Plan 和历史链路可独立回放
  - 状态：TODO
  - 这一步到底做什么：确认 Plan 审批和 session JSONL 不依赖真实模型也能回放。
  - 做完你能看到什么：可以进入 Fork/删除和 Host/前端注册，不会带着解析和交互硬伤往前走。
  - 先依赖什么：3.1、3.2、3.3
  - 开始前先看：阶段 3 全部文件。
  - 主要改哪里：阶段 3 相关文件。
  - 这一步先不做什么：不新增 DSH 不具备的能力。
  - 怎么算完成：Plan、question、扫描、增量读取和扩展缺失降级都有证据。
  - 怎么验证：点名 fixture 和集成测试。
  - 对应需求：需求 7、9、10
  - 对应设计：§5、§7、§10

## 阶段 4：会话操作和 Host/前端接入

- [ ] 4.1 实现 Fork、Clone、重命名
  - 状态：TODO
  - 这一步到底做什么：把 CodingNS 消息 id 映射到 Pi entry id，调用 fork/clone/set_session_name，并更新 binding。
  - 做完你能看到什么：用户可以从消息或当前分支创建 Pi 新会话，原会话不被覆盖。
  - 先依赖什么：3.3
  - 开始前先看：`requirements.md` 需求 8；`design.md` §6.1、§6.2；现有 DSH/Command Code fork 实现。
  - 主要改哪里：`packages/session-sync-core/src/providers/pi.ts`、session service、Fork 测试。
  - 这一步先不做什么：不实现重构式伪造 Fork。
  - 怎么算完成：source not found、取消、成功 rebinding 和 parent session 都有测试。
  - 怎么验证：Provider fork 集成测试、Host session service 测试。
  - 对应需求：需求 8
  - 对应设计：§6.1、§10

- [ ] 4.2 定义删除和归档语义
  - 状态：TODO
  - 这一步到底做什么：实现安全删除和 CodingNS 元数据归档，明确 Pi 没有原生 archive 时的降级。
  - 做完你能看到什么：删除只会触及允许的 Pi session 根目录，归档不会误删文件。
  - 先依赖什么：3.3、4.1
  - 开始前先看：`requirements.md` 需求 8、11；`design.md` §6.3。
  - 主要改哪里：Pi provider、session index/archive repository、路径校验和测试。
  - 这一步先不做什么：不递归删除用户 HOME 或未验证路径。
  - 怎么算完成：活跃运行先停止、越界路径拒绝、删除后缓存清理、归档可恢复。
  - 怎么验证：删除/归档集成测试和路径安全测试。
  - 对应需求：需求 8、11
  - 对应设计：§6.3、§9

- [ ] 4.3 注册 Host Provider、runtime、配置和能力快照
  - 状态：TODO
  - 这一步到底做什么：把 Pi 接到 Host runtime factory、Provider catalog、配置读取、session history 和 capability snapshot。
  - 做完你能看到什么：Host 可以选择 Pi、创建会话、读取历史，并按 capability 控制按钮。
  - 先依赖什么：2.1、3.3、4.1、4.2
  - 开始前先看：`requirements.md` 需求 1、5、8；`design.md` §2.2、§8；现有 Command Code/DSH 注册点。
  - 主要改哪里：`apps/host/src/modules/sessions/session-live-runtime-service.ts`、Host config、provider catalog、session history registry。
  - 这一步先不做什么：不在业务服务里散落 `provider === "pi"` 特判。
  - 怎么算完成：启动/继续/历史/能力快照走统一入口，配置缺失时有明确 degraded 状态。
  - 怎么验证：Host catalog、session service、capability 集成测试。
  - 对应需求：需求 1、2、5、7、8
  - 对应设计：§2、§3、§5、§8

- [ ] 4.4 接入 user-app provider UI 和交互门控
  - 状态：TODO
  - 这一步到底做什么：通过统一 i18n 和 capability 显示 Pi，接入模型、附件、Fork、Plan/权限交互，不硬编码假能力。
  - 做完你能看到什么：用户可以在前端使用 Pi 支持的入口，DSH 专属按钮不会出现在 Pi 上。
  - 先依赖什么：4.3、3.2
  - 开始前先看：前端页面与样式规范、模态框规范（如果改交互弹窗）、现有 provider UI。
  - 主要改哪里：`apps/user-app/src/features/conversation/`、provider catalog、i18n、相关测试。
  - 这一步先不做什么：不新建独立的 Pi 页面，不用硬编码中文文案替代 i18n。
  - 怎么算完成：模型选择、图片/文件附件、Fork/Clone、Plan 审批和交互等待状态有 UI 测试。
  - 怎么验证：`pnpm --dir apps/user-app test -- --run <相关测试>`。
  - 对应需求：需求 5、6、8、9、10
  - 对应设计：§7、§8、§10

## 阶段 5：统计、回归和最终验收

- [ ] 5.1 接入基本 token usage 和上下文显示
  - 状态：TODO
  - 这一步到底做什么：从 Pi final message/session stats 读取可验证 usage，写入 CodingNS 稀疏统计模型。
  - 做完你能看到什么：用户能看到基本输入、输出、缓存和费用信息；缺失值不会被伪造为 0。
  - 先依赖什么：1.3、4.3
  - 开始前先看：`requirements.md` 需求 5；`design.md` §8、§10；session pricing 规则。
  - 主要改哪里：Pi provider stats、session pricing 映射、context usage 和测试。
  - 这一步先不做什么：不声称 Pi usage 与 DSH projection 完全同口径。
  - 怎么算完成：usage 来源、语义、水位和缺失原因有测试断言。
  - 怎么验证：usage fixture、Provider stats 测试、相关 Host 测试。
  - 对应需求：需求 5、12
  - 对应设计：§8、§10、§11

- [ ] 5.2 完成 Pi RPC、JSONL、附件、Fork、Plan 和交互回归
  - 状态：TODO
  - 这一步到底做什么：把本 Spec 列出的所有功能组合成最小回归集。
  - 做完你能看到什么：没有真实模型密钥时仍能证明协议适配器可用；真实 CLI 只作为额外冒烟。
  - 先依赖什么：4.4、5.1
  - 开始前先看：`requirements.md` 全文、`design.md` §10、tasks.md 全部任务。
  - 主要改哪里：核心、Host、前端测试和验证文档。
  - 这一步先不做什么：不把全量项目测试当成默认验证入口。
  - 怎么算完成：直接相关测试通过，失败路径和已知限制已记录。
  - 怎么验证：`pnpm test:related -- <变更文件>`、必要时点名 Host/user-app 测试；所有命令带超时。
  - 对应需求：需求 1-12
  - 对应设计：§10、§11

- [ ] 5.3 更新能力基线、使用说明和限制
  - 状态：TODO
  - 这一步到底做什么：记录安装、配置、Plan/question 扩展、附件协议、删除/归档和不可恢复场景。
  - 做完你能看到什么：别人可以按文档配置 Pi，并知道哪些能力不能和 DSH 等价。
  - 先依赖什么：5.2
  - 开始前先看：`README.md`、`requirements.md`、`design.md`、基线文档。
  - 主要改哪里：`specs/spec010.8-PIAgentCLI适配接入/docs/`、必要的项目使用说明。
  - 这一步先不做什么：不把未验证的真实模型能力写成保证。
  - 怎么算完成：版本、命令、环境变量、能力矩阵、错误码和回归命令都能找到。
  - 怎么验证：文档走查、链接检查、`git diff --check`。
  - 对应需求：需求 1、11、12
  - 对应设计：§1、§8、§9、§10、§11

### 最终检查 5.4

- [ ] 5.4 最终验收
  - 状态：TODO
  - 这一步到底做什么：逐条核对需求、设计、任务、测试和已知限制，确认没有把 DSH 专属能力冒充成 Pi 能力。
  - 做完你能看到什么：Spec 可以进入实现完成状态，后续接手人能从 tasks.md 直接继续。
  - 先依赖什么：5.1、5.2、5.3
  - 开始前先看：`requirements.md`、`design.md`、`tasks.md` 和全部 docs。
  - 主要改哪里：当前 Spec 全部文档、必要的 capability/限制说明。
  - 这一步先不做什么：不追加新功能，不把外部模型调用成功当成唯一验收条件。
  - 怎么算完成：全部 In Scope 能力有实现和验证证据，Out of Scope 和降级项有明确记录。
  - 怎么验证：按需求验收矩阵逐项检查，补充最小必要命令结果。
  - 对应需求：需求 1-12
  - 对应设计：全文

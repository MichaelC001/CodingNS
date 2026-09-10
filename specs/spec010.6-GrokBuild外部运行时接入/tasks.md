# 任务清单 - spec010.6 Grok Build 外部运行时接入（人话版）

状态：Draft

## 这份文档是干什么的

这份清单把 Grok 接入拆成可以单独开发、验证和回写的步骤。每个任务都说明：做什么、完成后看到什么、依赖什么、主要改哪里、明确不做什么以及怎么验证。

## 状态说明

- `TODO`：还没开始
- `IN_PROGRESS`：正在做
- `BLOCKED`：被外部问题卡住
- `IN_REVIEW`：已有结果，等待复核
- `DONE`：已经完成并回写验证结果
- `CANCELLED`：取消，并写清楚原因

规则：

- 只有 `状态：DONE` 的任务才能勾选 `[x]`。
- 每完成一个任务，必须立即回写本文件。
- 实现任务要先完成最小相关验证，再按项目规则分模块提交；文档回写不能混入业务代码提交。

## 阶段 0：先把边界和协议资料固定下来

### 0.1 建立 Spec 主文档

- [x] 0.1 建立 `010.6` 主文档
  - 状态：DONE
  - 这一步到底做什么：创建 README、需求、设计、任务和 docs 目录，明确 Grok 是外部 ACP Provider。
  - 做完你能看到什么：这次接入有正式范围、风险和验收入口，不再靠聊天记录推进。
  - 先依赖什么：无
  - 主要改哪里：`specs/spec010.6-GrokBuild外部运行时接入/*`
  - 这一步先不做什么：不改业务代码，不安装 Grok，不启动开发服务器。
  - 怎么算完成：主文档齐全，需求、设计和任务编号能够互相追踪。
  - 怎么验证：文档结构检查和 `git diff --check`。
  - 对应需求：全部需求
  - 对应设计：全部章节

### 0.2 固定 Grok 上游资料和版本基线

- [x] 0.2 记录 Grok Build ACP、会话、认证和无头模式资料
  - 状态：DONE
  - 这一步到底做什么：记录当前上游提交、启动命令、ACP 方法、session 文件位置、认证方式和已知平台边界。
  - 做完你能看到什么：后面协议测试有明确参照，不会把某次临时实测当成长期契约。
  - 先依赖什么：0.1
  - 开始前先看：
    - `docs/20260910-GrokBuild协议与版本基线.md`
    - Grok 官方 README 和 Agent mode 文档
  - 主要改哪里：`specs/spec010.6-GrokBuild外部运行时接入/docs/20260910-GrokBuild协议与版本基线.md`
  - 这一步先不做什么：不把上游内部 Rust 模块复制到 CodingNS。
  - 怎么算完成：提交 SHA、Source-Revision、ACP 入口和未确认字段都已记录。
  - 怎么验证：人工核对官方链接和文档中的命令顺序。
  - 对应需求：需求 1、2、6、7
  - 对应设计：§1.3、§3.3、§8.1

### 0.3 锁定首版边界

- [x] 0.3 锁定首版能力和权限边界
  - 状态：DONE
  - 这一步到底做什么：确定首版先支持 ACP 主链路，暂不开放附件、原生 Fork、删除、Token Usage 和 CodingNS 权限弹窗。
  - 做完你能看到什么：不会因为“ACP 能发消息”就顺手开放一堆未经验证的按钮。
  - 先依赖什么：0.1、0.2
  - 主要改哪里：`requirements.md`、`design.md`、`tasks.md`
  - 这一步先不做什么：不承诺 `--always-approve` 能替代 CodingNS 权限治理。
  - 怎么算完成：In Scope、Out of Scope、能力快照和风险表一致。
  - 怎么验证：Spec 评审。
  - 对应需求：需求 4、需求 6、需求 7
  - 对应设计：§1、§3.2.3、§8

### 阶段检查

- [x] 0.4 阶段 0 检查：范围、资料和风险没有互相矛盾
  - 状态：DONE
  - 这一步到底做什么：在写代码前检查 Spec 是否明确了协议、权限、历史和跨平台边界。
  - 做完你能看到什么：可以开始实现，不需要边写边猜 Provider 的职责。
  - 先依赖什么：0.1、0.2、0.3
  - 主要改哪里：当前 Spec 全部文件
  - 这一步先不做什么：不新增需求，不启动 Grok 实例。
  - 怎么算完成：每条需求都有设计章节和验证方式；待确认项没有被误写成已确认事实。
  - 怎么验证：人工走查、文件结构检查、行尾空白检查和 `git diff --check`。
  - 任务结果：通过。已确认本 Spec 只新增 `specs/spec010.6-GrokBuild外部运行时接入/`，未修改业务代码或启动服务。
  - 对应需求：全部需求
  - 对应设计：§1、§7、§8

## 阶段 1：先做 ACP 协议夹具和能力判断

### 1.1 实现 Grok ACP 多路复用客户端

- [ ] 1.1 实现 `GrokAcpClient` 和 fake stdio server
  - 状态：TODO
  - 这一步到底做什么：实现子进程 stdin/stdout/stderr 管理、JSON-RPC request id、response、notification 和 server request 的多路复用。
  - 做完你能看到什么：测试可以在不调用真实模型的情况下验证 ACP 交错消息、超时和非法输出。
  - 先依赖什么：0.4
  - 开始前先看：
    - `requirements.md` 需求 2、需求 3、需求 7
    - `design.md` §2.3.3、§3.3.1、§3.3.2
    - `packages/session-sync-core/src/runtime/codex-runtime.ts`
  - 主要改哪里：
    - `packages/session-sync-core/src/runtime/grok-acp-client.ts`
    - `packages/session-sync-core/tests/grok-acp-client.test.mjs`
    - `apps/host/tests/fixtures/`（如现有夹具适合放置）
  - 这一步先不做什么：不注册 Provider，不连接真实 Grok，不实现权限 UI。
  - 怎么算完成：
    1. response 与 request id 唯一匹配。
    2. notification 不会占用 pending response。
    3. server request 有有界回复，未知方法不会永久挂起。
    4. stderr 不进入 stdout JSON-RPC 解析器。
  - 怎么验证：ACP 客户端单元测试，覆盖交错响应、重复 id、非法 JSON、超时和 close。
  - 对应需求：需求 2、需求 3、需求 7
  - 对应设计：§2.3.3、§3.3.1、§3.3.2、§6.1

### 1.2 实现握手和能力快照

- [ ] 1.2 实现 `initialize`、配置选项和降级判定
  - 状态：TODO
  - 这一步到底做什么：读取 ACP 协议版本、client/server capabilities、`configOptions` 和 Grok 版本，生成 CodingNS 能力快照。
  - 做完你能看到什么：未知版本不会消失，未验证能力也不会被 UI 误开放。
  - 先依赖什么：1.1
  - 开始前先看：
    - `requirements.md` 需求 1、需求 6
    - `design.md` §3.2.3、§3.3.5、§4.2.1
    - `specs/spec010.5-DeepSeekHarness外部运行时接入/docs/20260814-Harness协议与版本基线.md`
  - 主要改哪里：
    - `packages/session-sync-core/src/providers/grok.ts`
    - `packages/session-sync-core/src/providers/grok-capabilities.ts`
    - 相关 capability 测试
  - 这一步先不做什么：不根据应用版本字符串硬拒绝，不开放未验证的 Fork、附件和 Token Usage。
  - 怎么算完成：
    1. `ready`、`degraded`、`read-only` 有明确进入条件。
    2. 模型和 reasoning effort 可从 `configOptions` 转换。
    3. 能力限制会出现在 `limitations` 中。
  - 怎么验证：fake initialize 响应测试和未知协议降级测试。
  - 对应需求：需求 1、需求 6
  - 对应设计：§3.2.3、§4.2.1、§6.4

### 1.3 阶段检查：协议层可以独立验证

- [ ] 1.3 阶段 1 检查
  - 状态：TODO
  - 这一步到底做什么：确认 ACP 客户端、握手、能力降级和错误分类已经稳定。
  - 做完你能看到什么：后续 Runtime 代码只依赖明确的 ACP 客户端契约。
  - 先依赖什么：1.1、1.2
  - 主要改哪里：阶段 1 全部相关文件
  - 这一步先不做什么：不改前端，不接真实模型。
  - 怎么算完成：协议测试覆盖成功、交错、未知、超时和失败路径。
  - 怎么验证：包内精确测试、TypeScript 类型检查、`git diff --check`。
  - 对应需求：需求 1、需求 2、需求 3、需求 7
  - 对应设计：§3、§5、§7

## 阶段 2：接入 Provider 和实时会话主链路

### 2.1 实现 Grok ProviderAdapter 的绑定和历史读取

- [ ] 2.1 实现 `GrokProviderAdapter` 的基础能力
  - 状态：TODO
  - 这一步到底做什么：让已绑定的 Grok session 能被 CodingNS 读取、恢复和展示，并实现必要的 `ProviderAdapter` 方法。
  - 做完你能看到什么：Grok 会话能进入现有 SessionHistoryService，不需要另写历史接口。
  - 先依赖什么：1.2
  - 开始前先看：
    - `requirements.md` 需求 5、需求 6
    - `design.md` §3.2.1、§3.3.4、§4.4
    - `packages/session-sync-core/src/types.ts`
    - `packages/session-sync-core/src/providers/deepseek-harness.ts`
  - 主要改哪里：
    - `packages/session-sync-core/src/providers/grok.ts`
    - `packages/session-sync-core/src/providers/grok-session-store.ts`
    - `packages/session-sync-core/src/providers/grok-message-mapper.ts`
    - Provider registry 和 core 测试
  - 这一步先不做什么：不扫描陌生全局会话，不实现删除、收藏、分享和原生 Fork。
  - 怎么算完成：
    1. `rawStoreRef` 只允许受控 `grok://` 格式。
    2. `updates.jsonl` 可转换为稳定 `HistoryPage`，无法识别的事件不伪造成文本。
    3. 用户和 workspace 不匹配时读取被拒绝。
  - 怎么验证：Provider 单元测试、历史分页测试、路径边界测试。
  - 对应需求：需求 5、需求 6
  - 对应设计：§3.2.1、§3.3.4、§4.4

### 2.2 实现 GrokRuntimeAdapter

- [ ] 2.2 实现创建、加载、提示词和流式事件
  - 状态：TODO
  - 这一步到底做什么：把 `startSession`、`continueSession`、`session/new/load`、`session/prompt` 和 ACP update 接入现有 ProviderRuntimeService。
  - 做完你能看到什么：通过 CodingNS `start-live` 可以看到 Grok 文本、思考和工具事件。
  - 先依赖什么：1.1、1.2
  - 开始前先看：
    - `requirements.md` 需求 2、需求 3
    - `design.md` §2.3.1、§2.3.2、§4.3
    - `packages/session-sync-core/src/runtime/types.ts`
    - `packages/session-sync-core/src/runtime/codex-runtime.ts`
  - 主要改哪里：
    - `packages/session-sync-core/src/runtime/grok-runtime.ts`
    - `packages/session-sync-core/src/runtime/grok-message-mapper.ts`
    - `packages/session-sync-core/tests/grok-runtime.test.mjs`
  - 这一步先不做什么：不承诺运行中追加消息、附件、原生 Fork 和权限弹窗。
  - 怎么算完成：
    1. start/load 都能返回 session binding。
    2. `session/update` 的 text/thought/tool update 映射正确。
    3. complete、interrupt、error 终态互斥。
  - 怎么验证：fake ACP runtime 测试、运行时事件断言和进程退出测试。
  - 对应需求：需求 2、需求 3、需求 7
  - 对应设计：§2.3、§3.3、§4.2、§4.3

### 2.3 注册 Host 主链路

- [ ] 2.3 将 Grok 注册到 Host Provider、Runtime 和配置探测
  - 状态：TODO
  - 这一步到底做什么：把 Grok 加入 Provider Catalog、Runtime State、SessionHistoryService 和 SessionLiveRuntimeService 的注册点。
  - 做完你能看到什么：Provider 列表能看到 Grok，命令缺失时只显示未安装，不会让 Host 启动失败。
  - 先依赖什么：2.1、2.2
  - 开始前先看：
    - `requirements.md` 需求 1、需求 2、需求 6、需求 7
    - `design.md` §2.2
    - `apps/host/src/config/env.ts`
    - `apps/host/src/modules/provider/provider-catalog-service.ts`
    - `apps/host/src/modules/provider/provider-runtime-state-service.ts`
    - `apps/host/src/modules/sessions/session-live-runtime-service.ts`
  - 主要改哪里：
    - `apps/host/src/config/env.ts`
    - `apps/host/src/modules/provider/provider-catalog-service.ts`
    - `apps/host/src/modules/provider/provider-runtime-state-service.ts`
    - `apps/host/src/modules/sessions/session-history-service.ts`
    - `apps/host/src/modules/sessions/session-live-runtime-service.ts`
    - `packages/session-sync-core/src/index.ts`
  - 这一步先不做什么：不把 Grok 加入 Butler、助手服务、Skill 目标或其他尚未验证的静态白名单。
  - 怎么算完成：
    1. `CODINGNS_GROK_COMMAND` 和 `CODINGNS_GROK_HOME` 有明确默认和覆盖语义。
    2. provider catalog、capability 和 runtime adapter 使用同一个 `providerId`。
    3. 命令缺失不影响其他 Provider 的状态刷新。
  - 怎么验证：Host provider catalog、runtime state 和 session route 精确测试。
  - 对应需求：需求 1、需求 2、需求 6、需求 7
  - 对应设计：§2.1、§3.1、§4.2

### 2.4 阶段检查：主链路跑通

- [ ] 2.4 阶段 2 检查
  - 状态：TODO
  - 这一步到底做什么：用 fake ACP 完成 CodingNS 会话创建、首条 prompt、流式事件、完成、恢复和中断回放。
  - 做完你能看到什么：不是只有类和接口，而是一条可以重复验证的完整主链路。
  - 先依赖什么：2.1、2.2、2.3
  - 主要改哪里：阶段 2 相关实现和测试
  - 这一步先不做什么：不接真实账号，不开放前端高级入口。
  - 怎么算完成：事件不重复、终态正确、绑定可恢复、其他 Provider 回归通过。
  - 怎么验证：`pnpm test:related --` 指向本阶段变更文件，Host/core 类型检查和 `git diff --check`。
  - 对应需求：需求 2、需求 3、需求 5、需求 7
  - 对应设计：§2、§3、§4、§7

## 阶段 3：把权限和凭据边界做实

### 3.1 固化受控 MVP 的 always-approve 边界

- [ ] 3.1 固化首版 `--always-approve` 的本机可信环境限制
  - 状态：TODO
  - 这一步到底做什么：在没有 CodingNS 权限桥接前，明确启动参数、UI 文案、能力关闭项和运行环境限制。
  - 做完你能看到什么：用户不会误以为 Grok 的文件和终端操作经过 CodingNS 逐次审批。
  - 先依赖什么：2.4
  - 开始前先看：
    - `requirements.md` 需求 4
    - `design.md` §1.3、§3.2.3、§5.2
    - `apps/host/src/modules/sessions/session-permission-request-service.ts`
  - 主要改哪里：能力矩阵、Provider 限制说明、运行时配置和测试文档。
  - 这一步先不做什么：不把 Grok server request 静默当成已授权，不开放远程共享 Host 的无隔离运行。
  - 怎么算完成：权限能力为 false；未桥接请求有界失败；API Key/auth.json 不进入日志或数据库。
  - 怎么验证：权限未桥接测试、日志脱敏检查和人工走查。
  - 对应需求：需求 4、需求 7
  - 对应设计：§3.2.3、§5.2、§6.3

### 3.2 实现 ACP 权限请求桥接

- [ ] 3.2 将 Grok 权限请求映射到 CodingNS 权限服务
  - 状态：TODO
  - 这一步到底做什么：识别 `session/request_permission` 及 fs/terminal/user input 请求，创建 CodingNS 权限请求并回复原始 JSON-RPC id。
  - 做完你能看到什么：用户可以在现有权限界面允许、拒绝或中断 Grok 工具动作。
  - 先依赖什么：3.1，且必须先锁定真实 Grok ACP 字段。
  - 开始前先看：
    - `requirements.md` 需求 4
    - `design.md` §2.3.3、§3.3.2
    - `apps/host/src/modules/sessions/session-permission-request-service.ts`
  - 主要改哪里：
    - `apps/host/src/modules/sessions/session-permission-request-service.ts`
    - Grok runtime server-request handler
    - 权限请求集成测试和 i18n
  - 这一步先不做什么：不把 Grok 任意工具名直接提升为系统权限，不绕过现有用户和 workspace 校验。
  - 怎么算完成：权限请求、用户回复、超时、拒绝和中断都能闭合；无法识别的请求 fail closed。
  - 怎么验证：fake ACP server-request 集成测试和现有权限接口回放。
  - 对应需求：需求 4
  - 对应设计：§2.3.3、§5.2、§7.2

### 3.3 固化认证与 GROK_HOME 隔离

- [ ] 3.3 补齐认证状态、运行目录和密钥处理
  - 状态：TODO
  - 这一步到底做什么：把命令可用、协议可用和认证可用分开，并固定 `GROK_HOME`、API Key、OAuth 文件和错误日志的边界。
  - 做完你能看到什么：未登录用户看到认证引导；已登录用户不会因为 session 配置泄漏凭据。
  - 先依赖什么：2.3
  - 主要改哪里：
    - `apps/host/src/config/env.ts`
    - Provider runtime launch context
    - 认证状态测试和文档
  - 这一步先不做什么：不复制 `auth.json`，不把 API Key 写入 SQLite 或前端响应。
  - 怎么算完成：认证失败有独立错误码；用户私有目录权限和路径边界有测试。
  - 怎么验证：脱敏日志测试、环境变量注入测试和本机目录权限检查。
  - 对应需求：需求 1、需求 4、需求 5
  - 对应设计：§1.3、§3.2.1、§5.2

### 3.4 阶段检查：权限和凭据边界可解释

- [ ] 3.4 阶段 3 检查
  - 状态：TODO
  - 这一步到底做什么：确认当前部署模式下用户知道谁在执行工具、凭据存在哪里、权限未桥接时会发生什么。
  - 做完你能看到什么：不会出现“UI 显示安全、实际 Grok 自由执行”的错觉。
  - 先依赖什么：3.1、3.2、3.3
  - 主要改哪里：阶段 3 相关实现、能力矩阵和文档
  - 这一步先不做什么：不扩展附件和分享能力。
  - 怎么算完成：权限路径要么闭合，要么明确 fail closed；所有敏感数据检查通过。
  - 怎么验证：权限集成测试、日志审查、`git diff --check`。
  - 对应需求：需求 1、需求 4、需求 5、需求 7
  - 对应设计：§5、§6、§8

## 阶段 4：补齐历史、跨平台和用户入口

### 4.1 完成已绑定会话的历史与发现

- [ ] 4.1 接入工作区会话列表和增量历史
  - 状态：TODO
  - 这一步到底做什么：让 CodingNS 能按 workspace 读取已绑定 Grok session 的摘要、标题、消息数量和历史分页。
  - 做完你能看到什么：刷新工作区后 Grok 会话与其他 Provider 一样出现在会话列表中，且不混入其他工作区。
  - 先依赖什么：2.1、3.3
  - 主要改哪里：Grok session store reader、SessionHistoryService 注册和历史测试。
  - 这一步先不做什么：不把所有 `~/.grok/sessions` 直接导入，不实现跨 Provider 原生 Fork。
  - 怎么算完成：summary/updates 解析、游标、标题和 workspace 过滤都有精确测试。
  - 怎么验证：临时 `GROK_HOME` fixture、历史分页测试和工作区隔离测试。
  - 对应需求：需求 5、需求 6
  - 对应设计：§3.3.4、§4.4、§7.2

### 4.2 验证 Windows、macOS 和 Linux 进程行为

- [ ] 4.2 完成跨平台 CLI 和进程回收验证
  - 状态：TODO
  - 这一步到底做什么：验证 `grok`/`grok.exe` 路径发现、stdio 行协议、工作目录、stderr、取消和进程树回收。
  - 做完你能看到什么：不会只在 macOS 上能用，Windows 上却留下孤儿进程或污染协议输出。
  - 先依赖什么：2.4、3.3
  - 主要改哪里：命令探测、runtime process wrapper、跨平台测试和验证文档。
  - 这一步先不做什么：不在 Windows 上从源码构建 Grok，不把未测试的 sandbox 行为写成保证。
  - 怎么算完成：三平台至少完成命令探测和 fake ACP 进程回收；真实 Grok 结果单独记录。
  - 怎么验证：平台矩阵测试和实际 `grok --version`/最小握手记录。
  - 对应需求：需求 1、需求 7
  - 对应设计：§2.3.4、§8.1

### 4.3 加入 user-app Provider 入口和 i18n

- [ ] 4.3 接入前端 Provider 展示和能力限制
  - 状态：TODO
  - 这一步到底做什么：在 `user-app` 中加入 Grok 的名称、安装/认证/降级状态、能力限制和必要的入口文案。
  - 做完你能看到什么：普通用户能区分未安装、未认证、只读和可运行状态，不会看到未实现按钮。
  - 先依赖什么：2.3、3.1、4.1
  - 开始前先看：
    - `docs/开发设计规范/20260419-前端页面与样式设计规范.md`
    - `specs/spec010.4-CLI提供商启用控制与能力矩阵/`
  - 主要改哪里：
    - `apps/user-app/` 相关 provider catalog、picker、i18n 字典和测试
  - 这一步先不做什么：不改已经下线的历史前端目录，不硬编码模型列表，不显示未验证的权限、附件和 Fork 入口。
  - 怎么算完成：所有显示文字来自 i18n；能力矩阵和 Host 返回一致；移动和桌面布局不新增溢出。
  - 怎么验证：前端相关测试、类型检查和静态文案检查。
  - 对应需求：需求 1、需求 4、需求 6
  - 对应设计：§3.2.3、§7.2

### 4.4 阶段检查：用户入口与外部状态一致

- [ ] 4.4 阶段 4 检查
  - 状态：TODO
  - 这一步到底做什么：确认命令探测、认证、能力矩阵、会话列表和前端入口读取同一套状态。
  - 做完你能看到什么：Provider 不会出现“后端拒绝但前端还显示可用”的分裂状态。
  - 先依赖什么：4.1、4.2、4.3
  - 主要改哪里：阶段 4 相关实现和文档
  - 这一步先不做什么：不追加高级 Agent、MCP 管理或分享功能。
  - 怎么算完成：状态矩阵和跨平台验证记录齐全。
  - 怎么验证：Host/user-app 精确测试、人工走查和 `git diff --check`。
  - 对应需求：需求 1、需求 5、需求 6、需求 7
  - 对应设计：§2、§4、§7

## 阶段 5：集成验收和回写

### 5.1 完成最小端到端回放

- [ ] 5.1 使用锁定版本 Grok 完成最小真实回放
  - 状态：TODO
  - 这一步到底做什么：在隔离临时工作区验证真实 `grok --version`、认证状态、ACP initialize、session/new/load、最小 prompt 和中断。
  - 做完你能看到什么：有真实运行证据，但不会把一次模型回答当成所有协议能力都通过。
  - 先依赖什么：4.4
  - 主要改哪里：`docs/20260910-GrokBuild协议与版本基线.md` 和新增验收记录。
  - 这一步先不做什么：不把真实账号凭据、完整 prompt 或完整对话内容写进仓库。
  - 怎么算完成：平台、版本、认证方式、协议结果和未验证能力分开记录。
  - 怎么验证：按项目测试规则执行精确测试，并人工保存脱敏结果。
  - 对应需求：全部需求
  - 对应设计：§7、§8

### 5.2 最终检查

- [ ] 5.2 最终 Spec 验收
  - 状态：TODO
  - 这一步到底做什么：把需求、设计、任务、测试和风险逐条对齐，确认没有把部分成功写成完整交付。
  - 做完你能看到什么：Spec 状态、代码状态和验证证据一致，后续维护者知道哪些能力仍然关闭。
  - 先依赖什么：5.1
  - 主要改哪里：当前 Spec 全部文件、实现提交记录和验收文档。
  - 这一步先不做什么：不在最终验收时临时增加新能力。
  - 怎么算完成：
    1. 所有已完成任务都有验证命令或人工证据。
    2. 未完成能力留在风险/待确认项中。
    3. `tasks.md` 已回写每个任务的最终状态。
  - 怎么验证：精确测试、类型检查、`pnpm check:sqlite-runtime`（如改动 SQLite）、`git diff --check` 和文档走查。
  - 对应需求：全部需求
  - 对应设计：§7、§8

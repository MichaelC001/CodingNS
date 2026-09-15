# 需求文档 - spec010.8 Pi Agent CLI 适配接入

状态：Draft

## 简介

Pi Agent 是一个提供交互模式、JSON 输出、RPC 和 SDK 的编码代理 CLI。本项目已经有多套外部 CLI 运行时适配器，因此 Pi 最简单、最清晰的接入方式是：Host 启动 `pi --mode rpc`，通过严格 JSONL 与它通信，再把事件和会话文件转换成 CodingNS 的统一模型。

这次接入必须先把 Pi 能做什么、不能做什么写清楚，避免前端显示一个实际上无法完成的按钮，也避免把 Pi 的本地会话格式误当成 CodingNS 自己的会话格式。

## 术语

- **Pi Agent**：`@earendil-works/pi-coding-agent`，本 Spec 固定基线为 `0.85.1`。
- **Pi RPC**：Pi 通过 stdin/stdout 传输的严格 JSONL 命令和事件协议。
- **Pi session JSONL**：Pi 保存的树形会话文件，包含 session header、message entry 和 parentId 关系。
- **扩展 UI 请求**：Pi 扩展通过 `extension_ui_request` 请求 select、confirm、input 或 editor，Host 需要回传 `extension_ui_response`。
- **有效完成**：Pi 发出 `agent_settled`，代表当前 prompt、自动重试、压缩和排队消息都已经结束。`prompt` response 只代表请求被接受。

## 范围说明

### In Scope

- 通过 Pi RPC 接入新建、继续、发送、排队、steer、中断和完成事件。
- 归一化文本、思考、工具调用、工具结果、错误和 token usage。
- 支持模型读取和切换、图片附件、文件附件路径/提示词协议。
- 支持会话发现、历史读取、增量 JSONL 解析、Fork、Clone、重命名。
- 定义删除和归档的 CodingNS 语义，并在 Pi 不具备原生能力时做可恢复的文件级降级。
- 将 Pi 扩展 UI 请求转换为 CodingNS 的权限/问题交互事件。
- 加载 RPC 兼容的 Plan Mode 扩展，完成计划审批和回传。
- 用 capability 控制前端入口，避免把 Pi 不支持的 DSH 能力显示出来。
- 建立不依赖真实模型密钥的协议 fixture、事件回放和集成测试。

### Out of Scope

- 不修改 Pi 上游源码，不把 Pi 的内部 AgentSession 重写进 CodingNS。
- 第一阶段不承诺 DSH Remote 级别的事件重放、运行中请求接管和 Host 重启后恢复正在执行的 turn。
- 不把 Pi 示例中依赖 TUI `ctx.ui.custom()` 的 `question/questionnaire` 直接当成 RPC 问题工具。
- 不伪造 Pi 原生 Agent Preset、subagent、session/control 或精确权限范围能力。
- 不为了 Pi 新增一套独立的后台任务、私有 timer、私有 inflight 或重试队列。

## 需求 1：Pi 必须作为正式 Provider 接入

**用户故事：** 作为维护者，我希望 Pi 通过现有 Provider 注册、会话绑定和能力描述接入，而不是在 Host 主流程里再长出一套特殊分支。

### 验收标准

1. WHEN Pi Provider 被启用 THEN System SHALL 通过统一 Provider registry 和 runtime adapter 注册。
2. WHEN Pi 会话创建或恢复 THEN System SHALL 保存 Pi 原生 `sessionId` 和稳定 `sessionFile` 引用。
3. WHEN Pi 某项能力不可用 THEN System SHALL 通过 `ProviderCapabilities` 和 `limitations` 明确表达。

## 需求 2：新建、继续和发送会话

**用户故事：** 作为用户，我希望在 CodingNS 中新建 Pi 会话、继续已有会话，并能发送下一条消息。

### 验收标准

1. WHEN 新建会话 THEN System SHALL 启动 `pi --mode rpc`，读取 `get_state`，并绑定 Pi `sessionId`/`sessionFile`。
2. WHEN 继续会话 THEN System SHALL 使用已绑定的 session 文件或精确 session id 启动 Pi，并恢复历史上下文。
3. WHEN 发送消息 THEN System SHALL 只在 Pi 返回 prompt accepted 后报告已接受，不能提前报告完成。
4. WHEN Pi 返回 `agent_settled` THEN System SHALL 发出统一的 `complete` 事件。
5. WHEN 启动、解析或请求失败 THEN System SHALL 发出可追踪的统一错误事件，并回收子进程。

## 需求 3：运行事件必须完整归一化

**用户故事：** 作为前端开发者，我希望 Pi 的文本、思考和工具过程和其他 Provider 一样实时显示。

### 验收标准

1. WHEN Pi 发出 `message_update` THEN System SHALL 支持 text、thinking 和 tool call 增量。
2. WHEN Pi 发出 `message_end` THEN System SHALL 以完整消息作为最终可信内容。
3. WHEN Pi 发出 `tool_execution_start/update/end` THEN System SHALL 归一化为工具调用和工具结果状态。
4. WHEN Pi 发出未知事件 THEN System SHALL 保留原始事件引用，不因未知事件阻断当前会话。
5. WHEN Pi 发出 `agent_end` 但仍有重试、压缩或队列 THEN System SHALL NOT 把它当作最终完成。

## 需求 4：运行中输入和中断

**用户故事：** 作为用户，我希望在 Pi 正在运行时改变方向、追加后续消息或中断当前运行。

### 验收标准

1. WHEN 当前 turn 正在运行且用户选择 steer THEN System SHALL 发送 RPC `steer` 或带 `streamingBehavior: "steer"` 的 prompt。
2. WHEN 用户选择 follow-up THEN System SHALL 发送 RPC `follow_up`，并保留队列语义。
3. WHEN 用户中断 THEN System SHALL 发送 RPC `abort`，等待 Pi 空闲或进程退出后再发出 interrupted。
4. WHEN RPC 队列清理被请求 THEN System SHALL 能读取并返回被清理的 steering/follow-up 文本。

## 需求 5：模型切换和基础用量

**用户故事：** 作为用户，我希望查看可用模型、切换模型，并看到基本 token 使用量。

### 验收标准

1. WHEN 读取模型列表 THEN System SHALL 使用 Pi `get_available_models` 或等价 SDK 数据填充模型选项。
2. WHEN 切换模型 THEN System SHALL 使用 Pi `set_model`，并在失败时保留原模型状态。
3. WHEN Pi 事件带 usage THEN System SHALL 记录 input、output、cache 和 cost 字段中可验证的值。
4. WHEN Pi 没有提供某项统计 THEN System SHALL 保持缺失，不伪造 0。
5. WHEN 统计口径无法和 DSH projection 对齐 THEN System SHALL 标记为 Pi runtime 来源，并在 capability 限制中说明。

## 需求 6：图片和文件附件

**用户故事：** 作为用户，我希望把图片或工作区文件带入 Pi 对话。

### 验收标准

1. WHEN 附件是图片 THEN System SHALL 在 RPC prompt 中发送合法的 base64 image content。
2. WHEN 附件是工作区内文件 THEN System SHALL 使用受控的路径引用或文件内容提示词，不允许把任意本机路径暴露给 Pi。
3. WHEN 附件位于允许的外部附件目录 THEN System SHALL 校验路径边界、文件大小和 MIME 类型。
4. WHEN 文件不能原生作为 Pi 图片输入 THEN System SHALL 明确走“路径协议”或“文本摘要协议”，不能静默丢附件。

## 需求 7：会话发现、历史和增量读取

**用户故事：** 作为用户，我希望 Pi 的已有会话能出现在 CodingNS 列表中，历史读取不会每次从头扫描大文件。

### 验收标准

1. WHEN 扫描工作区会话 THEN System SHALL 只接受 cwd 与目标工作区匹配的 Pi session JSONL。
2. WHEN 读取历史 THEN System SHALL 正确处理 session header、message entry、parentId、工具消息和未知 entry。
3. WHEN JSONL 发生追加 THEN System SHALL 根据文件指纹和游标增量解析，不重复发送已有消息。
4. WHEN 文件存在不完整尾行、替换或读期间变化 THEN System SHALL 返回 partial/reset 诊断，而不是损坏历史。
5. WHEN 扫描属于跨请求、重 I/O 或可复用任务 THEN System SHALL 通过现有 TaskManager/helper 执行，不在 Host 主线程新增同步大扫描。

## 需求 8：Fork、Clone、重命名、删除和归档

**用户故事：** 作为用户，我希望像管理其他 Provider 会话一样分叉、复制、重命名、删除或归档 Pi 会话。

### 验收标准

1. WHEN 用户按历史用户消息 Fork THEN System SHALL 将 CodingNS 消息 id 映射到 Pi entry id，并调用 RPC `fork`。
2. WHEN 用户 Clone 当前分支 THEN System SHALL 调用 RPC `clone`，重新绑定新 session 文件。
3. WHEN 用户重命名 THEN System SHALL 调用 Pi `set_session_name`，并同步 CodingNS 标题缓存。
4. WHEN 用户删除 THEN System SHALL 先停止运行，再在允许的 Pi session 根目录内删除文件，并清理索引。
5. WHEN 用户归档 THEN System SHALL 使用 CodingNS 的归档元数据；如果 Pi 没有原生 archive，必须保留可恢复路径和明确标记。
6. WHEN Fork/Clone 失败 THEN System SHALL 不改变原会话绑定和标题。

## 需求 9：扩展 UI、权限请求和 Question

**用户故事：** 作为 CodingNS 用户，我希望 Pi 扩展请求确认、选择或补充信息时，能在 CodingNS 界面完成，而不是卡死在后台进程中。

### 验收标准

1. WHEN Pi 发出 `extension_ui_request` 的 select/confirm/input/editor THEN System SHALL 转换成 CodingNS 可订阅的交互事件。
2. WHEN 用户作出选择 THEN System SHALL 使用原 request id 回传 `extension_ui_response`。
3. WHEN 请求超时、取消或 Pi 退出 THEN System SHALL 清理挂起请求，并让 Pi 收到取消结果或明确错误。
4. WHEN 交互请求无法表达 DSH 的权限范围 THEN System SHALL 不伪装成完整权限审批，记录降级原因。
5. WHEN 使用 RPC 兼容 question 工具 THEN System SHALL 禁止依赖 `ctx.ui.custom()`，只使用 select/confirm/input/editor。

## 需求 10：Plan Mode 审批

**用户故事：** 作为用户，我希望 Pi 先生成只读计划，再由我决定执行、继续规划或修改计划。

### 验收标准

1. WHEN Pi Provider 启动并启用 Plan Mode THEN System SHALL 加载版本固定、来源可信的 plan-mode 扩展。
2. WHEN Plan Mode 禁止编辑 THEN System SHALL 关闭 edit/write，并保留允许的读取工具。
3. WHEN 计划生成后需要审批 THEN System SHALL 显示 Plan 扩展发出的 select 请求。
4. WHEN 用户选择执行/继续/修改 THEN System SHALL 回传选择，并继续接收扩展发出的后续消息和状态事件。
5. WHEN Plan 扩展依赖 TUI custom UI 或扩展未加载 THEN System SHALL 关闭相关入口，不显示假审批能力。

## 需求 11：安全、隔离和生命周期

**用户故事：** 作为维护者，我希望 Pi 不能因为工作区扩展、路径或子进程异常破坏 Host 或其他用户的会话。

### 验收标准

1. WHEN 启动 Pi THEN System SHALL 为每个工作区配置隔离的 `PI_CODING_AGENT_DIR`/session-dir，避免串用用户配置。
2. WHEN 解析 stdout THEN System SHALL 使用严格 LF JSONL 读取，stderr 只用于诊断。
3. WHEN Pi 子进程退出、超时或被中断 THEN System SHALL 清理监听器、挂起 UI 请求和运行句柄。
4. WHEN 加载扩展 THEN System SHALL 只加载允许来源，并默认关闭未授权的项目扩展发现。
5. WHEN Host 重启时存在正在运行的 Pi turn THEN System SHALL 明确标记为无法接管，不伪造恢复成功。

## 需求 12：回归和可观测性

**用户故事：** 作为维护者，我希望升级 Pi 或修改适配器后，可以在没有真实模型密钥时验证主要协议和错误路径。

### 验收标准

1. WHEN 执行 Pi RPC fixture THEN System SHALL 覆盖启动、状态、模型、prompt 接收失败、事件流、tool、abort、Fork 和 UI 请求。
2. WHEN 修改 session parser THEN System SHALL 运行 Pi JSONL fixture、增量读取和不完整尾行测试。
3. WHEN 修改 capability THEN System SHALL 验证 Host catalog、前端按钮门控和 provider 配置。
4. WHEN 发生运行时失败 THEN System SHALL 记录 provider、session id、rawStoreRef、事件类型和错误码。
5. WHEN 本 Spec 的实现任务完成 THEN System SHALL 更新 tasks.md 的验证记录和已知限制。

## 成功定义

- Pi 能作为正式 Provider 完成新建、继续、发送、事件流、中断和模型切换。
- Pi session JSONL 能被发现、增量读取、Fork/Clone、重命名和安全删除。
- 图片附件和文件路径/提示词协议有明确且可验证的行为。
- 扩展 UI、question 和 Plan 审批不会阻塞 RPC 进程。
- 前端只显示 Pi 真实支持的能力，DSH 专属能力不会被冒充。
- 关键协议和解析测试不依赖真实模型 API Key。

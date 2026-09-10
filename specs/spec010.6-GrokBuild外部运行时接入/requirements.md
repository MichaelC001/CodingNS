# 需求文档 - Grok Build 外部运行时接入

状态：Draft

## 简介

Grok Build 是 xAI 发布的终端编码 Agent，提供 TUI、无头模式和 ACP stdio 长连接模式。CodingNS 已有统一的 Provider、会话历史、运行时事件和权限请求模型，需要把 Grok 作为可选外部运行时接入，而不是为它另起一套前端协议。

这次 Spec 的目标是让 CodingNS 能够安全地启动 Grok、创建或恢复 Grok 会话、转发提示词和流式事件，并准确报告尚未实现的能力。Grok 自己拥有文件、终端和 MCP 工具，因此 CodingNS 必须明确哪些权限由 Grok 自己处理，哪些权限由 CodingNS 接管。

## 术语表

- **System**：CodingNS Host 与现有 `session-sync-core`。
- **Grok Build**：xAI 发布的 `grok` CLI/Agent Runtime。
- **ACP**：Agent Client Protocol，Grok stdio 使用的 JSON-RPC 协议。
- **Grok Runtime**：由 CodingNS 启动并管理的 `grok agent ... stdio` 子进程。
- **Grok 会话**：由 ACP `session/new` 或 `session/load` 管理、由 Grok 持久化的会话。
- **能力快照**：根据 ACP 握手、配置选项和实际验证结果生成的 `ProviderCapabilities`。

## 范围说明

### In Scope

- Grok CLI 路径、版本和认证可用性的分层探测。
- ACP stdio 进程的启动、握手、请求复用、关闭和中断。
- Grok 会话与 CodingNS 会话、工作区的绑定。
- `session/new`、`session/load`、`session/prompt` 和 `session/update` 主链路。
- 文本、思考、工具调用、工具结果、计划、完成和错误事件的标准化。
- 模型与 reasoning effort 配置选项的能力声明。
- Grok 会话文件的最小历史读取和原始引用设计。
- 未知协议、未认证、进程崩溃和权限未桥接时的明确降级。

### Out of Scope

- 将 Grok Rust 源码或内部 crate 合并进 CodingNS。
- 把 Grok 当作 OpenAI 兼容模型 API 接入。
- 首版直接扫描并导入用户全部 `~/.grok/sessions`。
- 在未验证 ACP 请求字段前开放原生 Fork、附件、分享、删除和 Token Usage。
- 首版通过 `--always-approve` 宣称已经复用 CodingNS 权限审计；权限桥接另列任务。
- 让浏览器或远程客户端直接访问 Grok stdio/WebSocket 进程。

## 需求

### 需求 1：外部命令与认证状态可诊断

**用户故事：** 作为 CodingNS 用户，我希望知道 Grok 是未安装、未认证还是协议不可用，以便不会把不同问题混成“Provider 崩溃”。

#### 验收标准

1. WHEN Host 刷新 Provider 状态 THEN System SHALL 分别记录 `grok` 命令路径、应用版本和安装状态。
2. WHEN Grok 命令存在但认证失败 THEN System SHALL 返回明确的认证错误，不把它报告为安装缺失。
3. WHEN `initialize` 握手协议未知或能力不足 THEN System SHALL 保留 Provider 目录项，并进入 `degraded` 或 `read-only`，不能静默隐藏。
4. WHEN 诊断日志写入认证或进程信息 THEN System SHALL 不记录 API Key、`auth.json` 内容和完整提示词。

### 需求 2：ACP 会话主链路

**用户故事：** 作为 CodingNS 用户，我希望用现有会话入口使用 Grok，以便不需要学习另一套调用方式。

#### 验收标准

1. WHEN 用户通过 `start-live` 创建 Grok 会话 THEN System SHALL 启动 ACP stdio、完成 `initialize` 和 `session/new`，并保存 Grok session id。
2. WHEN 用户发送消息 THEN System SHALL 使用 `session/prompt` 发送文本，并返回现有 CodingNS 的消息接受结果。
3. WHEN 用户恢复已绑定会话 THEN System SHALL 使用 `session/load`，不得用新会话冒充恢复成功。
4. WHEN ACP 返回响应、通知或服务端请求 THEN System SHALL 使用 JSON-RPC id 和方法正确复用，不能只按“下一行就是响应”处理。
5. WHEN Grok 进程退出、超时或返回协议错误 THEN System SHALL 结束当前运行并保留可诊断错误，不能返回成功。

### 需求 3：实时消息与运行状态

**用户故事：** 作为 CodingNS 用户，我希望看到 Grok 的文本、思考和工具执行过程，以便判断 Agent 当前是否仍在工作。

#### 验收标准

1. WHEN 收到 `session/update` 的 `agent_message_chunk` THEN System SHALL 转换为 CodingNS assistant 文本消息。
2. WHEN 收到 `agent_thought_chunk`、`tool_call` 或 `tool_call_update` THEN System SHALL 分别转换为 thinking、tool_call 或 tool_result 标准消息。
3. WHEN prompt 返回完成或错误 THEN System SHALL 发出一次且仅一次完成或失败运行事件。
4. WHEN 同一 ACP 更新因重连或缓存重复到达 THEN System SHALL 根据稳定事件引用或本地去重键避免重复显示。
5. WHEN 用户请求中断 THEN System SHALL 优先发送 ACP 取消请求；取消失败时回收当前子进程，并明确标记运行已中断或失败。

### 需求 4：权限和工具边界明确

**用户故事：** 作为工作区管理员，我希望知道 Grok 可以操作什么，以便不会误以为 CodingNS 已经自动限制了 Grok 的文件和终端权限。

#### 验收标准

1. WHEN 首版以 `--always-approve` 启动 Grok THEN System SHALL 在 Provider 能力和文档中明确标注“权限由 Grok 运行时处理，CodingNS 不提供逐次审批”。
2. WHEN CodingNS 尚未实现 ACP 权限请求映射 THEN System SHALL 不声明 `supportsPermissionPrompt` 或 `supportsPermissionRequests` 为 true。
3. WHEN ACP 请求需要 CodingNS 未实现的文件、终端或用户输入能力 THEN System SHALL 返回协议级拒绝或明确不支持，不能挂起请求。
4. WHEN 生产模式开放 CodingNS 权限桥接 THEN System SHALL 将 Grok 权限请求映射到现有权限请求服务，并记录用户、工作区、会话和原始请求关系。
5. WHEN 客户端能力声明发送给 Grok THEN System SHALL 只声明 CodingNS 已实现的 fs、terminal 和权限能力。

### 需求 5：历史、绑定和数据隔离

**用户故事：** 作为多工作区用户，我希望 Grok 会话只出现在正确的工作区，并且可以继续之前的会话。

#### 验收标准

1. WHEN 创建或恢复 Grok 会话 THEN System SHALL 只使用 CodingNS 解析出的规范工作区路径，不接受前端任意 cwd 覆盖。
2. WHEN 保存绑定 THEN System SHALL 持久化 CodingNS session id、Grok session id、workspace id 和受控 `rawStoreRef`。
3. WHEN 读取历史 THEN System SHALL 将 Grok `updates.jsonl` 或 ACP 恢复结果转换为 `NormalizedMessage`，保留可追溯原始引用。
4. WHEN 工作区路径或用户校验失败 THEN System SHALL 在启动 Grok 请求前拒绝，不创建半成品绑定。
5. WHEN 首版无法可靠扫描 Grok 全局会话目录 THEN System SHALL 只读取 CodingNS 已绑定的 Grok session，不伪造完整发现结果。

### 需求 6：能力矩阵和配置选项准确

**用户故事：** 作为 CodingNS 用户，我希望 UI 只显示经过验证的 Grok 能力，以便不会点击一个实际上不可用的功能。

#### 验收标准

1. WHEN Provider 能力被查询 THEN System SHALL 返回 `canStartSession`、`canResumeSession`、`canSendMessage`、中断、工具、权限、附件和 Fork 的真实状态。
2. WHEN `session/new` 或 `session/load` 返回模型和 reasoning effort 配置 THEN System SHALL 转换为 CodingNS 配置选项。
3. WHEN Grok 版本增加未知 `x.ai/*` 扩展 THEN System SHALL 忽略未识别扩展并保留已验证基础能力。
4. WHEN Token Usage、附件、原生 Fork 或删除尚未完成验证 THEN System SHALL 保持关闭并写入限制说明。

### 需求 7：故障隔离与安全回收

**用户故事：** 作为 Host 维护者，我希望 Grok 出故障时不拖垮其他 Provider，并且退出时不会留下失控进程。

#### 验收标准

1. WHEN Grok 启动失败、进程退出或 stdout 出现非法 JSON THEN System SHALL 只影响当前 Grok 运行，不阻塞其他 Provider。
2. WHEN Host 关闭或会话中断 THEN System SHALL 只回收 CodingNS 自己启动的 Grok 子进程。
3. WHEN stderr 出现诊断信息 THEN System SHALL 与 ACP stdout 分离，不能污染 JSON-RPC 通道。
4. WHEN 同一会话重复启动运行 THEN System SHALL 遵守现有 `ProviderRuntimeService` 的 active run 约束，不能另起私有并发队列。
5. WHEN Grok 不可用 THEN System SHALL 保留 CodingNS 会话绑定和最后错误，不能静默删除历史。

## 非功能需求

### 非功能需求 1：可靠性

1. ACP 请求、通知和服务端请求必须支持交错到达，不能依赖固定响应顺序。
2. 外部协议未知时采用能力降级；不能因为版本字符串变化而误伤其他 Provider。
3. 进程、协议、认证和业务错误必须能够区分并可追踪。

### 非功能需求 2：安全

1. `GROK_HOME` 和 `auth.json` 必须位于用户私有目录，不得复制到共享会话目录。
2. API Key 只能通过运行时环境或安全配置注入，不得写入 CodingNS 会话记录。
3. 未实现权限桥接前，首版只允许在明确可信的本机工作区使用 `--always-approve`。

### 非功能需求 3：可维护性

1. ACP 协议解析、事件映射和进程管理必须隔离在 Grok 适配器内。
2. 上游应用版本只用于诊断，协议版本和握手能力是能力判定主键。
3. 每个任务完成后必须回写 `tasks.md` 的状态和最小验证结果。

## 成功定义

- CodingNS 能在不影响其他 Provider 的情况下启动和关闭 Grok ACP 运行时。
- Grok 会话可以完成创建、发送、流式输出、恢复和中断主流程。
- 文本、思考、工具调用和工具结果在 CodingNS 中不重复、不乱序、不伪造。
- 未接入的权限、附件、Fork、删除和 Token Usage 能力明确关闭。
- 协议、进程、认证和工作区边界都有自动化测试或明确的人工验证记录。

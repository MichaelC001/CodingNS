# 设计文档 - Grok Build 外部运行时接入

状态：Draft

## 1. 概述

### 1.1 目标

- 通过官方 `grok agent ... stdio` 将 Grok 接入 CodingNS 现有 Provider 和 Runtime 链路。
- 把 ACP 的双向 JSON-RPC、流式更新和会话恢复转换为 CodingNS 标准模型。
- 明确 Grok 自有工具权限与 CodingNS 权限服务的边界，避免把 `--always-approve` 误当成 CodingNS 审计。
- 在未知协议、认证失败、进程退出和能力缺失时安全降级，不影响其他 Provider。

### 1.2 覆盖需求

- `requirements.md` 需求 1：外部命令与认证状态可诊断
- `requirements.md` 需求 2：ACP 会话主链路
- `requirements.md` 需求 3：实时消息与运行状态
- `requirements.md` 需求 4：权限和工具边界明确
- `requirements.md` 需求 5：历史、绑定和数据隔离
- `requirements.md` 需求 6：能力矩阵和配置选项准确
- `requirements.md` 需求 7：故障隔离与安全回收

### 1.3 技术约束

- 后端：CodingNS Host、Fastify、`packages/session-sync-core`、现有 Provider/Runtime 服务。
- 外部运行时：Grok Build 官方预编译 CLI；不依赖 Grok 内部 Rust crate。
- 通信：ACP JSON-RPC 2.0 over stdio；stdout 只承载协议，stderr 只承载诊断。
- 会话：首版以 Grok `sessionId` 为外部权威 ID，CodingNS 只保存绑定和展示投影。
- 配置：命令通过 `CODINGNS_GROK_COMMAND`，运行目录通过 `CODINGNS_GROK_HOME` 或现有会话运行时配置传入；自定义 xAI 兼容接口通过 `CODINGNS_GROK_BASE_URL` 传入，并由 Runtime 显式追加 `--xai-api-base-url`，不依赖 Grok CLI 是否自动读取同名环境变量。
- 后台任务：不新增私有 timer、inflight Map 或重试队列；只使用现有 `ProviderRuntimeService` 和 `TaskManager` 规则。
- 安全：未实现权限桥接前，首版使用 `--always-approve` 仅作为受控本机 MVP，并在能力矩阵中关闭 CodingNS 权限能力。

## 2. 架构

### 2.1 系统结构

```text
CodingNS 用户请求
        │
        ▼
CodingNS Host（认证、用户隔离、工作区边界、REST/WS）
        │
        ├─ GrokProviderAdapter
        │    ├─ GrokSessionStoreReader（绑定会话的 summary/updates 读取）
        │    └─ GrokMessageMapper
        │
        ├─ GrokRuntimeAdapter
        │    └─ GrokAcpClient（stdio JSON-RPC 多路复用）
        │
        ├─ ProviderCatalog / RuntimeState
        ├─ SessionHistoryService / SessionLiveRuntimeService
        └─ ProviderRuntimeService
        │
        ▼
grok agent --no-leader --always-approve stdio
```

Grok 在 CodingNS 中以 `grok` Provider 路由出现。这个名称表示外部 Agent Runtime，不代表 CodingNS 直接调用某个 xAI 模型 API。Grok 自己负责 Agent、文件、终端和 MCP 工具；CodingNS 负责用户、工作区、会话绑定和对外界面。

### 2.2 模块职责

| 模块 | 职责 | 输入 | 输出 |
| --- | --- | --- | --- |
| `GrokAcpClient` | 管理子进程、JSON-RPC id、响应、通知和服务端请求 | ACP 方法、参数 | Promise 结果、推送事件 |
| `GrokRuntimeAdapter` | 实现实时启动、加载、提示词、完成、中断和进程回收 | `ProviderRuntimeRunRequest` | `RuntimeEvent`、绑定信息 |
| `GrokProviderAdapter` | 实现发现、历史、标题、发送、恢复和能力声明 | CodingNS binding、Grok 会话文件 | `ProviderSessionSummary`、`HistoryPage` |
| `GrokSessionStoreReader` | 读取已绑定会话的 `summary.json`、`updates.jsonl` 等 | `GROK_HOME`、session id | 受控历史记录和统计 |
| `GrokMessageMapper` | 将 ACP update 或持久化 update 映射为标准消息 | ACP update、序号 | `NormalizedMessage` |
| `GrokCapabilityMapper` | 根据握手、配置选项和验证矩阵生成能力快照 | 协议版本、能力集合 | `ProviderCapabilities` |
| Provider 注册层 | 将 Grok 接入目录、发现和运行时列表 | Host 配置 | 可选 Provider |
| 权限边界 | 首版明确 always-approve；后续映射 ACP 权限请求 | ACP server request | 拒绝、权限事件或 CodingNS 回复 |

### 2.3 关键流程

#### 2.3.1 启动并发送首条消息

1. CodingNS 通过现有 `start-live` 入口校验用户、workspace 和 Provider 能力。
2. `GrokRuntimeAdapter` 使用配置的命令启动 `grok agent --no-leader --always-approve stdio`。
3. `GrokAcpClient` 建立 stdout 行读取和 stdin 写入，发送 `initialize`，只声明已经实现的 client capabilities。
4. 发送 `session/new`，传入规范化 `cwd`、空 MCP 列表和可选 `_meta.yoloMode`。
5. 从响应保存 `sessionId`，并读取 `configOptions` 中的模型和 reasoning effort。
6. 发送 `session/prompt`，把 CodingNS 文本转换为 ACP text content。
7. 将 `session/update` 通知送入现有 runtime sink；收到最终 result 后只发出一次完成事件。
8. 将会话绑定写回 CodingNS，使用受控 `grok://session/...` 作为 `rawStoreRef`，不把认证路径或任意本机路径暴露给客户端。

#### 2.3.2 恢复已有会话

1. CodingNS 根据已有绑定取得 Grok session id 和工作区。
2. 启动新的本地 ACP 进程，完成 `initialize`。
3. 调用 `session/load`，传入原工作区和空 MCP 列表。
4. 校验返回的 session id、工作区和配置选项；失败时保留原绑定并返回恢复错误。
5. 发送新的 `session/prompt`，继续现有 Grok 会话。

首版不维持跨请求的全局 Grok daemon。每次 active run 使用自己的 ACP 子进程，运行完成后关闭；后续继续会话通过 `session/load` 恢复。这与现有 `ProviderRuntimeService` 的 active run 生命周期一致，也避免多个 CodingNS 会话共享未审计的进程状态。

#### 2.3.3 ACP 双向消息处理

`GrokAcpClient` 必须同时处理三类行：

1. `id` 与待处理请求匹配的 JSON-RPC response。
2. 没有 `id` 的 `session/update` 或其他 notification。
3. 带 `id`、由 Grok 发起的 server request，例如权限、文件或终端请求。

不能使用“一次写入后只等待下一行”的实现。未知 notification 记录受控诊断后跳过；未知 server request 必须返回明确的 JSON-RPC 错误，不能让 Grok 永久等待。

#### 2.3.4 进程退出和中断

1. 用户中断时，优先发送 ACP 取消请求（具体方法名以锁定版本的 ACP 契约测试为准）。
2. 取消请求超时或进程失联时，调用 Node 子进程终止流程，并等待 `close` 事件。
3. `stderr` 只进入结构化诊断日志；任何非 JSON stdout 行都标记为协议错误。
4. 完成、失败、中断三类结果必须互斥；迟到的 update 不能重新打开已结束运行。

## 3. 组件和接口

### 3.1 核心组件

覆盖需求：1、2、3、4、5、6、7

- `GrokAcpClient`：负责 stdio、JSON-RPC 多路复用和关闭。
- `GrokRuntimeAdapter`：实现 `ProviderRuntimeAdapter` 的 start/continue。
- `GrokProviderAdapter`：实现 `ProviderAdapter` 的历史和会话能力。
- `GrokMessageMapper`：保持 ACP update 到标准消息的稳定映射。
- `GrokCapabilityMapper`：把握手能力和配置选项转换为能力矩阵。
- `GrokSessionStoreReader`：只读取已绑定的 Grok 本地会话存储。

### 3.2 数据结构

#### 3.2.1 `GrokSessionBinding`

优先复用现有 CodingNS session binding 字段，不新增第二份会话主表。

| 字段 | 类型 | 必填 | 说明 | 约束 |
| --- | --- | --- | --- | --- |
| `sessionId` | `string` | 是 | CodingNS 会话 id | 唯一 |
| `provider` | `"grok"` | 是 | 固定 Provider ID | 不允许写成模型名 |
| `providerSessionId` | `string` | 是 | Grok ACP session id | 来自 `session/new/load` |
| `workspaceId` | `string` | 是 | CodingNS 工作区 | 每次请求校验 |
| `rawStoreRef` | `string` | 是 | `grok://session/<provider-session-id>` | 不包含 cwd、认证文件路径或任意用户输入路径 |
| `runtimeHomeDir` | `string \| null` | 否 | 受控 `GROK_HOME` | 必须为用户私有目录 |

这里复用现有 `SessionBinding` 和 `session_bindings` 表中的
`sessionId`、`provider`、`providerSessionId`、`workspaceId`、`rawStoreRef`、
`runtimeHomeDir`、`userId` 字段，不新增 Grok 专用会话主表，也不新增重复的
`runtime_home_dir` 列。`rawStoreRef` 只用于标识外部会话；工作区路径和用户边界
始终从 CodingNS binding/runtime request 取得，不能从 URI 反推权限。

#### 3.2.2 `GrokAcpRequestState`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `requestId` | `string \| number` | JSON-RPC 请求 id |
| `method` | `string` | 请求方法 |
| `createdAt` | `string` | 超时和诊断时间 |
| `resolve/reject` | 内部回调 | 仅保存在进程内，不持久化 |

#### 3.2.3 `GrokCapabilitySnapshot`

| CodingNS 能力 | 首版值 | 说明 |
| --- | --- | --- |
| `canStartSession` | `true` | `session/new` 和 `session/prompt` 契约通过后开启 |
| `canResumeSession` | `true` | 只针对已绑定 session 使用 `session/load` |
| `canSendMessage` | `true` | `session/prompt` 可用 |
| `inRunInputMode` | `none` | 首版不承诺运行中追加消息 |
| `supportsInterrupt` | 按实测 | ACP 取消请求和进程回收测试通过后开启 |
| `supportsStructuredToolCalls` | 按握手和契约测试 | 只有稳定配对 `tool_call`/`tool_call_update` 后才开启 |
| `supportsTokenUsage` | `false` | 未完成稳定字段和累计语义验证前关闭 |
| `supportsAttachments` | `false` | 首版不实现 prompt file/image parts |
| `supportsPermissionPrompt` | `false` | always-approve 不是 CodingNS 权限桥接 |
| `supportsPermissionRequests` | `false` | 完成 ACP 权限映射后再开启 |
| `supportsSessionFork` | `false` | 先验证 `x.ai/session/fork` 的稳定契约 |
| `supportsSessionDelete` | `true` | 删除 Grok 本地单个会话目录，再由宿主清理绑定和索引 |
| `supportsSessionShare` | `false` | 无 CodingNS 对应能力 |
| `supportsAsyncPrompt` | `true` | prompt 结果由 update 流返回 |

`runtimeVersion` 仅用于诊断；`protocolVersion`、初始化结果中的能力和已验证方法集合才是能力判断依据。`ProviderCapabilities.runtimeStatus` 只允许
`ready`、`degraded`、`read-only`。命令未安装、认证失败、版本读取失败属于
Provider runtime/install 诊断状态，不能伪装成 `runtimeStatus` 的新枚举；它们通过
Host 的安装状态、错误码和 `limitations` 返回。未知协议保留 Provider，但写操作
进入 `degraded` 或 `read-only`。

### 3.3 接口契约

#### 3.3.1 `GrokAcpClient.request`

- 类型：内部 Function / JSON-RPC
- 输入：`method`、`params`、可选超时和 `AbortSignal`
- 输出：匹配 request id 的 `result` 或分类错误
- 校验：JSON-RPC 版本、id、result/error 二选一；stdout 每行必须是完整 JSON。
- 错误：`GROK_PROCESS_UNAVAILABLE`、`GROK_ACP_PROTOCOL_ERROR`、`GROK_ACP_TIMEOUT`、`GROK_ACP_REMOTE_ERROR`。

#### 3.3.2 `GrokAcpClient.onMessage`

- 类型：内部 Event
- 输入：一行 JSON-RPC message
- 输出：response resolve、notification callback 或 server request callback
- 校验：未知方法不得阻塞队列；server request 必须在有界时间内回复。

#### 3.3.3 `ProviderRuntimeAdapter.startSession`

- 类型：现有 `ProviderRuntimeAdapter`
- 输入：`ProviderRuntimeRunRequest`，包括 workspace、runtime home、模型、reasoning level 和首条内容。
- 输出：`ProviderRuntimeLaunchResult`，包含 Grok session id、raw store ref、完成 Promise、中断函数和存活探针。
- 校验：workspace 必须来自 CodingNS binding；不能接受请求体任意 cwd。
- 错误：命令不存在、认证失败、握手失败、session/new 失败、prompt 失败。

#### 3.3.4 `ProviderAdapter.readSessionHistory`

- 类型：现有 `ProviderAdapter`
- 输入：Grok session id、受控 raw store ref、cursor、limit、direction。
- 输出：`HistoryPage`，消息带稳定 raw ref 和序号。
- 校验：只允许访问已绑定且 workspace 匹配的会话；无可靠历史时返回明确空/失败，不伪造消息。
- 错误：会话不存在、GROK_HOME 不可读、updates 格式未知、历史解析失败。

`GrokProviderAdapter` 必须实现 `ProviderAdapter` 要求的全部方法：发现只返回
CodingNS 已绑定且 workspace 匹配的会话；历史读取、订阅、恢复、启动、发送消息、
标题读取、标题重命名、归档和能力查询都要有明确行为。首版不支持的 Fork、
分享、附件、Token Usage 或权限桥接必须返回明确的 `GROK_CAPABILITY_UNSUPPORTED`
或对应错误，不能留空或伪造成功。

#### 3.3.5 能力配置选项

- ACP `session/new`/`session/load` 返回的 `configOptions` 映射到 `ProviderModelOption[]` 和 reasoning effort 选项。
- 改变选项时使用 `session/set_config_option`，只传入已经由握手声明的 `configId`。
- 不把 Grok 应用版本中的模型菜单硬编码到 CodingNS；无法读取时只保留 Provider 默认配置。

## 4. 数据与状态模型

### 4.1 数据关系

```text
User 1 ── * Workspace
Workspace 1 ── * CodingNS Session
CodingNS Session 1 ── 1 Grok Session
Grok Session 1 ── * ACP Update
```

CodingNS session binding 是访问控制入口；Grok session 是 Agent 执行和原始会话持久化的权威源；CodingNS history/runtime 是产品投影。任何一方异常都不能悄悄删除另一方的绑定。

### 4.2 状态流转

#### 4.2.1 Provider 运行时状态

| 状态 | 含义 | 进入条件 | 退出条件 |
| --- | --- | --- | --- |
| `missing` | 找不到 grok 命令 | CLI 探测失败 | 安装并刷新 |
| `unauthenticated` | 命令存在但无法完成认证 | initialize/session/new 返回认证错误 | 用户登录或提供 API Key |
| `ready` | 命令、认证和基础 ACP 能力可用 | 握手与基础契约通过 | 进程/协议失败 |
| `degraded` | 可安全读取部分能力，写能力有限 | 未知扩展、部分能力缺失 | 重新握手验证 |
| `read-only` | 只能保留目录和绑定诊断 | 协议无法验证或历史仍可读取 | 协议恢复 |

#### 4.2.2 运行状态

| 状态 | 含义 | 进入条件 | 退出条件 |
| --- | --- | --- | --- |
| `starting` | 子进程与 ACP 初始化中 | spawn 成功 | session/new/load 成功或失败 |
| `running` | prompt 正在执行 | 发送 session/prompt | complete、interrupt、error |
| `completed` | 本轮正常结束 | 收到最终 prompt result | 下一轮新运行 |
| `interrupted` | 用户中断或进程被回收 | cancel 成功或回收完成 | 下一轮新运行 |
| `failed` | 认证、协议、进程或 Agent 错误 | 分类错误出现 | 明确恢复或新运行 |

### 4.3 事件转换

| ACP update | CodingNS 结果 | 规则 |
| --- | --- | --- |
| `agent_message_chunk` | assistant `text` | 按 session、turn 和 update 标识合并 |
| `agent_thought_chunk` | assistant `thinking` | 不混入正式文本 |
| `tool_call` | tool_call running | call id 必须稳定 |
| `tool_call_update` | tool_result/completed/failed | 按 call id 配对 |
| `plan` | 计划或诊断消息 | 只有已有标准模型能表达时才展示 |
| prompt result | `complete` | 一轮只能产生一次终态 |
| JSON-RPC error/process close | `error` | 保留分类 errorCode，不伪造完成 |
| 未知 update | raw diagnostic | 跳过未知事件，不当普通文本 |

### 4.4 历史存储策略

Grok 官方文档记录会话位于 `$GROK_HOME/sessions/<encoded-cwd>/<session-id>/`，包含 `summary.json`、`updates.jsonl`、`chat_history.jsonl` 等文件。首版只解析已绑定会话，并将文件格式视为可变实现细节：

- 不扫描全局目录并自动导入陌生会话；
- 不把 Grok 原始 JSONL 全量复制到 CodingNS SQLite；
- `updates.jsonl` 无法解析时保留绑定和诊断，不能把空历史当成会话不存在；
- `rawStoreRef` 使用受控 URI，解析器内部再映射到当前 `GROK_HOME`。

## 5. 错误处理

### 5.1 错误类型

- `GROK_COMMAND_NOT_FOUND`：命令路径不可用。
- `GROK_AUTH_REQUIRED`：OAuth/API Key 不可用或过期。
- `GROK_PROCESS_START_FAILED`：子进程无法启动。
- `GROK_PROCESS_EXITED`：运行中进程异常退出。
- `GROK_ACP_PROTOCOL_ERROR`：JSON-RPC、id、stdout 或 update 格式不合法。
- `GROK_ACP_TIMEOUT`：请求或取消操作超过有界时间。
- `GROK_ACP_REMOTE_ERROR`：Grok 返回 JSON-RPC error。
- `GROK_CAPABILITY_UNSUPPORTED`：能力未在握手或验证矩阵中开启。
- `GROK_SESSION_NOT_FOUND`：绑定的 Grok session 不存在或无法加载。
- `GROK_WORKSPACE_FORBIDDEN`：workspace、cwd 或用户边界校验失败。
- `GROK_PERMISSION_BRIDGE_UNAVAILABLE`：Grok 请求权限但 CodingNS 尚未实现对应回复。

### 5.2 处理策略

1. 输入和工作区错误：在启动子进程前拒绝。
2. 命令/认证错误：只将 Grok Provider 标记不可用，不影响其他 Provider。
3. ACP 协议错误：终止当前运行，保留 request method、session id 和受控诊断。
4. 外部更新未知：跳过未知事件；若影响写能力则进入 degraded/read-only。
5. 权限请求未桥接：有界返回 JSON-RPC 错误，并将 CodingNS 运行标记失败，不能无限挂起。
6. 进程回收：先取消、后终止、最后确认 close；不杀同一用户手工启动的其他 `grok` 进程。

## 6. 正确性属性

### 6.1 属性 1：请求响应唯一匹配

*对于任何* ACP 请求，系统都应该只用相同 JSON-RPC id 的 response 结束该请求，迟到或未知 id 的 response 不得改变其他请求状态。

**验证需求：** 需求 2、需求 3、需求 7

### 6.2 属性 2：终态互斥

*对于任何* CodingNS active run，`complete`、`interrupted` 和 `error` 至多有一个终态；终态发出后迟到 update 不得重新打开运行。

**验证需求：** 需求 3、需求 7

### 6.3 属性 3：权限边界不下沉

*对于任何* Grok 会话，工作区路径、用户绑定和 runtime home 都必须来自 CodingNS 受控配置；`--always-approve` 不得被描述为 CodingNS 权限审批。

**验证需求：** 需求 4、需求 5

### 6.4 属性 4：未知能力不伪造成功

*对于任何* 未由握手或契约测试证明的 Grok 能力，CodingNS 都应该返回关闭状态或明确不支持错误，而不是记录成功。

**验证需求：** 需求 1、需求 6

### 6.5 属性 5：外部故障隔离

*对于任何* Grok 子进程、认证或协议故障，CodingNS 其他 Provider 的会话创建、读取和运行都应该继续可用。

**验证需求：** 需求 7

## 7. 测试策略

### 7.1 单元测试

- JSON-RPC request/response/notification/server-request 多路复用。
- stdout 非 JSON、stderr 隔离、request id 不匹配和超时。
- ACP update 到 `NormalizedMessage` 的映射和工具 call id 配对。
- 能力矩阵、configOptions 和未知协议降级。
- `rawStoreRef` 解析、GROK_HOME 路径边界和 session binding。
- 进程启动、取消、退出和终态互斥。

### 7.2 集成测试

- 使用 fake ACP stdio server 验证 initialize、session/new、session/load、session/prompt、update 和 cancel。
- 验证 response 与 notification 交错、server request 未桥接和未知 update。
- 验证 Provider Catalog、Runtime State、SessionHistoryService 和 SessionLiveRuntimeService 注册完整。
- 验证 Grok 不可用时其他 Provider 仍可用。

### 7.3 端到端测试

- 在隔离临时工作区使用锁定版本 Grok，完成创建、文本流、工具事件、恢复和中断。
- macOS/Linux/Windows 分别验证命令发现、工作目录、stderr、退出码和进程回收。
- 使用真实认证只验证登录状态、握手、session/new/load 和最小 prompt；不把真实模型回答当作协议兼容证明。

### 7.4 验证映射

| 需求 | 设计章节 | 验证方式 |
| --- | --- | --- |
| `requirements.md` 需求 1 | `design.md` §2.2、§4.2、§5 | 命令探测、握手降级和日志脱敏测试 |
| `requirements.md` 需求 2 | `design.md` §2.3.1、§2.3.2、§3.3 | fake ACP 主链路和恢复测试 |
| `requirements.md` 需求 3 | `design.md` §2.3.3、§4.3、§6.2 | 交错消息、重复 update、终态测试 |
| `requirements.md` 需求 4 | `design.md` §2.3.3、§3.2.3、§5.2 | 权限未桥接拒绝和能力关闭测试 |
| `requirements.md` 需求 5 | `design.md` §3.2.1、§4.4 | workspace、GROK_HOME、绑定和历史测试 |
| `requirements.md` 需求 6 | `design.md` §3.2.3、§3.3.5 | capability/configOptions 测试 |
| `requirements.md` 需求 7 | `design.md` §2.3.4、§5.2、§6.5 | 进程回收、故障隔离和跨平台测试 |

## 8. 风险与待确认项

### 8.1 风险

- Grok Build 仓库会从 SpaceXAI monorepo 定期同步，ACP `x.ai/*` 扩展可能变化。
- `--always-approve` 绕过 CodingNS 逐次审批，若没有 sandbox/deny 规则，Grok 可能执行超出用户预期的文件和终端操作。
- Grok 本地会话文件是实现细节，不应被当成长期稳定公共 API。
- Windows 预编译可用，但源码构建和子进程信号行为需要单独验证。
- Grok 的 OAuth/API Key 认证生命周期独立于 CodingNS，Provider 安装状态不能代替认证状态。

### 8.2 待确认项

- 生产环境是否允许首版使用 `--always-approve`，还是必须先完成 CodingNS 权限桥接。
- `GROK_HOME` 是使用用户共享目录，还是为每个用户配置独立目录。
- 首版是否需要把已绑定 Grok session 的历史纳入工作区发现，还是只支持从 CodingNS 新建的绑定。
- Grok ACP 取消请求的最终方法名、权限请求字段和 fs/terminal server-request 具体契约。
- Grok 二进制由安装脚本管理，还是由用户手工安装后仅做路径探测。

### 本地会话删除实现

宿主将 Grok 删除请求交给已注册的 GrokAdapter，复用现有运行状态检查和数据库清理流程。适配器沿用历史读取的目录定位方式，校验真实路径位于 sessions 根目录之下且不是根目录本身，再异步删除整个会话目录。目录未找到统一返回 PROVIDER_SESSION_NOT_FOUND，让宿主清理残留索引；其他错误继续上抛。

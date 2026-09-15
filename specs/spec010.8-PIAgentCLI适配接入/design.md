# 设计文档 - spec010.8 Pi Agent CLI 适配接入

状态：Draft

## 1. 概述

### 1.1 目标

- 把 Pi Agent 接进现有 ProviderRuntimeAdapter 和 ProviderAdapter。
- 用 Pi 官方 RPC 承担实时运行，用 Pi session JSONL 承担发现和历史读取。
- 让 Pi 的交互 UI 请求进入 CodingNS 权限/问题交互链路。
- 明确 Pi 与 DSH 的能力差异，避免向前端暴露无法兑现的能力。

### 1.2 主路线

第一阶段只把 RPC CLI 作为主运行路线：

```text
CodingNS Host
  -> spawn pi --mode rpc
  -> stdin: strict JSONL commands
  <- stdout: responses/events/extension_ui_request
  <- stderr: diagnostics
```

SDK 作为后续优化选项，不作为第一阶段主链路。原因是当前项目已经按外部 CLI 进程管理 Claude、Codex、Gemini、Kimi 和 Command Code；直接嵌入 SDK 会把 Pi 的模型运行时、扩展生命周期和 Host 生命周期绑在一起，复杂度更高。

### 1.3 覆盖需求

- `requirements.md` 需求 1-12 全部覆盖。
- 会话扫描属于后台重 I/O，执行必须遵守 `specs/spec001.2-后端任务调度与主线程压力治理/20260412-后台任务接入规范.md`。

## 2. 架构

### 2.1 模块组成

| 模块 | 职责 | 输入 | 输出 |
| --- | --- | --- | --- |
| `PiRuntimeAdapter` | 启动 Pi、发送 RPC、管理运行生命周期 | `ProviderRuntimeRunRequest` | 统一 runtime 事件和 launch result |
| `PiRpcClient` | 严格 JSONL、请求 id、响应和 UI 请求管理 | stdin/stdout | typed response/event |
| `PiEventNormalizer` | 合并增量消息、工具事件和终态 | Pi RPC event | `NormalizedMessage`/`RuntimeEventInput` |
| `PiSessionAdapter` | 会话发现、历史、标题、Fork、删除 | Pi JSONL 和 RPC | `ProviderAdapter` 结果 |
| `PiSessionJsonlReader` | 文件指纹、游标、尾行和树结构解析 | session JSONL | 分页/增量消息 |
| `PiExtensionUiBridge` | UI 请求和权限/问题事件互转 | `extension_ui_request` | CodingNS interaction + response |
| `PiCapabilityMapper` | 根据固定扩展和运行配置输出能力 | Pi 启动选项/版本 | `ProviderCapabilities` |
| `PiProviderConfig` | CLI 路径、agent dir、session dir、扩展白名单 | HostConfig | 安全启动参数 |

### 2.2 Host 注册位置

运行时适配器注册到：

- `apps/host/src/modules/sessions/session-live-runtime-service.ts` 的 provider runtime factory。

核心包导出到：

- `packages/session-sync-core/src/runtime/pi-runtime.ts`
- `packages/session-sync-core/src/providers/pi.ts`
- `packages/session-sync-core/src/index.ts`

Host Provider catalog、session history service、capability snapshot 和前端 provider catalog 必须复用现有公共路径，不新增 Pi 专属主流程分支。

## 3. 启动与运行流程

### 3.1 新建会话

1. Host 根据 workspace 生成隔离的 `PI_CODING_AGENT_DIR` 和 session-dir。
2. Host 启动 `pi --mode rpc --session-dir <dir>`，附加 provider/model、Plan 扩展和安全扩展参数。
3. Pi 进程启动后发送 `get_state`。
4. 读取 `sessionId` 和 `sessionFile`，调用 `sink.updateSessionBinding`。
5. 发送 `prompt`，只把 response `success: true` 视为 accepted。
6. 持续消费事件，直到 `agent_settled`、abort、进程退出或协议错误。

### 3.2 继续会话

优先使用已保存的 `rawStoreRef` session 文件：

```text
pi --mode rpc --session <rawStoreRef> --session-dir <dir>
```

如果物理 session 文件不存在但仍能通过 session id 定位，则使用 `--session <id>` 或先从 session-dir 解析出唯一文件。无法确认唯一文件时必须失败，不能打开错误会话。

继续会话不等于恢复正在执行的 turn。Host 重启后只能恢复已落盘历史，不能宣称接管原进程中的网络请求或工具执行。

### 3.3 运行中输入

| CodingNS 行为 | Pi RPC |
| --- | --- |
| steer | `steer` 或 prompt + `streamingBehavior: "steer"` |
| follow-up | `follow_up` 或 prompt + `streamingBehavior: "followUp"` |
| 清空队列 | `clear_queue` |
| 中断 | `abort` |

适配器必须为每个请求维护 response id，但不能用 response 的返回时刻推断 turn 已完成。

## 4. 事件归一化

### 4.1 终态规则

| Pi 事件 | CodingNS 处理 |
| --- | --- |
| `agent_start`/`turn_start` | running |
| `message_start` | 创建暂存消息轨道 |
| `message_update` | 合并 text/thinking/toolcall 增量 |
| `message_end` | 以完整消息覆盖暂存内容 |
| `tool_execution_start` | tool_call running |
| `tool_execution_update` | 更新工具输出 |
| `tool_execution_end` | tool_result completed/failed |
| `agent_end` | `willRetry=false` 时发 `status: completed`（表示这一轮真的跑完了），`willRetry=true` 时保持 running |
| `agent_settled` | 真正的终态：发 complete 并回收进程 |
| `extension_error` | 记录错误并按是否仍运行决定是否终止 |

**为什么 `agent_end` 也要收敛状态**：Pi 转发 `agent_settled` 的顺序是「先 `await` 扩展的 `agent_settled` handler，再发给 RPC 客户端」，而计划模式这类扩展正好在这个 handler 里等用户点审批。如果只在 `agent_settled` 时才结束，会话会一直显示"进行中"。所以 `agent_end` 且不会自动重试时先把状态收敛；进程仍然留着，等审批回包、`agent_settled` 到达后才关闭，并只在此时兑现 `completed` promise。

### 4.2 消息身份

增量消息按 `(sessionId, message index/contentIndex, message start)` 维护稳定身份。最终 `message_end.message` 是权威快照；不能把每个 delta 当成一条新消息。

工具调用必须保留：

- call id
- tool name
- 参数 JSON
- 当前输出
- running/completed/failed
- 原始事件行号或事件序号

## 5. 会话文件与增量解析

### 5.1 物理隔离

每个 workspace/session 使用：

- `PI_CODING_AGENT_DIR=<workspace runtime>/pi-agent`
- `PI_CODING_AGENT_SESSION_DIR=<workspace runtime>/pi-agent/sessions`

运行时环境必须同时设置 `HOME`/平台等价变量的兼容值，避免 Pi 读取用户全局配置。最终使用哪个环境变量由实现任务根据 Pi 版本 fixture 固定。

### 5.2 JSONL 解析规则

解析器需要识别：

- `type: "session"`：session id、cwd、version
- `type: "message"`：user、assistant、toolResult、bashExecution 等消息
- `id`/`parentId`：构建当前活动树
- 未知 entry：保留 raw，不阻断已知消息

解析器必须记录：

- 文件 identity（dev/ino 或平台等价值）
- size/mtime
- 已消费字节偏移
- 下一条逻辑序号
- 不完整尾行缓存

### 5.3 后台扫描

会话扫描、工作区批量发现和大文件增量读取必须接入统一 `TaskManager`，推荐 `helper_process` lane。watcher 只标记 dirty，不直接在 watcher 回调中读取整份 JSONL。禁止新建 Pi 私有 timer、inflight 或重试队列。

## 6. 会话操作

### 6.1 Fork/Clone

- 用户消息 Fork：通过 `get_fork_messages`/`get_entries` 找到 Pi entry id，再发送 `fork`。
- 当前分支 Clone：发送 `clone`。
- 成功后读取新 `get_state`，更新 provider session binding。
- 原 CodingNS session 不被覆盖，新 session 记录 parentProviderSessionId。

如果 CodingNS 的消息 id 不是 Pi entry id，必须保存可逆映射；找不到映射时返回 `PI_FORK_SOURCE_NOT_FOUND`。

### 6.2 重命名

发送 `set_session_name`，成功后更新 CodingNS 标题。Pi 没有原生标题时使用首条用户消息作为回退，但不写入不属于 Pi 的伪标题事件。

### 6.3 删除与归档

- 删除前先 abort/stop 活跃进程。
- 只允许删除配置的 Pi session 根目录内文件。
- 删除操作写入 CodingNS 审计日志，并清理 session index/cache。
- 归档使用 CodingNS 元数据标记；Pi 物理文件保留，除非明确执行删除。
- `supportsSessionDelete` 可为 true，但 `supportsSessionArchive` 若没有现有字段则通过 limitations 说明，不伪造 Pi 原生 archive。

## 7. 附件、权限和 Plan

### 7.1 图片附件

图片读取后转换成 Pi RPC 的：

```json
{
  "type": "image",
  "data": "base64",
  "mimeType": "image/png"
}
```

大小、MIME、路径边界在 Host 侧先校验。

### 7.2 文件附件

普通文件使用两种受控协议之一：

1. 小文本文件：读取并附加带文件名和路径标签的文本块。
2. 大文件/二进制文件：只传工作区内相对路径，并在 prompt 中明确告诉 Pi 使用 read 工具读取。

禁止把任意绝对路径、附件临时目录真实结构或其他用户文件暴露给 Pi。

### 7.3 扩展 UI 到 CodingNS

Pi 输出 `extension_ui_request` 后：

1. `select/confirm/input/editor` 转成 CodingNS interaction request。
2. Host 保存 `(sessionId, piRequestId)` 映射。
3. 前端提交结果后，Host 回写同一个 Pi request id。
4. Pi 进程结束、超时或 abort 时清理映射。

`ctx.ui.custom()` 在 RPC 模式不可用，因此 question 工具必须提供一个只调用 `ctx.ui.select/confirm/input/editor` 的 RPC 版本。

### 7.4 Plan Mode

Plan Mode 作为版本固定的可信扩展加载，不把示例目录动态暴露给任意项目。Host 需要：

- 在能力探测时确认扩展可加载
- 将 plan 的 select 审批显示为等待用户交互
- 把 Execute/Stay/Refine 的选择回传
- 继续处理扩展发送的 follow-up 和 custom message
- 扩展不可用时关闭 Plan 入口

## 8. 能力矩阵

第一阶段建议：

```ts
{
  canStartSession: true,
  canResumeSession: true,
  canSendMessage: true,
  inRunInputMode: "queued_guidance",
  supportsSubagents: false,
  supportsInterrupt: true,
  supportsStructuredToolCalls: true,
  supportsTokenUsage: true,
  supportsAttachments: true, // 图片和受控文件协议，不代表原生 file block
  supportsPermissionPrompt: "partial",
  supportsPermissionRequests: true, // 仅扩展 UI 桥接完成后
  supportsCheckpoint: false,
  supportsSessionFork: true,
  supportsSessionDelete: true,
  supportsSessionShare: false,
  supportsAsyncPrompt: true,
  supportsNativeAgents: false
}
```

`supportsPermissionPrompt` 当前类型是 boolean，若公共类型不能表达 partial，第一阶段使用 `false + limitations`，等交互协议有稳定映射后再开放 true。

## 9. 错误处理

统一错误前缀建议使用 `PI_`：

- `PI_CLI_NOT_FOUND`
- `PI_RPC_PROTOCOL_ERROR`
- `PI_RPC_RESPONSE_TIMEOUT`
- `PI_PROMPT_REJECTED`
- `PI_AGENT_FAILED`
- `PI_SESSION_NOT_FOUND`
- `PI_SESSION_FILE_OUTSIDE_ROOT`
- `PI_SESSION_JSONL_PARTIAL`
- `PI_FORK_SOURCE_NOT_FOUND`
- `PI_EXTENSION_UI_TIMEOUT`
- `PI_EXTENSION_NOT_ALLOWED`
- `PI_ATTACHMENT_PATH_FORBIDDEN`
- `PI_ATTACHMENT_TOO_LARGE`
- `PI_ACTIVE_RUN_NOT_RECOVERABLE`

每个错误至少记录 provider、CodingNS session id、Pi session id、rawStoreRef、command/event、错误码和是否可重试。

## 10. 测试策略

### 10.1 不依赖真实模型的测试

- fake Pi RPC executable 或 fixture stdin/stdout
- prompt accepted/rejected
- text/thinking/tool delta 合并
- agent_end 与 agent_settled 区别
- abort、steer、follow-up、clear_queue
- extension UI request/response
- Fork/Clone state rebinding

### 10.2 文件解析测试

- session header 和树结构
- user/assistant/toolResult/bashExecution
- 增量追加
- 不完整尾行
- 文件替换和 cwd 不匹配
- 未知 entry 保留
- 大文件首尾窗口和 helper 扫描

### 10.3 Host/前端测试

- Provider catalog 和 capability snapshot
- Composer/消息时间线/权限交互门控
- Plan 审批等待、执行、取消和扩展缺失
- 图片和文件附件路径校验

真实 Pi CLI 冒烟测试只验证安装版本、RPC 启动和无密钥失败路径；真实模型调用需要显式测试密钥，不作为协议测试的前置条件。

## 11. 风险与待确认项

### 11.1 风险

- Pi session JSONL 是公开可读但仍可能变化的内部格式，必须依靠 fixture 发现变化。
- Pi 扩展拥有进程级权限，扩展来源不受控会绕过 Host 的权限边界。
- Pi 没有 DSH 级别的活动运行恢复，Host 重启可能丢失正在执行的 turn。
- Pi 的基础 usage 与 CodingNS 计费 projection 口径可能不同。

### 11.2 待确认项

- Host 是否允许为每个 workspace 创建独立 Pi agent dir，还是统一由配置层分配。
- Plan Mode 扩展的来源、版本锁定和升级策略。
- 普通文件附件采用内容注入还是路径协议作为默认方案。
- 删除/归档是否需要新增公共 capability 字段，还是复用现有 session archive metadata。

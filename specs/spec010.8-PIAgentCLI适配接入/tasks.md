# 任务清单 - spec010.8 Pi Agent CLI 适配接入（人话版）

状态：DONE

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

- [x] 0.2 定义 Pi Provider 的公共标识和能力边界
  - 状态：DONE
  - 这一步到底做什么：确定 provider id、配置字段、capability 初始值和 DSH 不适用的限制。
  - 做完你能看到什么：Provider catalog 可以区分 Pi、DSH 和其他 CLI，不会误把 subagent/完整权限能力显示给用户。
  - 先依赖什么：0.1
  - 开始前先看：`requirements.md` 需求 1、5、9、10；`design.md` §8。
  - 主要改哪里：`packages/session-sync-core/src/providers/pi-capabilities.ts`（新增）、`packages/session-sync-core/src/index.ts`。
  - 这一步先不做什么：不实现 RPC 进程和历史解析。
  - 怎么算完成：能力矩阵、limitations、runtimeVersion/protocolVersion 语义有明确测试断言。
  - 怎么验证：已执行 `pnpm --dir packages/session-sync-core build` 和 `node --test packages/session-sync-core/tests/pi-capabilities.test.mjs`；5 个用例全部通过（能力矩阵、CLI 缺失降级、扩展缺失关闭入口、模型 id 编解码、思考等级白名单）。
  - 落地结果：
    - Provider id 固定为 `pi`（`PI_PROVIDER_ID`）。
    - 版本基线 `PI_RUNTIME_BASELINE`：包 `@earendil-works/pi-coding-agent`、版本 `0.85.1`、Node `>=22.19.0`、协议 `pi-rpc/0.85.1`、启动模式 `rpc`。
    - `createPiCapabilities()` 输出能力快照；`supportsSubagents`/`supportsNativeAgents`/`supportsCheckpoint`/`supportsSessionShare`/`supportsPermissionPrompt` 全部为 false，`supportsPermissionRequests` 为 true（扩展 UI 桥），`inRunInputMode` 为 `queued_guidance`。
    - DSH 不可等价能力写进 `PI_UNAVAILABLE_DSH_CAPABILITIES`：Remote 重放、Host 重启接管 turn、Agent Preset/subagent、`session/control`、结构化权限范围审批。
    - 模型目录统一编码为 `provider/modelId`，`encodePiModelOptionId`/`decodePiModelOptionId` 只按第一个斜杠切分。
    - 配置字段：CLI 路径、`PI_CODING_AGENT_DIR`/`PI_CODING_AGENT_SESSION_DIR`、受控扩展白名单、question/plan 扩展可用性；运行期选项见 1.2 的 `PiRuntimeOptions`。
  - 对应需求：需求 1、5、9、10
  - 对应设计：§8

### 阶段检查 0.3

- [x] 0.3 阶段检查：基线和公共契约可以执行
  - 状态：DONE
  - 这一步到底做什么：确认版本、命名、能力和范围没有互相矛盾。
  - 做完你能看到什么：可以开始写运行时，不会边写边改 provider 语义。
  - 先依赖什么：0.1、0.2
  - 开始前先看：`requirements.md`、`design.md`、`tasks.md`。
  - 主要改哪里：阶段 0 文档和公共类型。
  - 这一步先不做什么：不扩展 DSH 不具备的 Pi 能力。
  - 怎么算完成：所有已知限制都有 capability 或 limitations 落点。
  - 怎么验证：人工走查 + `git diff --check`（已执行，无空白错误）。
  - 逐项核对结果：
    - DSH Remote 事件重放 → `PI_UNAVAILABLE_DSH_CAPABILITIES` 第 1 条。
    - Host 重启接管运行中 turn → `PI_UNAVAILABLE_DSH_CAPABILITIES` 第 2 条，错误码 `PI_ACTIVE_RUN_NOT_RECOVERABLE`。
    - 原生 Agent Preset/subagent → `supportsSubagents=false`、`supportsNativeAgents=false` + limitations 第 3 条。
    - `session/control` → `inRunInputMode="queued_guidance"` + limitations 第 4 条。
    - 结构化权限范围审批 → `supportsPermissionPrompt=false` + limitations 第 5 条；扩展 UI 只映射为普通交互请求。
    - token usage 口径 → `PI_BASE_LIMITATIONS` 第 1 条；归档语义 → 第 2 条；文件附件协议 → 第 3 条。
  - 对应需求：需求 1、5、12
  - 对应设计：§1、§8、§11

## 阶段 1：实现严格 RPC 运行时

- [x] 1.1 实现 PiRpcClient 和严格 JSONL 读取
  - 状态：DONE
  - 这一步到底做什么：封装 spawn、stdin 命令、stdout LF 分帧、请求 id、response/error 和 stderr 诊断。
  - 做完你能看到什么：Host 可以稳定发送 `get_state`、`prompt`、`abort` 等命令，不会被 Unicode 分隔符或混杂日志破坏。
  - 先依赖什么：0.3
  - 开始前先看：`requirements.md` 需求 2、3、4、11；`design.md` §3、§4。
  - 主要改哪里：`packages/session-sync-core/src/runtime/pi-rpc-client.ts`（新增）、`packages/session-sync-core/src/index.ts`、`packages/session-sync-core/tests/pi-rpc-client.test.mjs`（新增）。
  - 这一步先不做什么：不把事件转换成前端消息，不加载扩展。
  - 怎么算完成：非法 JSON、未知 response、超时、EOF、SIGTERM 和 stderr 都有明确处理。
  - 怎么验证：已执行 `pnpm --dir packages/session-sync-core build` 和 `node --test packages/session-sync-core/tests/pi-rpc-client.test.mjs`；9 个用例全部通过。
  - 落地结果：
    - `PiRpcClient` 只用 `\n` 分帧（额外兜底剥掉 CRLF 的 CR），不把 U+2028/U+2029 当分隔符；用 `StringDecoder` 处理跨 chunk 的多字节 UTF-8。
    - 请求 id 自动分配 `pi-rpc-<n>`；response 按 id 关联，未匹配的 response 只记诊断。
    - 超时 → `PI_RPC_RESPONSE_TIMEOUT`；命令 `success:false` → `PI_RPC_COMMAND_FAILED`（保留原 error 文本）；进程退出 → 全部挂起请求失败为 `PI_RPC_PROCESS_EXITED`。
    - 非法 JSON、非对象行、超过 `maxLineBytes` 的行 → `PI_RPC_PROTOCOL_ERROR` / `PI_RPC_LINE_TOO_LARGE` 诊断，不中断会话。
    - 无桥接时收到 `extension_ui_request` 自动回 `cancelled`，避免扩展永久等待；有桥接时交给监听者用原 id 回包。
    - `stop()` 先关 stdin，等待 `stopGraceMs`，再走统一的 `terminateChildProcess`（SIGTERM→SIGKILL）；stderr 只保留末尾若干字节用于诊断。
    - spawn ENOENT 映射为 `PI_CLI_NOT_FOUND`。
  - 对应需求：需求 2、3、4、11
  - 对应设计：§3、§4、§9

- [x] 1.2 实现 PiRuntimeAdapter 的新建、继续、中断和运行中输入
  - 状态：DONE
  - 这一步到底做什么：实现 `ProviderRuntimeAdapter`，绑定 Pi session id/file，发送 prompt、steer、follow-up、clear_queue 和 abort。
  - 做完你能看到什么：ProviderRuntimeService 能像管理其他 CLI 一样启动和停止 Pi。
  - 先依赖什么：1.1
  - 开始前先看：`packages/session-sync-core/src/runtime/types.ts`、`design.md` §3。
  - 主要改哪里：`packages/session-sync-core/src/runtime/pi-runtime.ts`（新增）、`packages/session-sync-core/src/runtime/pi-attachments.ts`（新增）、`packages/session-sync-core/src/index.ts`、`packages/session-sync-core/tests/pi-runtime.test.mjs`（新增）。
  - 这一步先不做什么：不实现历史发现、Fork、Plan UI。
  - 怎么算完成：accepted、completed、interrupted、failed 四类路径都有稳定 Promise 和事件。
  - 怎么验证：已执行 `pnpm --dir packages/session-sync-core build` 和 `node --test --test-timeout=25000 packages/session-sync-core/tests/pi-runtime.test.mjs`；12 个用例全部通过。
  - 落地结果：
    - 启动参数：`--mode rpc --session-dir <dir> --approve --no-extensions [--extension <受控路径>] [--provider/--model] [--thinking]`；继续会话追加 `--session <文件或 id>`。
    - 环境隔离：`PI_CODING_AGENT_DIR`、`PI_CODING_AGENT_SESSION_DIR` 指向 `runtimeHomeDir/pi-agent` 与 `.../sessions`；默认不覆盖 `HOME`，避免破坏工作区 git/npm/ssh（`isolateHome` 可选开启）。
    - `startSession` 会等 `get_state` 返回并写回绑定后才返回，避免 `pending://` 覆盖真实绑定。
    - prompt response 只当作 accepted；`agent_settled` 才触发 complete 并回收进程。
    - `agent_end` 只发 `PI_TURN_ENDED` / `PI_TURN_ENDED_WILL_RETRY` 状态，不结束运行。
    - prompt 被拒 → `PI_PROMPT_REJECTED`；进程在 settle 前退出 → `PI_AGENT_FAILED`（带退出码和 stderr 尾巴）；CLI 不存在 → `PI_CLI_NOT_FOUND`；session 文件越界 → `PI_SESSION_FILE_OUTSIDE_ROOT`；缺绑定继续会话 → `PI_SESSION_NOT_FOUND`。
    - steer/follow-up：`permissionMode === "steer"` 走 RPC `steer`，其余走 `follow_up`；`clearQueue()` 返回被清掉的 steering/followUp 文本。
    - `abort`：先发 RPC `abort`，等 settle（默认 5s）后回收进程；中止后不再向前端广播事件，终态由 ProviderRuntimeService 统一发 interrupted。
    - `setModel`、`listModels`（复用当前进程）和短生命周期 `listModels`/`probeCli` 探测入口都在适配器上。
  - 对应需求：需求 1、2、4、11
  - 对应设计：§3、§4、§9

- [x] 1.3 实现文本、思考、工具和终态归一化
  - 状态：DONE
  - 这一步到底做什么：把 Pi message/tool 事件转换为 `NormalizedMessage` 和 `RuntimeEventInput`，合并增量并保留 raw ref。
  - 做完你能看到什么：消息时间线能实时显示文本、思考、工具调用和工具结果，且不会重复堆叠 delta。
  - 先依赖什么：1.2
  - 开始前先看：`requirements.md` 需求 3；`design.md` §4；现有 Command Code/Codex runtime normalizer。
  - 主要改哪里：`packages/session-sync-core/src/runtime/pi-event-normalizer.ts`（新增）、`packages/session-sync-core/tests/pi-event-normalizer.test.mjs`（新增）。
  - 这一步先不做什么：不把未知扩展 UI 当成普通文本消息。
  - 怎么算完成：agent_end 不提前终止，agent_settled 才完成；未知事件可追踪。
  - 怎么验证：已执行 `node --test packages/session-sync-core/tests/pi-event-normalizer.test.mjs`；9 个用例全部通过。
  - 落地结果：
    - `message_update` 的 text/thinking 增量按 `(streamEpoch, kind, contentIndex)` 合并到稳定 messageId；`message_end.message` 是权威快照，覆盖但复用同一 messageId。
    - `toolcall_start/delta/end` 合并成一条 tool_call；`tool_execution_start/update/end` 归一化为 running/`tool_result` completed|failed；`tool_execution_end` 与 `message_end.toolResult` 不会重复发结果。
    - `agent_end` 只发状态；`agent_settled` 发 complete 并把 normalizer 标记为终态，终态之后的事件一律丢弃。
    - 未知事件发 `PI_UNKNOWN_EVENT:<type>` 状态，`rawEventRef` 可回溯最近 50 条原始 payload，且不阻断会话。
    - usage 按 assistant 消息累加，缺失字段保持缺失（`reasoningTokens`/`costUsd` 未提供时是 null，不是 0）。
  - 对应需求：需求 3
  - 对应设计：§4

### 阶段检查 1.4

- [x] 1.4 阶段检查：Pi RPC 主运行链路通过 fake fixture
  - 状态：DONE
  - 这一步到底做什么：用 fake Pi 进程跑通新建、prompt、事件、steer、follow-up、abort 和失败。
  - 做完你能看到什么：不需要真实模型密钥就能证明主运行链路没有生命周期漏洞。
  - 先依赖什么：1.1、1.2、1.3
  - 开始前先看：阶段 1 全部代码和测试。
  - 主要改哪里：阶段 1 相关文件。
  - 这一步先不做什么：不接前端，不跑真实模型。
  - 怎么算完成：所有终态只出现一次，stdin/stdout 和挂起 Promise 都能清理。
  - 怎么验证：已执行 `pnpm --dir packages/session-sync-core build` 和
    `node --test --test-timeout=25000 packages/session-sync-core/tests/pi-runtime.test.mjs packages/session-sync-core/tests/pi-capabilities.test.mjs packages/session-sync-core/tests/pi-rpc-client.test.mjs packages/session-sync-core/tests/pi-event-normalizer.test.mjs`；
    4 个文件 35 个用例全部通过，无挂起进程（文件级用例不再超时）。
  - 覆盖清单：新建绑定、继续（含缺绑定失败）、prompt accepted、prompt 拒绝、文本/思考/工具事件、agent_end 与 agent_settled 区别、steer、follow_up、clear_queue、abort、进程异常退出、SIGTERM 回收、扩展 UI 回包、模型列表与参数映射、附件协议。
  - 对应需求：需求 2、3、4、11、12
  - 对应设计：§3、§4、§9、§10

- [x] 1.5 修复：新建会话时把「文件还没落盘」当成错误
  - 状态：DONE
  - 这一段到底做什么：让会话文件还没生成时的读操作返回空结果，而不是报 `PI_SESSION_NOT_FOUND`。
  - 做完你能看到什么：新建 Pi 会话不再弹「Pi 会话文件不存在：…/pi-agent/sessions/….jsonl」，界面正常显示空历史和空用量。
  - 先依赖什么：1.2（会话文件由 Pi 进程创建）
  - 症状：新建会话后立刻报 `PI_SESSION_NOT_FOUND: Pi 会话文件不存在：<dataRoot>/pi-workspaces/<slug>/pi-agent/sessions/<时间戳>_<id>.jsonl`，
    但会话其实建好了、也能正常回复。
  - 根因：走 RPC 运行时新建会话时，会话文件是**懒创建**的 —— 要等第一条消息才落盘（实测从绑定到文件出现大约 35ms）。
    这期间 Host 已经在读历史、读统计、读上下文水位，而 `resolveSessionFilePath` 只判断“文件在不在”：
    当 Host 手里的 PiAdapter 实例还没登记过 session 根目录时，文件不存在就直接抛 notFound。
  - 主要改哪里：`packages/session-sync-core/src/providers/pi.ts`
  - 怎么改：
    - 路径解析拆成两档：`resolveSessionFilePath` 只判断“路径受控”，`requireSessionFile` 额外要求文件真的存在。
    - 新增按 Host 数据目录布局（`<dataRootDir>/pi-workspaces/<slug>/pi-agent/sessions/…`）推导根目录，
      这条路不依赖文件已经存在，也不依赖同一个 Adapter 实例之前登记过根目录。
    - 只读方法（`readSessionHistory`、`readSessionHistoryDelta`、`readSessionStats`、`readContextUsage`、`readSessionTitle`）
      在拿不到路径时返回空历史 / null / 原会话 id；删除、重命名、归档、fork 继续要求文件存在。
  - 这一步先不做什么：不改 Pi 的落盘时机，也不预建一个空文件去骗过检查。
  - 怎么验证：
    - `node --test --test-timeout=60000 packages/session-sync-core/tests/pi-adapter.test.mjs`；
      新增两条用例：未落盘时只读返回空、写操作仍报 notFound，越界路径仍被拒绝。
    - 真实进程复现：起真实 `pi --mode rpc` 新建会话，`existsSync(rawStoreRef) === false`，
      随后 5 个只读调用全部返回空结果、无异常。

## 阶段 2：模型、附件和交互桥

- [x] 2.1 接入模型列表和模型切换
  - 状态：DONE
  - 这一步到底做什么：用 Pi RPC 模型列表填充 provider model options，并实现 set_model。
  - 做完你能看到什么：用户可以查看 Pi 模型并切换，错误不会破坏当前选择。
  - 先依赖什么：1.4
  - 开始前先看：`requirements.md` 需求 5；`design.md` §8。
  - 主要改哪里：`packages/session-sync-core/src/providers/pi-capabilities.ts`、`packages/session-sync-core/src/providers/pi.ts`、`packages/session-sync-core/src/runtime/pi-runtime.ts`、Host provider catalog。
  - 这一步先不做什么：不实现远程 provider discovery，不伪造 DSH provider 列表。
  - 怎么算完成：模型 id/provider/thinking level 的映射有测试。
  - 怎么验证：已执行
    `node --test --test-timeout=25000 packages/session-sync-core/tests/pi-capabilities.test.mjs packages/session-sync-core/tests/pi-runtime.test.mjs`
    和 `pnpm --dir apps/host exec tsc --noEmit -p tsconfig.json`；模型编解码、`--provider/--model/--thinking` 参数映射、`listModels`/`probeCli` 都有断言。
  - 落地结果：
    - 模型 id 统一编码为 `provider/modelId`，只按第一个斜杠切分；不可识别时不传 `--model`。
    - 思考等级只接受 Pi 的 7 档（off/minimal/low/medium/high/xhigh/max），未知值不下发。
    - `PiRuntimeAdapter.listModels()`（复用当前进程）和 `probeCli()`（短生命周期进程）供能力探测。
    - `PiAdapter.getProviderCapabilitiesForWorkspace()` 用真实模型目录补全能力快照，Host 侧已把 `pi` 接进 `enrichProviderCapabilities` 的缓存刷新链路。
  - 补充修复（真实模型列表与思考强度）：
    - 症状：输入框的模型下拉只有“默认”，看不到 Pi 真实模型，也看不到每个模型支持的思考档位。
    - 原因一：读模型目录要起一次 RPC，`getProviderCapabilities`/`getSessionCapabilities` 对 `pi` 只排后台刷新任务，
      第一次请求拿到的必然是空缓存；`claude-code`/`opencode`/`grok` 都是同步等结果的，`pi` 现在改成同一套。
    - 原因二：`parsePiModelCatalog` 只读了 id/name/provider，丢掉了模型自带的 `reasoning` 和 `thinkingLevelMap`，
      前端因此拿不到 `supportedReasoningEfforts`，思维强度选择器没有档位可显示。
    - 现在每个模型都会算出真实支持的档位，规则逐条对齐 Pi 内部的 `getSupportedThinkingLevels(model)`：
      没有 reasoning 的模型只有 `off`；`off`~`high` 只要没被显式映射成 `null` 就算支持；`xhigh`/`max` 必须显式声明。
      这条规则用 Pi 自己的 `get_available_thinking_levels` 交叉验证过（真实目录：flash=`off/low/high/max`，pro=`off/high/max`）。
    - 模型列表第一项保留“跟随 Pi 默认模型”（`provider-default`），并带上默认模型真实支持的档位和 Pi 当前默认档位，
      避免输入框自动选中列表里的第一个模型、悄悄改掉用户的默认行为。
    - 怎么验证：`node --test --test-timeout=90000 packages/session-sync-core/tests/pi-capabilities.test.mjs packages/session-sync-core/tests/pi-runtime.test.mjs`
      和 `pnpm --dir apps/host test tests/integration/pi-model-options.test.ts`；后者锁死“第一次请求就返回真实模型目录和档位”。
    - 真实 CLI 冒烟：除 `node scripts/pi-live-smoke.mjs` 外，本次用真实 `pi` 目录核对过 4 个 deepseek 模型的档位。
  - 对应需求：需求 5
  - 对应设计：§8、§10

- [x] 2.2 实现图片和文件附件协议
  - 状态：DONE
  - 这一步到底做什么：图片转 Pi image content；普通文件按内容注入或受控路径协议发送。
  - 做完你能看到什么：图片可以被 Pi 读取，文件附件不会越权暴露路径，也不会静默丢失。
  - 先依赖什么：1.4
  - 开始前先看：`requirements.md` 需求 6；`design.md` §7.1、§7.2；现有 DSH attachmentRootDir 校验。
  - 主要改哪里：`packages/session-sync-core/src/runtime/pi-attachments.ts`（新增）、`packages/session-sync-core/src/runtime/pi-runtime.ts`、测试。
  - 这一步先不做什么：不把任意外部文件复制到 Pi 全局目录。
  - 怎么算完成：图片大小/MIME/路径边界和大文件回退策略都有测试。
  - 怎么验证：已执行 `node --test --test-timeout=25000 packages/session-sync-core/tests/pi-runtime.test.mjs`；附件用例覆盖 图片 → image content、小文本内联、大文件转路径引用、越界路径直接失败。
  - 落地结果：
    - 图片：校验 MIME（png/jpeg/webp/gif）、大小上限（默认 10MB）、路径边界后转 base64 image content。
    - 普通文件：工作区内且 ≤256KB 的文本内联成带文件名和相对路径的文本块；更大的或二进制文件只发工作区相对路径并提示用 read 工具读取。
    - 路径校验同时比较解析路径和 realpath，`..` 和符号链接都绕不出允许的根目录；越界抛 `PI_ATTACHMENT_PATH_FORBIDDEN`，超限抛 `PI_ATTACHMENT_TOO_LARGE`。
    - 附件校验放在 launch 返回之前，越界附件会让本次发送直接失败，不会先建好会话再异步报错。
  - 对应需求：需求 6
  - 对应设计：§7.1、§7.2、§9

- [x] 2.3 实现扩展 UI 到 CodingNS 交互的桥
  - 状态：DONE
  - 这一步到底做什么：接收 Pi `extension_ui_request`，转成 CodingNS interaction，并按原 id 回写 response。
  - 做完你能看到什么：Pi 扩展的 select/confirm/input/editor 不会卡住进程，前端能显示等待用户交互。
  - 先依赖什么：1.4
  - 开始前先看：`requirements.md` 需求 9；`design.md` §7.3；现有 `session-permission-request-service`。
  - 主要改哪里：`packages/session-sync-core/src/runtime/pi-runtime.ts`（`PiExtensionUiBridge`）、`apps/host/src/modules/sessions/session-permission-request-service.ts`、`apps/host/src/modules/sessions/session-live-runtime-service.ts`。
  - 这一步先不做什么：不把普通 confirm 伪装成带完整文件权限范围的 DSH approval。
  - 怎么算完成：超时、取消、进程退出、重复 response 都有明确行为。
  - 怎么验证：
    - 核心层：`node --test --test-timeout=40000 packages/session-sync-core/tests/pi-runtime.test.mjs`，覆盖按原 id 回传、桥超时回 cancelled、无桥自动 cancelled、以及 agent_settled 之后到来的审批请求（收尾宽限期）。
    - 真实模型：question 扩展触发 select → 桥回答「写代码」→ 模型继续回答「你的选择是：写代码」；Plan 扩展在 settled 之后弹出审批 select，也被正常处理。
    - Host 层：`pnpm --dir apps/host exec tsc --noEmit -p tsconfig.json` 通过。
  - 落地结果：
    - 适配器只在桥存在时转发 select/confirm/input/editor；notify/setStatus/setWidget/setTitle/set_editor_text 按通知处理，不回包。
    - Host 侧 `handlePiExtensionUiRequest` 生成普通交互请求（select/input/editor → user_input，confirm → permissions），用户提交后由 `replyToSessionPermissionRequest` 分支唤醒，回包复用原 request id；超时、Host 收尾都会回 cancelled 并标记状态。
    - 交互等待期间会发 `PI_EXTENSION_UI_PENDING:<method>` 状态，前端据此显示等待中。
  - Host 层用例：`apps/host/tests/integration/pi-extension-ui-bridge.test.ts`（8 个用例）覆盖 select/confirm/input 三种形态、计划审批的专属形态、重复请求复用、Host 收尾回 cancelled、超时回 cancelled、非法动作拒绝。
  - 已验证的限制：select 的选项文案就是回包值，不做二次翻译；前端展示依赖 Host 已有的交互卡片。
  - 本轮新发现并修掉的问题：Pi 扩展可能在 agent_settled 之后才发起审批请求，原来的实现会在 complete 时立刻关进程，导致审批请求永远收不到。现在收尾前有 `settleGraceMs`（默认 1.5s，有挂起交互时继续顺延）。
  - 对应需求：需求 9
  - 对应设计：§7.3、§9

- [x] 2.4 提供 RPC 兼容的 question 工具
  - 状态：DONE
  - 这一步到底做什么：实现只依赖 select/confirm/input/editor 的 Pi 扩展，替代依赖 TUI custom 的 question/questionnaire 示例。
  - 做完你能看到什么：Pi 在 RPC 下可以向用户提问并等待回答，不会返回 UI not available。
  - 先依赖什么：2.3
  - 开始前先看：`requirements.md` 需求 9；上游扩展 UI 协议；`design.md` §7.3。
  - 主要改哪里：`apps/host/pi-extensions/question-rpc/index.ts`（新增）、`apps/host/pi-extensions/README.md`（新增）、Host 扩展白名单配置。
  - 这一步先不做什么：不支持 TUI 专属 custom widget。
  - 怎么算完成：单问题、多选项、取消、超时和自由输入均能回到模型上下文。
  - 怎么验证：
    - 用真实 `pi` 加载扩展（`--mode rpc --no-extensions --extension .../question-rpc/index.ts`），`get_commands` 正常返回、stderr 为空；
    - 探针扩展打印 `pi.getAllTools()` 可见 `question` 已注册；
    - 用 mock ExtensionAPI 驱动行为：固定选项、自由输入、取消 select、取消 input、空输入、`allowFreeform:false`、无 UI 都返回可读文本且不抛异常。
  - 落地结果：工具名 `question`，参数 `question` / `options`（1..8）/ `allowFreeform?`；只调用 `ctx.ui.select` + `ctx.ui.input`，没有任何 TUI 或 `ctx.ui.custom()` 依赖。
  - 对应需求：需求 9
  - 对应设计：§7.3、§10

## 阶段 3：Plan Mode 和会话文件

- [x] 3.1 固定并加载 Plan Mode 扩展
  - 状态：DONE
  - 这一步到底做什么：把可信的 Plan Mode 扩展版本固定到 Pi 启动配置，确认 edit/write 限制和扩展来源。
  - 做完你能看到什么：Pi 能在只读计划模式下运行，扩展缺失时能力自动关闭。
  - 先依赖什么：2.3、2.4
  - 开始前先看：`requirements.md` 需求 10；`design.md` §7.4；Pi plan-mode 示例源码。
  - 主要改哪里：`apps/host/pi-extensions/plan-mode-rpc/index.ts`（新增）、`apps/host/src/config/env.ts`、`apps/host/src/modules/provider/*`、`apps/host/src/modules/sessions/session-live-runtime-service.ts`。
  - 这一步先不做什么：不允许工作区任意扩展自动获得权限。
  - 怎么算完成：Plan Mode 启动、扩展加载失败和工具限制都有可观察结果。
  - 怎么验证：
    - 真实 `pi` 加载两个受控扩展后 `get_commands` 返回 `plan` / `plan-status`，无加载错误；
    - mock 驱动确认：计划模式开启时 edit/write 与破坏性 bash（含 PowerShell）被拦截，read/grep/只读 bash 放行；关闭时全部放行；`--plan` 与 `PI_PLAN_MODE=1` 两条启用路径都生效。
  - 落地结果：
    - 启动参数固定为 `--no-extensions` + `--extension <受控路径>`，工作区扩展自动发现始终关闭。
    - 受控扩展路径由 `resolveDefaultPiExtensionPaths()` 固定在 `apps/host/pi-extensions/`，可用 `CODINGNS_PI_EXTENSIONS` 整体覆盖。
    - `piQuestionExtensionAvailable` / `piPlanExtensionAvailable` 会进入能力快照：扩展不可用时 limitations 明确写出并关闭对应入口。
  - 对应需求：需求 10、11
  - 对应设计：§7.4、§8

- [x] 3.2 实现 Plan 审批回传和执行状态
  - 状态：DONE
  - 这一步到底做什么：把 Execute/Stay/Refine 的 select 请求接到 CodingNS UI，并继续消费扩展 follow-up/custom message。
  - 做完你能看到什么：用户可以批准执行计划、继续修改计划或停留在只读模式。
  - 先依赖什么：3.1
  - 开始前先看：`requirements.md` 需求 10；`design.md` §7.4。
  - 主要改哪里：Plan 扩展、Pi UI bridge、Host runtime event、前端交互门控。
  - 这一步先不做什么：不承诺 DSH 的完整审批范围模型。
  - 怎么算完成：审批请求、用户选择、扩展 follow-up、取消和进程退出都不丢状态。
  - 怎么验证：
    - 真实模型（`deepseek/deepseek-chat`，`PI_PLAN_MODE=1`）：模型输出「Plan: 1. … 2. … 3. …」后，扩展在 settled 阶段弹出 `计划已生成，请选择下一步`（选项：执行计划/继续完善计划/修改计划/取消），桥选择「执行计划」并收到回包，事件里能看到 `PI_EXTENSION_UI_PENDING:select` → `PI_EXTENSION_UI_RESOLVED:select:value`。
    - 只读约束：真实模型被要求「立刻用 bash 执行 touch plan-blocked.txt」，文件没有被创建，模型明确回报处于只读计划模式。
    - 扩展自身行为（mock 驱动）：执行/继续/修改/取消四条分支都验证过。
  - 本轮新发现并修掉的问题：`agent_settled` 事件体里没有 `messages`，原来在 settled 回调里取助手文本会直接抛错（被 try/catch 吞掉），导致审批永远不弹。现在改成在 `agent_end`（带 messages）先抓出计划步骤，settled 时再弹窗。
  - 前端呈现：计划审批现在走 Host 的 `plan_approval` 类型，前端用已有的计划审批卡片渲染（Markdown 计划正文 + 四个选项按钮），选项值直接回传给扩展；同时新增会话级「计划模式」开关，打开后发送会带 `permissionMode=plan`，Pi 侧映射成 `PI_PLAN_MODE=1` 注入受控扩展。
  - 相关测试：`apps/host/tests/integration/pi-extension-ui-bridge.test.ts`（plan_approval 形态与取消语义）、`apps/user-app/.../provider-ui.test.ts`（开关显隐）、`session-runtime-store.queue.test.ts`（plan 映射到 permissionMode）。
  - 已验证的限制：扩展回灌的计划消息目前靠普通消息渲染，没有单独的「计划执行中」样式。
  - 对应需求：需求 10
  - 对应设计：§7.4、§10

- [x] 3.3 实现 Pi session JSONL 扫描和增量读取
  - 状态：DONE
  - 这一步到底做什么：扫描指定 session 根目录，解析 session/message 树，按文件指纹和偏移增量读取。
  - 做完你能看到什么：Pi 已有会话能出现在列表中，新增历史不会重复读取整文件。
  - 先依赖什么：1.4
  - 开始前先看：`requirements.md` 需求 7、11；`design.md` §5；后台任务接入规范。
  - 主要改哪里：`packages/session-sync-core/src/runtime/pi-session-jsonl-reader.ts`（新增）、`packages/session-sync-core/src/runtime/pi-paths.ts`（新增）、`packages/session-sync-core/src/providers/pi.ts`（新增）、Host 发现链路。
  - 这一步先不做什么：不把 Pi JSONL 当成 CodingNS 主数据库，不在 watcher 里同步读大文件。
  - 怎么算完成：cwd 过滤、尾行、文件替换、未知 entry、游标和增量消息都有测试。
  - 怎么验证：
    - `node --test --test-timeout=25000 packages/session-sync-core/tests/pi-session-jsonl-reader.test.mjs`：22 个用例全部通过（seed/unchanged/append/不完整尾行/reset_required/同尺寸替换/非法行/未知 entry/cwd 解析/limit/分页/增量与整文件一致）。
    - `node --test --test-timeout=25000 packages/session-sync-core/tests/pi-adapter.test.mjs`：8 个用例覆盖 cwd 过滤、历史与增量、预创建、重命名、归档、删除边界、usage、目录规则一致性。
  - 落地结果：
    - 读取器纯同步、无定时器；记录文件 identity/size/mtime、已消费偏移、下一条逻辑序号和尾行缓存。
    - 发现只扫描受控 session 根目录的 `.jsonl`，并按 header 的 cwd 过滤；未知 entry 原样保留。
    - Pi 目录按**工作区**隔离（不是每个 CodingNS 会话一个目录），否则已有会话无法被发现；Host 侧统一用 `<数据目录>/pi-workspaces/<工作区>/pi-agent/sessions`。
    - 后台发现走现有 TaskManager/helper 链路（`provider-discovery-runtime` 已注册 `pi`），没有新增 Pi 私有 timer/inflight/重试队列。
  - 对应需求：需求 7、11、12
  - 对应设计：§5、§10

### 阶段检查 3.4

- [x] 3.4 阶段检查：Plan 和历史链路可独立回放
  - 状态：DONE
  - 这一步到底做什么：确认 Plan 审批和 session JSONL 不依赖真实模型也能回放。
  - 做完你能看到什么：可以进入 Fork/删除和 Host/前端注册，不会带着解析和交互硬伤往前走。
  - 先依赖什么：3.1、3.2、3.3
  - 开始前先看：阶段 3 全部文件。
  - 主要改哪里：阶段 3 相关文件。
  - 这一步先不做什么：不新增 DSH 不具备的能力。
  - 怎么算完成：Plan、question、扫描、增量读取和扩展缺失降级都有证据。
  - 怎么验证：
    - 会话扫描与增量读取：`pi-session-jsonl-reader.test.mjs` 22 例 + `pi-adapter.test.mjs` 8 例全通过；
    - 扩展加载：真实 `pi` 加载两个受控扩展成功（`get_commands` 返回 plan/plan-status，stderr 无错误）；
    - 扩展缺失降级：`createPiCapabilities({planExtensionAvailable:false})` 会在 limitations 写明并关闭入口（有断言）。
  - 补充：Plan 审批、question 工具、只读拦截都已用真实模型跑通（见 3.2 和 2.4 的验证记录）。
  - 遗留：Plan 审批的前端呈现仍是通用交互卡片，没有专门的计划审批视图。
  - 对应需求：需求 7、9、10
  - 对应设计：§5、§7、§10

## 阶段 4：会话操作和 Host/前端接入

- [x] 4.1 实现 Fork、Clone、重命名
  - 状态：DONE
  - 这一步到底做什么：把 CodingNS 消息 id 映射到 Pi entry id，调用 fork/clone/set_session_name，并更新 binding。
  - 做完你能看到什么：用户可以从消息或当前分支创建 Pi 新会话，原会话不被覆盖。
  - 先依赖什么：3.3
  - 开始前先看：`requirements.md` 需求 8；`design.md` §6.1、§6.2；现有 DSH/Command Code fork 实现。
  - 主要改哪里：`packages/session-sync-core/src/providers/pi.ts`、测试。
  - 这一步先不做什么：不实现重构式伪造 Fork。
  - 怎么算完成：source not found、取消、成功 rebinding 和 parent session 都有测试。
  - 怎么验证：已执行 `node --test --test-timeout=25000 packages/session-sync-core/tests/pi-adapter.test.mjs`（重命名写 `session_info` 并回读标题）和 `pnpm --dir packages/session-sync-core build`。
  - 落地结果：
    - Fork/Clone 通过一次短生命周期 RPC：起进程 → `get_fork_messages`/`clone` → `get_state` 拿新会话文件 → 关进程。
    - CodingNS 消息 id 不是 Pi entry id，所以用消息文本匹配 entryId；匹配不到返回 `PI_FORK_SOURCE_NOT_FOUND`，且原会话绑定和标题不变。
    - 新会话记录 `parentProviderSessionId`，原会话文件不被改写。
    - 重命名直接追加 Pi 自己的 `session_info` entry（写文件，不需要起进程），Pi 在 `/resume` 里看到的名称与 CodingNS 一致。
  - 真实模型验证（`deepseek/deepseek-chat`）：
    - 按消息 Fork：`native_message_fork`，新会话文件真实落盘，`inheritedPrefixMessageCount` 为 1；继续这个分叉会话问「我刚让你记住的词是什么」，模型正确回答「紫罗兰」，说明历史真的继承了。
    - 按会话 Clone：`native_session_fork`，新会话可用。
  - 本轮新发现并修掉的问题：
    1. Pi 的 fork 只在内存里建分支，文件要等出现 assistant 消息才落盘；分叉点常常是第一条用户消息，所以关掉进程后分叉会丢（继续会话报 `No session found`）。现在适配器在 fork 前用 `get_entries` 取出分支，按 Pi 的文件格式把新会话写出来。
    2. Pi 的 fork 语义是「分叉点之前的历史 + 返回原文供重发」，和 CodingNS「包含这条消息再往下继续」不一致；现在写入的分支包含分叉点本身。
    3. macOS 上 `/tmp` 会被 Pi 记成 `/private/tmp`，字符串比较会把同一目录判成越界；路径边界判断改成 realpath 加最长存在祖先的规范化比较。
  - 对应需求：需求 8
  - 对应设计：§6.1、§10

- [x] 4.2 定义删除和归档语义
  - 状态：DONE
  - 这一步到底做什么：实现安全删除和 CodingNS 元数据归档，明确 Pi 没有原生 archive 时的降级。
  - 做完你能看到什么：删除只会触及允许的 Pi session 根目录，归档不会误删文件。
  - 先依赖什么：3.3、4.1
  - 开始前先看：`requirements.md` 需求 8、11；`design.md` §6.3。
  - 主要改哪里：`packages/session-sync-core/src/providers/pi.ts`、测试。
  - 这一步先不做什么：不递归删除用户 HOME 或未验证路径。
  - 怎么算完成：活跃运行先停止、越界路径拒绝、删除后缓存清理、归档可恢复。
  - 怎么验证：已执行 `node --test --test-timeout=25000 packages/session-sync-core/tests/pi-adapter.test.mjs`；覆盖越界路径拒绝、正常删除、删后不可再读、归档只改元数据且可恢复。
  - 落地结果：
    - 删除前 Host 已拒绝运行中的会话（`SESSION_DELETE_RUNNING`），适配器再校验文件必须落在受控 session 根目录内，然后只删单文件并清理读取器缓存。
    - 归档写 `<sessionDir>/.codingns-pi-meta.json`，Pi 物理文件保留；取消归档可恢复。
    - 没有伪造 `supportsSessionArchive`，归档语义写在 capabilities.limitations 里。
  - 对应需求：需求 8、11
  - 对应设计：§6.3、§9

- [x] 4.2.1 补充修复：删除会话在 Host 和 CLI 两条链路上都不通
  - 状态：DONE
  - 这一段到底做什么：让 Pi 会话真的能被删掉，删完本地索引干净，重复删除不报错。
  - 做完你能看到什么：会话列表里删除 Pi 会话能成功，会话文件消失，列表里不再有这条。
  - 症状：删除 Pi 会话报「provider-sessions delete 仅支持 claude-code, legna-code, codex, …」。
  - 根因：Host 的删除分两条路 —— Grok / DeepSeek Harness 在 Host 进程内删，其它 provider 交给
    `codingns provider-sessions delete` CLI。Pi 两头都没接：既不在进程内分支，也不在 CLI 白名单和 registry 里。
    另外 Pi 删除时抛 `PI_SESSION_NOT_FOUND`，而 Host 只认 `PROVIDER_SESSION_NOT_FOUND`，
    于是「文件早就没了」这种情况也会被当成失败弹给用户。
  - 主要改哪里：`packages/session-sync-core/src/providers/pi.ts`、
    `apps/host/src/modules/sessions/session-history-service.ts`、
    `apps/host/src/modules/sessions/provider-session-delete-cli.ts`、
    `packages/codingns/bin/codingns.mjs`。
  - 怎么改：
    - Host 侧 Pi 和 Grok 一样在进程内删：删除就是删掉受控目录下的一个会话文件，不必再起一个 CLI 进程。
    - CLI 侧补上 `pi` 白名单和 `PiAdapter`，Host 通过 `CODINGNS_PI_DATA_ROOT` 把同一个数据根目录传下去，
      否则 CLI 会把会话文件判成越界。
    - Pi 的 `deleteSession` 在文件已经不存在时抛统一错误码 `PROVIDER_SESSION_NOT_FOUND`，
      Host 据此继续清理本地索引，而不是报错。
  - 这一步先不做什么：不改归档语义，也不做批量删除。
  - 怎么验证：
    - `pnpm --dir apps/host test tests/integration/provider-session-delete.test.ts`：15 个用例通过，
      其中新增 3 个 Pi 用例（删文件并清归档标记、Host 进程内删除不走 CLI、文件还没落盘也能删干净）。
    - `node --test --test-timeout=90000 packages/session-sync-core/tests/pi-*.test.mjs`：77 个用例通过。
    - 真实 CLI：`CODINGNS_PI_DATA_ROOT=<数据目录> node packages/codingns/bin/codingns.mjs provider-sessions delete --provider pi …`
      返回 `{"ok": true}` 且文件消失；重复删除返回 `PROVIDER_SESSION_NOT_FOUND`；越界路径被拒绝且文件保留。

- [x] 4.3 注册 Host Provider、runtime、配置和能力快照
  - 状态：DONE
  - 这一步到底做什么：把 Pi 接到 Host runtime factory、Provider catalog、配置读取、session history 和 capability snapshot。
  - 做完你能看到什么：Host 可以选择 Pi、创建会话、读取历史，并按 capability 控制按钮。
  - 先依赖什么：2.1、3.3、4.1、4.2
  - 开始前先看：`requirements.md` 需求 1、5、8；`design.md` §2.2、§8；现有 Command Code/DSH 注册点。
  - 主要改哪里：`apps/host/src/config/env.ts`、`apps/host/src/modules/provider/provider-catalog-service.ts`、`provider-runtime-state-service.ts`、`provider-discovery-runtime.ts`、`provider-discovery-helper-client.ts`、`apps/host/src/modules/sessions/session-history-service.ts`、`session-live-runtime-service.ts`。
  - 这一步先不做什么：不在业务服务里散落 `provider === "pi"` 特判。
  - 怎么算完成：启动/继续/历史/能力快照走统一入口，配置缺失时有明确 degraded 状态。
  - 怎么验证：
    - `pnpm --dir packages/session-sync-core build` 与 `pnpm --dir apps/host exec tsc --noEmit -p tsconfig.json` 通过；
    - `pnpm --dir apps/host test -- --run tests/integration/provider-catalog-routes.test.ts tests/integration/provider-discovery-runtime.test.ts tests/integration/session-permission-request-service.test.ts`：23 passed，1 failed（`catalog 会直接读取启动时缓存的 provider 运行状态`，已在 HEAD 上对照复现，属于既有环境相关失败，与本次改动无关）。
  - 落地结果：
    - 配置新增 `piCliPath`、`piDataRootDir`、`piExtensionPaths`、`piQuestionExtensionAvailable`、`piPlanExtensionAvailable`。
    - Provider catalog、运行状态探测（installState/version）、后台发现 helper、session history registry、runtime factory 全部注册了 Pi，走的是和 Command Code 相同的公共入口。
    - 缺少 `pi` 可执行文件时 installState 为 missing，catalog 会把可写能力关掉并给出安装提示。
  - 对应需求：需求 1、2、5、7、8
  - 对应设计：§2、§3、§5、§8

- [x] 4.4 接入 user-app provider UI 和交互门控
  - 状态：DONE
  - 这一步到底做什么：通过统一 i18n 和 capability 显示 Pi，接入模型、附件、Fork、Plan/权限交互，不硬编码假能力。
  - 做完你能看到什么：用户可以在前端使用 Pi 支持的入口，DSH 专属按钮不会出现在 Pi 上。
  - 先依赖什么：4.3、3.2
  - 开始前先看：前端页面与样式规范、模态框规范（如果改交互弹窗）、现有 provider UI。
  - 主要改哪里：`apps/user-app/src/features/conversation/capability/provider-ui.ts`、`api/conversation-api.ts`、`assets/provider-icons/pi.svg`、`src/shared/i18n/index.ts`、`capability/provider-ui.test.ts`。
  - 这一步先不做什么：不新建独立的 Pi 页面，不用硬编码中文文案替代 i18n。
  - 怎么算完成：模型选择、图片/文件附件、Fork/Clone、Plan 审批和交互等待状态有 UI 测试。
  - 怎么验证：已执行 `pnpm --dir apps/user-app test -- --run src/features/conversation/capability/provider-ui.test.ts`，13 个用例通过（含新增的 Pi 用例）；`pnpm --dir apps/user-app test -- --run src/shared/i18n/index.test.ts` 里 provider 相关断言通过（该文件另有一条 `shell.butlerEntry` 断言失败，属既有文案与断言不一致，与本次改动无关）。
  - 落地结果：
    - Pi 进入 `REGISTERED_PROVIDER_IDS` 和 `SESSION_PROVIDER_PICKER_IDS`，有本地 SVG 图标和 zh-CN / en-US 文案。
    - 草稿能力按 Pi 的真实边界给：`inRunInputMode: "queued_guidance"`、可中断、可附件、`supportsPermissionPrompt: false`。
    - 模型、附件、Fork、删除这些入口都由 capability 驱动，Pi 不需要单独页面。
  - 计划相关补完：
    - 会话页 composer 新增计划模式开关（仅当 provider 声明 `supportsPlanMode` 时显示），状态存在会话运行时里，发送时自动带 `permissionMode=plan`。
    - 计划审批用 Host 的 `plan_approval` 卡片渲染，不再是通用交互卡片。
  - 还没做完的部分：没有针对 Pi 的会话创建 UI E2E；事务工作台/助手的 composer 没有接这个开关（只接了主会话页）。
  - 对应需求：需求 5、6、8、9、10
  - 对应设计：§7、§8、§10

## 阶段 5：统计、回归和最终验收

- [x] 5.1 接入基本 token usage 和上下文显示
  - 状态：DONE
  - 这一步到底做什么：从 Pi final message/session stats 读取可验证 usage，写入 CodingNS 稀疏统计模型。
  - 做完你能看到什么：用户能看到基本输入、输出、缓存和费用信息；缺失值不会被伪造为 0。
  - 先依赖什么：1.3、4.3
  - 开始前先看：`requirements.md` 需求 5；`design.md` §8、§10；session pricing 规则。
  - 主要改哪里：`packages/session-sync-core/src/runtime/pi-event-normalizer.ts`、`packages/session-sync-core/src/providers/pi.ts`、相关测试。
  - 这一步先不做什么：不声称 Pi usage 与 DSH projection 完全同口径。
  - 怎么算完成：usage 来源、语义、水位和缺失原因有测试断言。
  - 怎么验证：
    - `node --test --test-timeout=25000 packages/session-sync-core/tests/pi-event-normalizer.test.mjs`：usage 按 assistant 消息累加、缺失字段保持 null；
    - `node --test --test-timeout=25000 packages/session-sync-core/tests/pi-adapter.test.mjs`：`readSessionStats` 累加真实 usage，无 assistant 消息时返回 null（不补 0）。
  - 落地结果：
    - 运行时路径：normalizer 累计 input/output/reasoning/cacheRead/cacheWrite/total/cost，只统计真实提供的字段。
    - 历史路径：`readSessionStats` 从会话 JSONL 的 assistant usage 求和，`semantic: "sum-of-final-events"`、`watermark.kind: "source-sequence"`、来源 `provider-session-store`。
    - `readContextUsage()` 明确返回 null：Pi 会话文件里没有可靠的上下文窗口信息，宁可不显示也不伪造比例。
  - Host 计费与水位（本轮补完）：
    - 费用按统一的 `addProviderNativeCostMetric` 记为 `provider-native` + `coverage: complete`，Host 会把 Pi 自己算出的金额落成账单，不再当成"没有可信费用"。
    - 按模型归因（`modelUsages`）来自会话文件里每条 assistant 消息的 provider/model，Host 侧允许 provider-native 完整账单保留按模型金额（价格表估算的局部金额仍不保留）。
    - `readContextUsage()` 现在返回真实水位：取最后一条 assistant 消息的 input+cacheRead+cacheWrite 作为 promptTokens，上下文窗口从用户 Pi 的 `models-store.json` 按 provider/model 查；查不到窗口时返回 null，不编造比例。
  - 相关测试：`packages/session-sync-core/tests/pi-adapter.test.mjs`（上下文水位、provider-native 费用与按模型归因）、`apps/host/tests/integration/session-stats-snapshot-repository.test.ts`（provider-native 账单与模型明细落库）。
  - 缺失即缺失：模型库查不到窗口、Pi 没报 cost 时对应字段保持没有，而不是填 0。
  - 对应需求：需求 5、12
  - 对应设计：§8、§10、§11

- [x] 5.2 完成 Pi RPC、JSONL、附件、Fork、Plan 和交互回归
  - 状态：DONE
  - 这一步到底做什么：把本 Spec 列出的所有功能组合成最小回归集。
  - 做完你能看到什么：没有真实模型密钥时仍能证明协议适配器可用；真实 CLI 只作为额外冒烟。
  - 先依赖什么：4.4、5.1
  - 开始前先看：`requirements.md` 全文、`design.md` §10、tasks.md 全部任务。
  - 主要改哪里：核心测试、`scripts/pi-live-smoke.mjs`（新增）。
  - 这一步先不做什么：不把全量项目测试当成默认验证入口。
  - 怎么算完成：直接相关测试通过，失败路径和已知限制已记录。
  - 怎么验证：
    - 离线回归：`node --test --test-timeout=40000 packages/session-sync-core/tests/pi-*.test.mjs` → 6 个文件 75 个用例全部通过，无挂起。
    - 真实模型冒烟：`node scripts/pi-live-smoke.mjs` → 8 个场景全部通过（单轮文本 + usage、工具调用归一化、steer、Fork 后继续并继承历史、question 交互、Plan 审批与只读拦截、图片附件、clear_queue）。
    - Host：`pnpm --dir apps/host test -- --run` 相关 5 个文件 39 个用例通过（扩展交互桥、计划模式策略、统计仓储、权限服务、后台发现）。
    - 前端：`pnpm --dir apps/user-app test -- --run` 相关 3 个文件 108 个用例通过（provider-ui、会话运行时队列、ComposerPanel）。
    - `pnpm check:sqlite-runtime` 通过。
  - 本轮补强：真实模型冒烟从 6 个场景扩到 8 个（新增图片附件、clear_queue）；Host 侧新增扩展交互桥和计划模式策略两组 integration 用例。
  - 还没做完的部分：`provider-catalog-routes.test.ts` 有一条既有环境相关失败（已在干净 HEAD 上复现，与本 Spec 无关）；核心包里两个 vitest 写法的计价用例在本机解析不到 vitest 依赖，跑不起来（既有问题）。
  - 对应需求：需求 1-12
  - 对应设计：§10、§11

- [x] 5.3 更新能力基线、使用说明和限制
  - 状态：DONE
  - 这一步到底做什么：记录安装、配置、Plan/question 扩展、附件协议、删除/归档和不可恢复场景。
  - 做完你能看到什么：别人可以按文档配置 Pi，并知道哪些能力不能和 DSH 等价。
  - 先依赖什么：5.2
  - 开始前先看：`README.md`、`requirements.md`、`design.md`、基线文档。
  - 主要改哪里：`specs/spec010.8-PIAgentCLI适配接入/docs/20260915-PiAgent接入使用说明与限制.md`（新增）、`README.md`。
  - 这一步先不做什么：不把未验证的真实模型能力写成保证。
  - 怎么算完成：版本、命令、环境变量、能力矩阵、错误码和回归命令都能找到。
  - 怎么验证：文档走查 + `git diff --check`（无空白错误）；文档里的命令都实际执行过。
  - 落地结果：新文档覆盖前置条件、Host 配置项、数据目录与凭据同步规则、受控扩展、附件协议、删除/归档、13 个错误码、明确做不到的事、回归命令。
  - 对应需求：需求 1、11、12
  - 对应设计：§1、§8、§9、§10、§11

### 最终检查 5.4

- [x] 5.4 最终验收
  - 状态：DONE
  - 这一步到底做什么：逐条核对需求、设计、任务、测试和已知限制，确认没有把 DSH 专属能力冒充成 Pi 能力。
  - 做完你能看到什么：Spec 可以进入实现完成状态，后续接手人能从 tasks.md 直接继续。
  - 先依赖什么：5.1、5.2、5.3
  - 开始前先看：`requirements.md`、`design.md`、`tasks.md` 和全部 docs。
  - 主要改哪里：当前 Spec 全部文档。
  - 这一步先不做什么：不追加新功能，不把外部模型调用成功当成唯一验收条件。
  - 怎么算完成：全部 In Scope 能力有实现和验证证据，Out of Scope 和降级项有明确记录。
  - 怎么验证：按需求逐条核对，证据分布如下：
    | 需求 | 证据 |
    | --- | --- |
    | 1 Provider 接入 | Host catalog / runtime / history / discovery 注册；catalog integration 测试通过 |
    | 2 新建、继续、发送 | runtime 用例 + 真实模型冒烟（单轮文本、Fork 后继续） |
    | 3 事件归一化 | normalizer 用例 10 条 + 真实工具调用（21 条 tool_call → 1 条 tool_result） |
    | 4 运行中输入与中断 | steer/follow_up/clear_queue/abort 用例 + 真实 steer（STEER-OK） |
    | 5 模型与用量 | 模型编解码、参数映射用例 + 真实 usage（input/output/cache/cost） |
    | 6 附件 | 图片/内联/路径/越界用例；真实链路未跑图片，记为限制 |
    | 7 发现与增量 | reader 22 例 + adapter 用例（cwd 过滤、seed/append、尾行、替换） |
    | 8 Fork/Clone/重命名/删除/归档 | adapter 用例 + 真实 Fork 继承历史、Clone 成功 |
    | 9 扩展 UI 与 question | 桥用例 + 真实 question 交互（选择回灌给模型） |
    | 10 Plan 审批 | 真实模型：审批 select 正常弹出并回传；只读拦截挡住 rm/touch 类写操作 |
    | 11 安全与生命周期 | 路径边界（realpath 规范化）、扩展白名单、进程回收、session 文件越界拒绝 |
    | 12 回归与可观测性 | 68 条离线用例 + 6 个真实场景冒烟 + 错误码文档 |
  - Out of Scope / 降级项落点：DSH Remote 重放、Host 重启接管 turn、原生 Agent Preset/subagent、`session/control`、结构化权限范围审批 → 全部写进 `PI_UNAVAILABLE_DSH_CAPABILITIES`；归档、usage 口径、文件附件协议 → 写进 `PI_BASE_LIMITATIONS`。
  - 仍未闭环（不影响本 Spec 的 In Scope 验收，但接手人要知道）：
    1. 事务工作台和助手页的 composer 没有接计划模式开关（只接了主会话页）。
    2. 计划执行阶段没有单独的视觉样式，回灌消息按普通消息渲染。
    3. Windows 上的 bash/powershell 拦截只有逻辑单测（`pi-plan-mode-policy.test.ts`），没有真机跑过。
    4. 真实图片附件只验证了 PNG 一种格式；`clear_queue` 只验证了 follow-up 队列，steering 队列没有单独构造真实场景。
    5. 真实模型冒烟 `scripts/pi-live-smoke.mjs` 需要手工触发，没有挂进自动回归。
  - 对应需求：需求 1-12
  - 对应设计：全文

## 阶段 6：验收后修复

- [x] 6.1 修复：AI 输出已经结束，会话却一直显示“进行中”
  - 状态：DONE
  - 这一步到底做什么：让 Pi 在模型文本已经输出完、但扩展还在等用户交互时，也能把“这一轮运行已经结束”告诉 Host。
  - 做完你能看到什么：计划模式（以及其他会在 settled 阶段弹交互的扩展）跑完后，会话不再无限转圈；审批卡片照常等用户选择。
  - 先依赖什么：2.3、3.2
  - 症状：用户在计划模式下让 Pi 出计划，Pi 的计划文本已经全部显示出来，界面却一直停在进行中状态；等用户点了计划审批之后状态才结束。
  - 根因（两条，都会让 Host 认定“还在跑”）：
    1. **Pi 转发 `agent_settled` 的顺序**：上游 `AgentSession._emitAgentSettled()` 是先 `await` 扩展的 `agent_settled` handler，再把这个事件发给 RPC 客户端。而计划模式扩展正是在这个 handler 里 `await ctx.ui.select(...)` 等用户点审批 —— 于是 `agent_settled` 一直被挂住，Host 收不到任何结束信号。真实进程实测：`agent_end` 出现在 4013ms，之后 15 秒都没有 `agent_settled`，只有审批交互请求。
    2. **Host 的会话活动推断不认 Pi 的文件格式**：`inspectSessionActivity()` 只有 claude-code 和 codex 两条分支，`pi` 会掉进 codex 分支，而 Pi 的记录类型是 `session` / `message` / `session_info`，不是 `event_msg` / `response_item`，于是 `lastEventAt` 永远是 null、终态永远推不出来。
  - 主要改哪里：`packages/session-sync-core/src/runtime/pi-event-normalizer.ts`、`packages/session-sync-core/src/runtime/pi-runtime.ts`、`apps/host/src/modules/sessions/session-activity-inspector.ts`、两侧测试。
  - 怎么改：
    - 归一化器：`agent_end` 且 `willRetry !== true` 时直接发 `status: "completed"`（不再是 running），并记住“主体已结束”。Pi 只在不会自动重试时才把 `willRetry` 置为 false，所以这个信号是可靠的；重试、压缩、排队消息期间仍然保持 running。
    - 运行时适配器：主体结束之后，收尾阶段的诊断和扩展交互还会带 running 状态，这些事件统一按 completed 放行，避免把会话重新点亮成“进行中”。
    - 不提前兑现 `completed` promise：进程要留着等审批回包，`agent_settled` 到了才关进程，否则审批永远回不去。
    - Host 活动推断：给 `inspectSessionActivity()` 增加 Pi 分支，按“最后一条 assistant 是否还有没配对的 toolCall、stopReason 是不是 error/aborted”推断 completed / running / failed / interrupted。
  - 这一步先不做什么：不改 Pi 上游的事件顺序，不给扩展交互硬编码超时，不动前端显示逻辑。
  - 怎么验证：
    - `node --test --test-timeout=40000 packages/session-sync-core/tests/pi-*.test.mjs`：79 个用例全部通过（新增「扩展交互挂住 agent_settled 时，仍然先报告这一轮已经结束」和「agent_end 之后新的一轮会把主体完成标记清掉」两条）。
    - `pnpm --dir apps/host test -- --run tests/integration/session-runtime-status.test.ts`：新增 3 条 Pi 用例通过（答完不再判运行中、工具没配对仍判运行中、用户刚发消息仍判运行中）；该文件另有 8 条既有环境相关失败（已在干净基线上复现，与本次改动无关）。
    - 真实 `pi` + 受控 plan-mode 扩展：`agent_end` 后状态收敛成 completed，审批交互桥接成功，之后没有被改回 running，进程保持存活等审批。
  - 对应需求：需求 3、4
  - 对应设计：§4、§9

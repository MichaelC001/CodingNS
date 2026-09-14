# 任务清单 - spec002.1.2 会话索引与显式扫描

状态：Draft

## 阶段 1：收紧后端入口

- [x] 1.1 创建会话成功后单条写入 SQLite
  - 状态：DONE
  - 实际修改：确认并保留 `apps/host/src/modules/sessions/session-history-service.ts` 中 `startSessionDirect` 的 provider 成功后事务写入 binding、index、status、state 顺序。
  - 可观察结果：创建接口不再依赖 discovery 找回会话；provider 启动失败不会写入索引。
  - 验证：`pnpm --dir apps/host exec tsc --noEmit`；`pnpm --dir apps/host test -- tests/integration/session-history-service.test.ts tests/integration/session-history-background-tasks.test.ts`。
  - 风险：Host 事务失败时 provider 原生会话可能已创建，当前错误通过接口返回，后续可增加专用恢复标记。

- [x] 1.2 普通会话列表完全改为索引读取
  - 状态：DONE
  - 实际修改：`apps/host/src/modules/sessions/session-controller.ts` 移除列表请求中的 `requestWorkspaceDiscovery`，仅调用 `listWorkspaceSessions`。
  - 可观察结果：GET `/api/sessions` 不启动 discovery/helper，不读取 provider 历史目录。
  - 验证：会话历史集成测试 25 项通过；Host 类型检查通过。
  - 风险：旧客户端若依赖列表自动发现外部历史，需要主动使用扫描按钮。

## 阶段 2：显式扫描

- [x] 2.1 新增显式扫描任务和 API
  - 状态：DONE
  - 实际修改：新增 `workspace.discovery.explicit_scan`、POST/DELETE `/api/sessions/discovery/scan`、GET `/api/sessions/discovery/status`；任务 key 使用 workspaceId，执行位点声明为 helper_process；helper 入参和 Host 收尾阶段都按 enabled provider 过滤，Host 不接受异常 helper 返回的停用 provider 结果。
  - 可观察结果：重复点击返回同一任务（deduped），扫描结果继续走现有幂等索引合并逻辑。
  - 验证：Host 类型检查通过；`session-history-background-tasks.test.ts` 21 项通过，包含停用 provider 结果/诊断被 Host 丢弃的回归；新增“显式扫描 helper_process + Host 回写”集成测试通过。
  - 实际修改：`TaskDefinition` 保留 helper 完成后的轻量编排，新增 `workspace.discovery_persist` Host 任务；显式扫描的 `postProcess` 只把 helper 结果交给同 workspace key 的持久化任务，SQLite 回写继续使用现有分批事务；自动 discovery 也复用同一持久化任务，不会在 Host 任务中再次扫描。
  - 可观察结果：helper 扫描和 Host SQLite 回写分别有独立 taskId、executionLane、超时、进度和失败状态；同一 workspace 的回写通过 `workspace.discovery_persist` + workspace key 去重，不会并发写入。
  - 验证：`perl -e 'alarm 120; exec @ARGV' pnpm --dir apps/host test -- tests/integration/session-history-background-tasks.test.ts --reporter=dot`（显式 helper 完成和独立回写任务通过）；Host 类型检查通过。
  - 补充验证：同一测试文件按名称执行“显式扫描使用”“Host 回写”“取消显式扫描”4 项通过，覆盖回写成功、Host 回写失败保留旧索引、取消传播和回写超时。
  - 风险：外层显式扫描任务仍需等待持久化任务完成后才向调用方报告 succeeded，这是为了保证 API 成功意味着索引已落盘；持久化失败会让外层任务失败并保留旧索引。

- [x] 2.2 新增扫描结果观测和错误状态
  - 状态：DONE
  - 实际修改：扫描状态接口返回 task snapshot、progress、resultCount、错误码/消息；复用现有 discovery diagnostics（scanned/skipped/parsed/bytes/duration/source）。
  - 可观察结果：前端可显示 queued/running/succeeded/failed，失败不会清理旧索引。
  - 验证：`pnpm check:sqlite-runtime`；会话历史后台任务集成测试通过。
  - 风险：当前进度主要来自 TaskManager 状态，provider 分阶段进度仍以完成后的 diagnostics 为主。

## 阶段 3：前端入口与延迟加载

- [x] 3.1 新建会话桌面弹窗增加手动扫描按钮
  - 状态：DONE
  - 实际修改：`WorkbenchLayout.tsx`、`conversation-api.ts`、`shared/i18n/index.ts`。
  - 可观察结果：按钮显示扫描中/完成数量/错误，重复点击在同一 workspace 复用任务；关闭弹窗不会取消任务。
  - 验证：`pnpm --dir apps/user-app exec tsc --noEmit`。
  - 验证：WorkbenchLayout 扫描/并行按钮顺序专项测试（1 项）和重复点击只创建一个任务专项测试（1 项）通过。
  - 风险：全量 WorkbenchLayout 测试仍较慢，未作为本轮阻断项。

- [x] 3.2 移动端新建会话 Sheet 增加同一动作
  - 状态：DONE
  - 实际修改：`MobileCreateSessionSheet.tsx` 接入统一 MobileSheet/ModalSection、扫描 API、i18n 文案和取消流程；扫描上下文固定保存 workspace 与 targetHostId，轮询使用 AbortSignal。
  - 可观察结果：移动端显示扫描中/完成数量/失败状态，重复点击被禁用；远程 workspace 的 POST、状态轮询和 DELETE 取消都使用扫描开始时的 `targetHostId`。
  - 验证：`perl -e 'alarm 120; exec @ARGV' pnpm --dir apps/user-app exec tsc --noEmit`；`perl -e 'alarm 120; exec @ARGV' pnpm --dir apps/user-app test -- src/features/mobile-sessions/components/MobileCreateSessionSheet.test.tsx`（4 项通过）。
  - 风险：关闭弹窗只停止本地轮询，不会自动向服务端取消任务；用户需要在弹窗仍打开时点击“取消扫描”。

- [ ] 3.3 虚拟会话和历史改为打开会话后加载
  - 状态：IN_PROGRESS
  - 实际修改：`conversation-api.ts` 的会话历史缓存现在覆盖带 AbortSignal 的调用，并以 session/cursor/limit/direction/targetHostId 组成键；`ConversationPage.tsx`、`SessionBranchTreePanel.tsx`、`ParallelConversationGroupView.tsx` 透传详情阶段的 Host 作用域；新增和补充 `conversation-api.test.ts`、`ParallelConversationGroupView.test.tsx`，覆盖普通列表、子 Agent 历史、并行详情和请求去重次数。
  - 可观察结果：普通列表仍只请求 SQLite 索引；具体会话详情才触发首屏历史；同一请求的多个组件共享一个 HTTP Promise，组件取消不会取消仍被其他会话使用的请求；分支预览和并行成员不会把当前 Host 错传给远程 workspace。
  - 验证：`perl -e 'alarm 120; exec @ARGV' pnpm --dir apps/user-app exec tsc --noEmit`；`perl -e 'alarm 120; exec @ARGV' pnpm --dir apps/user-app test -- src/features/conversation/api/conversation-api.test.ts src/features/conversation/components/SessionBranchTreePanel.test.tsx src/features/conversation/components/ParallelConversationGroupView.test.tsx src/features/mobile-sessions/components/MobileCreateSessionSheet.test.tsx`（4 个文件、30 项通过）。
  - 补充验证：当前五个前端请求/详情专项文件共 70 项通过；`conversation-api.test.ts` 与 `ParallelConversationGroupView.test.tsx` 请求次数专项共 22 项通过；WorkbenchLayout 扫描/并行入口专项 2 项通过。
  - 补充验证：`SessionRuntimeStore` 首屏相关专项 4 项中 3 项通过；整文件为 47/61 通过，剩余 14 项是既有的精确参数、时间线排序和 runtime 合并断言。
  - 风险：普通并行成员和分支预览的组件请求次数已覆盖，但仍需补齐完整详情页、虚拟会话和子 Agent 展开动作的端到端请求次数测试；在这些验收完成前本任务必须保持 `IN_PROGRESS`。

## 阶段检查

- [x] 4.1 性能回归检查
  - 状态：DONE
  - 已执行：Host/user-app 类型检查、会话历史集成测试、`pnpm check:sqlite-runtime`、`git diff --check`。
  - 补充验证：`tests/integration/session-routes.test.ts`（6 项）、`tests/integration/session-route-config.test.ts`（2 项）通过；`MobileCreateSessionSheet.test.tsx` 扫描专项 3 项通过；WorkbenchLayout 扫描专项 2 项通过；Codex/Kimi/JSONL 核心回归 74 项通过。
  - 补充验证：`tests/integration/session-history-background-tasks.test.ts`、`session-routes.test.ts`、`session-route-config.test.ts` 共 37 项通过；`provider-control-session-history.test.ts` 10 项通过，覆盖停用 provider 的历史、标题、状态、统计、扫描和普通列表；前端详情/请求专项 70 项通过。
  - 已知风险：WorkbenchLayout 全量组件测试在 180 秒超时保护内未结束；Host 回写已经拆为独立 `workspace.discovery_persist` 任务，仍需在真实大工作区上继续观察分批耗时和队列等待。

- [x] 4.2 事务文档库停用时禁止所有任务入队
  - 状态：DONE
  - 实际修改：`apps/host/src/modules/workspace/affairs-library-service.ts` 将配置保存、手动刷新、目录提示和自动刷新统一收口到 `enqueueLibraryTask()`；停用时注册方法为空，自动入口提前返回。`apps/host/tests/modules/workspace/affairs-library-service.test.ts` 增加配置保存回归覆盖。
  - 可观察结果：停用状态下三个历史入口均不调用 `TaskManager.enqueue`；配置保存只落盘并返回 `disabled` 句柄，手动刷新返回 `disabled`，目录提示返回 `scheduled: false`，目录列表不再因任务未注册返回 500。
  - 验证：`perl -e 'alarm 90; exec @ARGV' pnpm --dir apps/host test -- tests/modules/workspace/affairs-library-service.test.ts -t '任务停用时' --reporter=dot`（4 项通过）；事务文档库、诊断仓储和显式扫描联合回归 74 项通过。
  - 风险：停用状态仍保留旧任务快照的 `peek/cancel` 兼容读取，用于识别历史 orphan 状态，但不会访问注册表或入队；若要做到停用时完全不触碰 TaskManager，需要另拆状态来源。重新启用功能时必须同时恢复任务注册和 helper handler。

- [x] 4.3 discovery diagnostics 保留策略与来源区分
  - 状态：DONE
  - 实际修改：`session-discovery-diagnostics-repository.ts` 增加跨工作区的 `pruneGlobalBatch`，按时间和工作区数量双重限制、每轮最多删除 1000 条；`session-history-service.ts` 注册 `session.discovery_diagnostics_maintenance` Host 任务；`session-controller.ts` 和 `routes/sessions.ts` 增加显式维护入口；诊断保留 `trigger_source`；相关集成测试补充旧工作区和分批清理覆盖。
  - 可观察结果：普通列表请求不执行清理；调用 POST `/api/sessions/discovery/diagnostics/maintenance` 只入队全局维护任务，任务有独立进度、取消、超时和失败状态；旧工作区也会被逐轮处理；当前实现不会执行 `VACUUM` 或 `incremental_vacuum`。
  - 验证：`perl -e 'alarm 120; exec @ARGV' pnpm --dir apps/host test -- tests/integration/session-source-index-repository.test.ts tests/integration/session-history-background-tasks.test.ts tests/integration/session-routes.test.ts tests/integration/session-route-config.test.ts --reporter=dot`（4 个文件、37 项通过）；Host 类型检查通过。
  - 补充验证：诊断仓储和后台任务按“全局维护”“按保留时间”“SQLITE_BUSY”执行 5 项通过，覆盖旧工作区、过期记录、数量上限、分批上限和并发锁退避重试。
  - 风险：全局入口是显式维护调用，尚未绑定新的私有定时器或低峰调度；每次最多处理 1000 条，超量数据需要后续维护轮次；SQLite 文件不会自动缩小。

- [x] 4.4 helper 关闭、取消与进程组回收
  - 状态：DONE
  - 实际修改：Host 的 `child-process-lifecycle.ts` 增加脱离 ChildProcess 句柄的 PID/进程组有界回收，并修正 `child.killed` 不能代表进程已退出的问题；provider discovery、Codex app-server、Git、OpenCode probe、Tailscale、模型探测、插件、文档导出、Butler、工作区扫描、模板端口和 PTY 附件的直接终止路径统一接入该工具。新增 `packages/session-sync-core/src/runtime/child-process-lifecycle.ts`，并让 Claude、Codex、Gemini、Kimi、Grok ACP runtime 的关闭/中断复用 TERM→等待→KILL；Host 终止终端附件时会等待挂起的 PID 回收。
  - 可观察结果：取消先传播 Abort/cancel，再在宽限期后按对应进程组 TERM→KILL；每次回收有明确上限并等待 exit/close 或 PID 消失；Windows 不支持负 PID 时只回退单进程。
  - 验证：`perl -e 'alarm 120; exec @ARGV' pnpm --dir apps/host exec tsc --noEmit`；`perl -e 'alarm 120; exec @ARGV' pnpm --dir apps/host test -- tests/integration/task-helper-client.test.ts tests/integration/provider-discovery-helper-client.test.ts tests/integration/git-command-helper-client.test.ts tests/modules/tasks/task-helper-client.test.ts tests/modules/tasks/task-helper-pool.test.ts tests/integration/codex-app-server-helper-process.test.ts tests/integration/opencode-system-probe-helper-process.test.ts tests/integration/tailscale-helper-client-lifecycle.test.ts tests/shared/child-process-lifecycle.test.ts --reporter=dot`（9 个文件、36 项通过）。
  - 补充验证：`packages/session-sync-core/tests/runtime-child-process-lifecycle.test.mjs` 5 项通过；Claude runtime 40 项、Gemini/Kimi runtime 12 项、Codex app-server 取消/关闭 3 项通过；session-sync-core build 通过。
  - 风险：模板端口探测对当前 Host 进程组仍必须延后终止；已遗留的 PPID=1 孤儿进程不会被代码追溯清理，需要重启 Host 或人工处理；一次性外部命令仍保留直接 `spawn`，但终止已统一。
  - 风险补充：剩余 `process.kill(pid, 0)` 仅用于存活探测，node-pty `.kill()` 仅用于 PTY 自身 API 回退；模板端口延后 helper 会在目标属于当前 Host 进程组时脱离 HTTP 请求执行，不能在 Host 被目标组终止前等待其退出。

- [x] 4.5 JSONL 半行读取与扫描重试
  - 状态：DONE
  - 实际修改：`packages/session-sync-core/src/providers/utils.ts` 新增详细发现结果，严格区分尾部半行、稳定坏行、持续变化、截断、替换和删除；文件指纹变化时最多重读 5 次，总预算约 160ms，默认退避 4/8/16/32ms。Codex、Claude、Grok、Kimi discovery 接入结构化计数和 `partial` 诊断；详情历史继续使用原有严格尾读/解析路径。
  - 可观察结果：追加中的尾部半行不会被当作稳定坏行；连续四次追加可在第五次读到稳定快照；连续变化达到上限会停止重试并返回不完整状态；稳定坏行、截断和删除分别留下明确状态。
  - 验证：`perl -e 'alarm 120; exec @ARGV' pnpm --dir packages/session-sync-core build`；`tests/jsonl-utils.test.mjs` 7 项通过；Codex/Kimi/JSONL 联合读取测试 74 项通过；Grok provider/runtime/ACP Vitest 测试 26 项通过。
  - 补充验证：Codex/Kimi/JSONL 当前联合读取测试 74 项通过；Grok provider/runtime/ACP Vitest 测试 26 项通过；Claude runtime 40 项、Gemini/Kimi runtime 12 项通过。
  - 风险：同步重试函数只在 helper discovery 路径使用；最终仍持续变化的文件会保留旧快照并标记 `changed_during_read`，不会无限等待；SQLite/Host 不会因此阻塞等待文件稳定。

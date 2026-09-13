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
  - 实际修改：`TaskDefinition` 增加 `postProcess`，显式扫描通过 `session.workspace_discovery` helper 处理器返回结果，再在同一 TaskManager 任务中执行 Host 索引回写；旧 discovery 路径保持不变。
  - 风险：Host 回写仍与任务结果串联执行，但已不再由 Host `run()` 间接嵌套扫描。

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
  - 实际修改：`MobileCreateSessionSheet.tsx` 接入统一 MobileSheet/ModalSection、扫描 API 和 i18n 文案。
  - 可观察结果：移动端同样显示扫描中/完成数量/失败状态，重复点击被禁用。
  - 验证：`pnpm --dir apps/user-app exec tsc --noEmit`。
  - 验证：`MobileCreateSessionSheet.test.tsx` 覆盖完成、失败、扫描中禁用、重复点击去重及 `targetHostId` 透传。
  - 风险：扫描任务关闭弹窗后继续运行，结果需重新打开弹窗查看。

- [ ] 3.3 虚拟会话和历史改为打开会话后加载
  - 状态：IN_PROGRESS
  - 实际修改：确认 `SessionRuntimeStore.initialize()` 只在具体会话详情挂载后启动历史首屏；普通导航列表不请求 messages/virtual history；`conversation-api.ts` 增加无 AbortSignal 首屏请求去重缓存。
  - 可观察结果：同一会话相同 cursor/limit/direction/host 的并发首屏请求共享一个 HTTP Promise，虚拟/子 Agent 展开仍由详情阶段触发。
  - 验证：`pnpm --dir apps/user-app exec tsc --noEmit`；移动扫描组件测试通过。
  - 风险：虚拟会话、子 Agent 历史的详情阶段请求边界和所有组件去重尚未完全收口；并行会话详情若使用不同分页参数仍会产生独立请求，这是预期行为。

## 阶段检查

- [x] 4.1 性能回归检查
  - 状态：DONE
  - 已执行：Host/user-app 类型检查、会话历史集成测试、`pnpm check:sqlite-runtime`、`git diff --check`。
  - 补充验证：`tests/integration/session-routes.test.ts`（6 项）、`tests/integration/session-route-config.test.ts`（2 项）通过；`MobileCreateSessionSheet.test.tsx` 扫描专项 3 项通过；WorkbenchLayout 扫描专项 2 项通过；Codex/Kimi/JSONL 核心回归 60 项通过。
  - 已知风险：WorkbenchLayout 全量组件测试在 180 秒超时保护内未结束；Host 回写仍属于显式任务的收尾阶段，需要后续继续做批量预算优化。

- [x] 4.2 事务文档库停用时禁止所有任务入队
  - 状态：DONE
  - 实际修改：`apps/host/src/modules/workspace/affairs-library-service.ts` 将配置保存、手动刷新、目录提示和自动刷新统一收口到 `enqueueLibraryTask()`；停用时注册方法为空，自动入口提前返回。`apps/host/tests/modules/workspace/affairs-library-service.test.ts` 增加配置保存回归覆盖。
  - 可观察结果：停用状态下三个历史入口均不调用 `TaskManager.enqueue`；配置保存只落盘并返回 `disabled` 句柄，手动刷新返回 `disabled`，目录提示返回 `scheduled: false`，目录列表不再因任务未注册返回 500。
  - 验证：`perl -e 'alarm 90; exec @ARGV' pnpm --dir apps/host test -- tests/modules/workspace/affairs-library-service.test.ts -t '任务停用时' --reporter=dot`（4 项通过）；事务文档库、诊断仓储和显式扫描联合回归 74 项通过。
  - 风险：停用状态仍保留旧任务快照的 `peek/cancel` 兼容读取，用于识别历史 orphan 状态，但不会访问注册表或入队；若要做到停用时完全不触碰 TaskManager，需要另拆状态来源。重新启用功能时必须同时恢复任务注册和 helper handler。

- [x] 4.3 discovery diagnostics 保留策略与来源区分
  - 状态：DONE
  - 实际修改：`apps/host/src/storage/repositories/session-discovery-diagnostics-repository.ts` 增加按时间和工作区数量清理，并提供插入+清理原子事务；清理每轮最多删除 1000 条，避免膨胀表首次处理长时间占用写锁；`apps/host/src/modules/sessions/session-history-service.ts` 为普通 discovery 和显式扫描写入不同 `trigger_source`，同时按小批次写来源索引；`apps/host/tests/integration/session-source-index-repository.test.ts` 增加保留、来源和批量 upsert 覆盖。
  - 可观察结果：每轮诊断默认只保留最近 30 天且每工作区最多 500 条；普通 discovery 与显式扫描可在 SQLite 中区分；来源索引写入不再为每条记录单独提交事务。
  - 验证：`perl -e 'alarm 120; exec @ARGV' pnpm --dir apps/host test -- tests/modules/workspace/affairs-library-service.test.ts tests/integration/session-source-index-repository.test.ts tests/integration/session-history-background-tasks.test.ts --reporter=dot`（3 个文件、74 项通过）；`pnpm check:sqlite-runtime`；Host 类型检查通过。
  - 风险：清理按当前被扫描工作区触发，旧工作区不会被一次性全局删除；遗留文件空间不会自动 VACUUM，需后续安排低峰期维护。

- [x] 4.4 helper 关闭、取消与进程组回收
  - 状态：DONE
  - 实际修改：新增 `apps/host/src/shared/utils/child-process-lifecycle.ts`，接入任务 helper、provider discovery、Claude/Codex runtime、Git、Tailscale、tmux、conpty、OpenCode probe、OpenCode 托管服务、DeepSeek sidecar、终端日志和 WeChat runtime；`apps/host/src/server/create-server.ts` 并行等待运行时、调度器和独立 helper 的关闭，`packages/session-sync-core/src/runtime/provider-runtime-service.ts` 并行关闭活动运行句柄；任务、provider discovery 和 Git helper 对取消请求保留 request 级未确认状态，取消宽限期未收到结果时只回收对应 detached 进程组。
  - 可观察结果：Abort 先发送 cancel；helper 没有确认时 3 秒后执行 TERM→KILL 并等待退出，已取消请求不会被误判为“远端已结束”；关闭时会同时回收当前 child 与仍被请求引用的旧 child。
  - 验证：`perl -e 'alarm 180; exec @ARGV' pnpm --dir apps/host test -- tests/integration/task-helper-client.test.ts tests/integration/provider-discovery-helper-client.test.ts tests/integration/git-command-helper-client.test.ts tests/modules/tasks/task-helper-client.test.ts tests/modules/tasks/task-helper-pool.test.ts --reporter=dot`（24 项通过）；此前 helper client/pool、provider、Codex、Tailscale、Git 联合回归 26 项通过；Host 类型检查通过。
  - 风险：Windows 不支持负 PID 进程组信号，仍使用单进程回退；非持久 helper 的部分外部命令仍有直接 spawn/kill 路径；已经遗留的 PPID=1 孤儿进程不会被本次代码追溯清理，需重启 Host 或人工处理。

- [x] 4.5 JSONL 半行读取与扫描重试
  - 状态：DONE
  - 实际修改：`packages/session-sync-core/src/providers/utils.ts` 将半行容错限定在 discovery 读取器，并在文件指纹变化时最多重读 3 次；增加 JSONL 与 Kimi 原始尾部物理行读取供严格历史解析；`packages/session-sync-core/src/providers/kimi.ts` 的 discovery 也会按文件指纹重读，详情读取保留完整坏行的结构化错误；Codex/Claude discovery 继续使用容错读取。
  - 可观察结果：追加中的 JSONL 半行不会在 discovery 阶段误报损坏，文件稳定后仍保留完整坏行告警/结构化错误；补齐后下一轮读取可得到完整记录。
  - 验证：`pnpm build`（session-sync-core）；`node --test tests/jsonl-utils.test.mjs tests/kimi-provider.test.mjs`（10 项通过）；Codex/Kimi/JSONL 联合测试（60 项通过）；Host `provider-scan-performance.test.ts` 和 `session-history-helper-read.test.ts`（8 项通过）。
  - 风险：连续高频写入超过 3 次重试仍可能得到不完整快照；严格详情读取遇到真正的半行会报告解析错误，调用方需要依赖下一次增量/显式扫描恢复。

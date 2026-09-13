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
  - 实际修改：新增 `workspace.discovery.explicit_scan`、POST/DELETE `/api/sessions/discovery/scan`、GET `/api/sessions/discovery/status`；任务 key 使用 workspaceId，执行位点声明为 helper_process；Host/helper 均沿用 enabled provider 过滤。
  - 可观察结果：重复点击返回同一任务（deduped），扫描结果继续走现有幂等索引合并逻辑。
  - 验证：Host 类型检查通过；现有后台任务集成测试通过；新增“显式扫描 helper_process + Host 回写”集成测试通过。
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
  - 验证：WorkbenchLayout 扫描/并行按钮顺序专项测试（1 项）通过。
  - 风险：全量 WorkbenchLayout 测试仍较慢，未作为本轮阻断项。

- [x] 3.2 移动端新建会话 Sheet 增加同一动作
  - 状态：DONE
  - 实际修改：`MobileCreateSessionSheet.tsx` 接入统一 MobileSheet/ModalSection、扫描 API 和 i18n 文案。
  - 可观察结果：移动端同样显示扫描中/完成数量/失败状态，重复点击被禁用。
  - 验证：`pnpm --dir apps/user-app exec tsc --noEmit`。
  - 验证：`MobileCreateSessionSheet.test.tsx` 覆盖扫描完成状态及 `targetHostId` 透传。
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
  - 补充验证：`tests/integration/session-routes.test.ts`（6 项）、`tests/integration/session-route-config.test.ts`（2 项）通过；`MobileCreateSessionSheet.test.tsx`（1 项）通过；WorkbenchLayout 扫描/并行按钮顺序专项测试（1 项）通过。
  - 已知风险：WorkbenchLayout 全量组件测试在 180 秒超时保护内未结束；Host 回写仍属于显式任务的收尾阶段，需要后续继续做批量预算优化。

- [ ] 4.2 事务文档库停用时禁止所有任务入队
  - 状态：IN_PROGRESS
  - 实际修改：现有 `apps/host/src/modules/workspace/affairs-library-service.ts` 已统一通过 `enqueueLibraryTask()` 处理配置保存、手动刷新和目录提示入口。
  - 可观察结果：任务停用时不访问 TaskManager 注册表，返回 `disabled` 句柄或 `scheduled: false`，目录列表不再因任务未注册返回 500。
  - 验证：待执行事务文档库服务专项测试。
  - 风险：事务库只读接口仍保留，若后续重新启用任务，必须恢复注册和 helper handler 的成对配置。

- [ ] 4.3 discovery diagnostics 保留策略与来源区分
  - 状态：IN_PROGRESS
  - 实际修改：`session-discovery-diagnostics-repository.ts` 增加按时间和按工作区数量清理；显式扫描使用独立 `trigger_source`。
  - 可观察结果：默认只保留最近 30 天且每工作区最多 500 条诊断，普通 discovery 与显式扫描可在 SQLite 中区分。
  - 验证：待执行仓储和会话 discovery 测试。
  - 风险：历史数据库首次触发清理时可能产生一次较大的 SQLite 删除事务，尚未做分批后台清理。

- [ ] 4.4 helper 关闭、取消与进程组回收
  - 状态：IN_PROGRESS
  - 实际修改：新增 `child-process-lifecycle.ts`，接入任务、provider discovery、Claude/Codex runtime、Git、Tailscale、tmux 和 conpty helper；Host 关闭链路等待 helper 退出。
  - 可观察结果：Abort 会先发送取消消息；关闭先等待 SIGTERM，超时再向 detached 进程组发送 SIGKILL，不再只丢弃 child 引用。
  - 验证：待执行 helper client/pool 和 Host 类型检查。
  - 风险：Windows 不支持负 PID 进程组信号，仍使用单进程回退；外部 CLI 自身若脱离进程组仍需单独处理。

- [ ] 4.5 JSONL 半行读取与扫描重试
  - 状态：IN_PROGRESS
  - 实际修改：`session-sync-core` JSONL 解析跳过末尾未闭合半行；发现扫描读取前后指纹变化时最多重读 3 次。
  - 可观察结果：追加中的 JSONL 不再被误报为损坏记录，下一次读取可重新解析补齐记录；完整坏行仍按原逻辑告警并跳过。
  - 验证：待执行 session-sync-core JSONL 工具测试及 provider 核心测试。
  - 风险：连续高频写入超过重试窗口时仍可能得到不完整快照，需依赖下一次显式扫描或历史增量读取修正。

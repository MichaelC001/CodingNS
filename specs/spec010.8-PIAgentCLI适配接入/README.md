# spec010.8 Pi Agent CLI 适配接入

状态：DONE

这份 Spec 规划把 `@earendil-works/pi-coding-agent` 接入 CodingNS，作为一个新的本地 CLI Provider。

本 Spec 的目标不是把 Pi 改造成 DeepSeek Harness，也不是把 Pi 的所有内部实现搬进 Host，而是把 Pi 已经提供的能力接到 CodingNS 现有的 Provider、会话、权限和前端能力模型中。

当前实测基线：Pi Agent `0.85.1`，本机 Node `22.22.0`。已验证 RPC 启动、状态读取、模型列表、Bash 事件、官方 `RpcClient` 和无 API Key 失败路径。真实模型流式请求尚未验证，因为本机没有可用测试密钥。

本 Spec 直接规划以下范围：

- 新建会话、继续会话、文本/思考/工具事件
- `steer`、`follow_up`、中断
- 模型切换、图片附件
- 会话历史、Fork、Clone、重命名
- 基本 token usage
- Plan 审批基础 UI
- Pi 扩展 UI 到 CodingNS 权限请求的转换
- RPC 兼容的 question 工具
- Plan Mode 扩展加载和审批回传
- 文件附件转提示词或路径协议
- 会话扫描和增量 JSONL 解析
- 删除、归档语义

明确不承诺把 Pi 变成 DSH 的等价替代：Pi 没有 DSH Remote 的事件重放、运行中请求接管、原生 Agent Preset、原生 subagent 和 `session/control` 协议。这些差异必须通过 capability 和 limitations 明确暴露。

## 当前进度（全部任务已完成）

状态：DONE（23 个任务 DONE）

已经落地：

- 核心运行时：`PiRpcClient`（严格 LF JSONL、请求 id、超时、EOF、SIGTERM）、`PiRuntimeAdapter`（新建/继续/steer/follow-up/clear_queue/abort/模型切换）、`PiEventNormalizer`（增量合并、`agent_end` 先收敛状态 + `agent_settled` 才是终态、usage 累计）。
- 附件协议：图片转 image content，小文本内联，大文件/二进制走工作区相对路径；越界路径直接失败。
- 会话文件：`PiSessionJsonlReader`（文件指纹、偏移、尾行缓存、文件替换、未知 entry）和 `PiAdapter`（发现、历史、增量、重命名、删除、归档、Fork/Clone）。
- 扩展：`apps/host/pi-extensions/` 下两个版本固定、只用 select/confirm/input/editor 的受控扩展（question、plan-mode），启动时通过 `--no-extensions --extension <受控路径>` 加载。
- Host：Provider catalog、运行状态探测、后台发现 helper、session history、runtime factory、扩展交互桥全部接入。
- 前端：Pi 会话入口、图标、中英文文案、草稿能力（`queued_guidance`、可中断、可附件、不伪装权限审批）。
- 目录与凭据：Pi 数据按工作区隔离在 `<数据目录>/pi-workspaces/<工作区>/pi-agent`，启动前把用户全局 `auth.json` / `models-store.json` 同步进去。

验证（离线 68 例 + 真实模型 6 场景）：

```bash
pnpm --dir packages/session-sync-core build
node --test --test-timeout=40000 packages/session-sync-core/tests/pi-*.test.mjs   # 68 passed
node scripts/pi-live-smoke.mjs                                                    # 6/6 场景通过
```

真实模型（DeepSeek）已验证：单轮文本 + usage、工具调用归一化、steer、Fork 后继续并继承历史、question 交互、Plan 审批与只读拦截。

本轮补完（原 4 项遗留）：

1. Host 扩展交互桥 integration 用例：`apps/host/tests/integration/pi-extension-ui-bridge.test.ts`（8 例）。
2. 计划审批前端：走 Host 的 `plan_approval` 卡片；会话页新增计划模式开关，发送时带 `permissionMode=plan` → Pi 注入 `PI_PLAN_MODE=1`。
3. 计费与上下文水位：Pi 的费用按 `provider-native` 完整账单落库（含按模型归因）；`readContextUsage` 用真实用量 + 模型库窗口算水位，查不到就返回 null。
4. 真实场景补测：图片附件（自造左红右蓝 PNG，模型答出"红色，蓝色"）、`clear_queue`（返回两条排队文本）；Windows 命令拦截抽成 `plan-mode-rpc/policy.ts` 并补逻辑单测。

仍未闭环：

1. 事务工作台和助手页的 composer 没有接计划模式开关（只接了主会话页）。
2. 计划执行阶段没有单独的视觉样式，回灌消息按普通消息渲染。
3. Windows 拦截只有逻辑单测，没有真机跑过。
4. 真实图片只验证了 PNG；`clear_queue` 只验证了 follow-up 队列。
5. `scripts/pi-live-smoke.mjs` 需要手工触发，没有挂进自动回归。

已知环境限制：

- `apps/host/tests/integration/provider-catalog-routes.test.ts` 的 `catalog 会直接读取启动时缓存的 provider 运行状态` 用例在本机和干净 HEAD 上都失败（文件指纹里的 mtime 小数位差异），属于既有环境相关失败，不是本 Spec 引入的。

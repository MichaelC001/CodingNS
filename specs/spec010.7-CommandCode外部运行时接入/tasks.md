# 任务清单 - spec010.7 Command Code 外部运行时接入

状态：IN_PROGRESS

## 阶段 0：文档与基线

- [x] 0.1 创建 Spec 主文档
  - 状态：DONE
  - 结果：已建立 README、需求、设计、任务和 docs 目录。
  - 验证：文件结构检查、git diff --check。

- [x] 0.2 固定实测基线
  - 状态：DONE
  - 结果：记录 CLI 1.54.0、启动、事件、恢复、fork、中断、权限和 question 测试结果。
  - 验证：本机真实命令回放。

## 阶段 1：适配器实现

- [x] 1.1 实现 CommandCodeRuntimeAdapter
  - 状态：DONE
  - 做什么：封装 spawn、NDJSON、生命周期和终态映射。
  - 结果：ProviderRuntimeService 可启动和继续 Command Code。
  - 依赖：0.2
  - 主要文件：`packages/session-sync-core/src/runtime/command-code-runtime.ts`、测试文件。
  - 不做：不读取私有数据库。
  - 验证：适配器单元测试和真实 CLI 冒烟。
  - 任务结果：已实现 spawn、NDJSON 读取、resume、SIGINT、alive 状态和 0/130 终态；核心包与 Host 类型检查通过。真实 CLI 已验证事件流和中断。

- [x] 1.2 实现 Command Code Provider 历史读取
  - 状态：DONE
  - 做什么：安全读取 command-code JSONL transcript。
  - 结果：会话可发现、分页和恢复。
  - 依赖：1.1
  - 验证：真实 transcript fixture 回放、游标增量和不完整尾行恢复测试通过。
  - 任务结果：已限制 transcript 路径在 `~/.commandcode/projects/` 下，支持会话发现、分页、增量读取、归档、删除和重构式 fork；损坏行保留诊断并跳过。

- [x] 1.3 注册 provider、runtime 和 capability
  - 状态：DONE
  - 做什么：接入 Host catalog、registry、runtime factory。
  - 结果：新建会话类型可选。
  - 依赖：1.1、1.2
  - 验证：Host catalog 集成测试 4/4 通过，user-app Provider UI/Picker/Composer 测试 107/107 通过。
  - 任务结果：已接入 Host catalog、registry、runtime factory、配置、状态检测、历史和会话门控；前端通过统一 provider catalog 和 capability 使用。

## 阶段 2：兼容性验收

- [x] 2.1 验证 plan、question、permission capability
  - 状态：DONE
  - 任务结果：已实测 `--plan`/permission 文档契约、默认 question 禁用、`--tools-enable ask_user_question` 和环境变量启用；headless 自动返回默认选项，不能作为人工 RPC。
- [x] 2.2 验证 SIGINT、resume、fork 和 transcript 增量
  - 状态：DONE
  - 任务结果：已实测 resume、continue、fork、SIGINT（退出码 130）和 JSONL/checkpoint 文件落盘。
- [ ] 2.3 回归 Claude/Codex/OpenCode 相关测试
  - 状态：BLOCKED
  - 阻塞原因：Command Code 相关核心、Host catalog 和 user-app 直接回归已通过；`apps/host/tests/integration/preferences-profile.test.ts` 在 180 秒内未产出测试结果，需单独排查测试清理或启动链路后才能完成该项。

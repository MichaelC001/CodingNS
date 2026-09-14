# 任务清单 - SQLite 写入串行化与会话终态一致性（人话版）

状态：DONE

## 阶段 1：先把写入协调器建起来

- [x] 1.1 新增 Host SQLite 写入队列
  - 状态：DONE
  - 这一步到底做什么：新增一个共享 FIFO 队列，统一处理 busy 重试、耗时记录和失败释放。
  - 做完你能看到什么：服务可以通过一个明确接口提交短 SQLite 写操作。
  - 先依赖什么：无
  - 开始前先看：`requirements.md` 需求 1；`design.md` §2.1、§3.3.1
  - 主要改哪里：`apps/host/src/storage/sqlite/write-queue.ts`、`apps/host/src/storage/sqlite/client.ts`
  - 这一步先不做什么：不改业务表结构，不接入所有低频 CRUD。
  - 怎么算完成：队列 FIFO、有限重试、失败后可继续处理后续任务。
  - 怎么验证：`sqlite-write-queue.test.ts` 已通过，覆盖 FIFO、失败释放和 busy 重试。
  - 对应需求：`requirements.md` 需求 1
  - 对应设计：`design.md` §2.1、§3.3.1、§6.1

- [x] 1.2 把会话运行时和发现批次接入共享队列
  - 状态：DONE
  - 这一步到底做什么：让高频运行时事件、订阅快照和工作区发现批次复用同一个队列，并保持短事务。
  - 做完你能看到什么：这些路径不会在 Host 进程内交错抢写。
  - 先依赖什么：1.1
  - 开始前先看：`requirements.md` 需求 1、2；`design.md` §2.3.1、§6.1
  - 主要改哪里：`apps/host/src/server/create-server.ts`、`apps/host/src/modules/sessions/session-history-service.ts`、`apps/host/src/modules/sessions/session-live-runtime-service.ts`
  - 这一步先不做什么：不把 provider 文件读取放进队列。
  - 怎么算完成：运行时事件（含 Claude 外部 hook）、订阅快照和 discovery 批次都通过共享队列执行，批次之间让出事件循环。
  - 怎么验证：会话运行时定向测试和 Host 类型检查已通过；发现批次调用已接入同一队列。
  - 对应需求：`requirements.md` 需求 1、需求 2
  - 对应设计：`design.md` §2.1、§2.3.1

### 阶段检查

- [x] 1.3 阶段检查
  - 状态：DONE
  - 这一步到底做什么：确认队列没有吞错、死锁或把异步 provider 工作塞进 SQLite 写事务。
  - 做完你能看到什么：可以安全进入终端 writer 改造。
  - 先依赖什么：1.1、1.2
  - 开始前先看：`requirements.md`、`design.md`、`tasks.md`
  - 主要改哪里：阶段 1 相关文件
  - 这一步先不做什么：不扩大到拆分数据库。
  - 怎么算完成：定向测试和类型检查通过，队列观测字段完整。
  - 怎么验证：`pnpm --dir apps/host test -- sqlite-write-queue.test.ts session-live-runtime-service.test.ts`、`pnpm --dir apps/host exec tsc --noEmit` 已通过。
  - 对应需求：`requirements.md` 需求 1、需求 2
  - 对应设计：`design.md` §6.1、§7

## 阶段 2：修复终端日志提交和终态中断

- [x] 2.1 让终端日志提交幂等且不倒退
  - 状态：DONE
  - 这一步到底做什么：用稳定 request ID 重试同一个分段提交，并让文件尾部取最大值。
  - 做完你能看到什么：锁竞争重试不会重复分段或破坏偏移。
  - 先依赖什么：1.3
  - 开始前先看：`requirements.md` 需求 2；`design.md` §2.3.2、§4.1
  - 主要改哪里：`apps/host/src/modules/terminal/runtime/terminal-log-writer-process.ts`、相关测试
  - 这一步先不做什么：不改变正文文件布局。
  - 怎么算完成：重复提交只保留一条 segment，正文与索引一致。
  - 怎么验证：`terminal-log-spooler.test.ts` 定向测试已通过；提交使用稳定 request ID，文件尾部单调更新。
  - 对应需求：`requirements.md` 需求 2
  - 对应设计：`design.md` §2.3.2、§6.2

- [x] 2.2 将 ACTIVE_RUN_NOT_FOUND 处理为幂等终态
  - 状态：DONE
  - 这一步到底做什么：中断请求遇到刚结束的运行时不再返回通用 502，而是同步并返回成功。
  - 做完你能看到什么：重复点击中断不会产生 provider I/O 错误。
  - 先依赖什么：1.3
  - 开始前先看：`requirements.md` 需求 3；`design.md` §5.1、§6.3
  - 主要改哪里：`apps/host/src/modules/sessions/session-live-runtime-service.ts`、相关测试
  - 这一步先不做什么：不修改 provider 中断实现。
  - 怎么算完成：覆盖不存在活动运行、终态运行和 provider 报错三种路径。
  - 怎么验证：`session-live-runtime-service.test.ts` 76 项定向测试已通过；新增分支覆盖 provider 运行不存在的竞态。
  - 对应需求：`requirements.md` 需求 3
  - 对应设计：`design.md` §2.3.1、§6.3

## 阶段 3：验收与回写

- [x] 3.1 并发、SQLite runtime 和类型检查
  - 状态：DONE
  - 这一步到底做什么：运行本轮最小必要验证并记录结果。
  - 做完你能看到什么：锁竞争、重复提交和终态中断都有证据。
  - 先依赖什么：2.1、2.2
  - 开始前先看：`requirements.md`、`design.md`、`tasks.md`
  - 主要改哪里：相关测试和 `docs/` 验收记录
  - 这一步先不做什么：不跑无范围的全量测试，不发布或提交 Git。
  - 怎么算完成：定向测试、类型检查、`pnpm check:sqlite-runtime`、`git diff --check` 全部通过。
  - 怎么验证：`pnpm check:sqlite-runtime`、`pnpm --dir apps/host exec tsc --noEmit`、四个 Host 定向测试文件和 `git diff --check` 均已通过。
  - 对应需求：全部需求
  - 对应设计：`design.md` §7

- [x] 3.2 最终检查点
  - 状态：DONE
  - 这一步到底做什么：确认需求、设计、代码和验证证据一一对应。
  - 做完你能看到什么：Spec 可交接，已知剩余风险明确。
  - 先依赖什么：3.1
  - 开始前先看：当前 Spec 全部文件
  - 主要改哪里：`tasks.md`、验收文档
  - 这一步先不做什么：不追加新范围。
  - 怎么算完成：任务状态、测试结果和剩余风险已回写。
  - 怎么验证：已完成需求、设计、代码和验证证据走查；剩余跨进程锁风险已记录在设计文档 §8.1。
  - 对应需求：全部需求
  - 对应设计：全文

# 任务清单 - 原生依赖跨 Node 版本安装兼容性（人话版）

状态：DONE

## 阶段 1：建立统一运行时入口

- [x] 1.1 创建 Spec 文档并记录现状
  - 状态：DONE
  - 这一步到底做什么：明确问题、范围、设计和验收方式。
  - 做完你能看到什么：`requirements.md`、`design.md`、`tasks.md` 三份文档可以指导后续实现。
  - 怎么验证：人工检查文档和任务依赖。

- [x] 1.2 替换 SQLite 运行时和业务类型导入
  - 状态：DONE
  - 这一步到底做什么：让 Host 与 session-sync-core 加载 libsql，并把业务仓库的旧 SQLite 类型导入改成项目统一入口。
  - 做完你能看到什么：代码中不再直接导入旧 SQLite 包，数据库调用仍保持同步 API。
  - 先依赖什么：1.1
  - 主要改哪里：Host runtime、session-sync-core SQLite adapter、Host repositories、三个 package.json 和 lockfile。
  - 这一步先不做什么：不改 schema、SQL 和 repository 业务逻辑。
  - 怎么验证：`pnpm check:sqlite-runtime`、session-sync-core build、SQLite 相关 Host 测试。

- [x] 1.3 阶段检查：SQLite 主链路
  - 状态：DONE
  - 这一步到底做什么：确认 libsql 在建库、迁移、WAL、事务和查询上站稳。
  - 做完你能看到什么：数据库主链路有测试证据，已知 API 差异已记录。
  - 先依赖什么：1.2
  - 怎么验证：SQLite adapter smoke test 和 Host integration tests。

## 阶段 2：替换 PTY 和删除平台分支

- [x] 2.1 替换 PTY loader
  - 状态：DONE
  - 这一步到底做什么：只加载 `@lydell/node-pty`，保留现有 loader API。
  - 做完你能看到什么：所有 PTY manager、broker 和 helper 使用同一包名。
  - 先依赖什么：1.1
  - 主要改哪里：`node-pty-loader.ts`、PTY manager、Host package.json。
  - 这一步先不做什么：不改变 WebSocket 协议和终端业务流程。
  - 怎么验证：PTY 单元测试、输入输出 smoke test。

- [x] 2.2 移除 Windows 差异和 spawn-helper 修复
  - 状态：DONE
  - 这一步到底做什么：删除旧 fork、winpty fallback、平台版本判断和 chmod 逻辑。
  - 做完你能看到什么：PTY 代码不再出现 `@codingns/node-pty`、官方 `node-pty` 或 Windows Node 22 分支。
  - 先依赖什么：2.1
  - 怎么验证：全文搜索、TypeScript 编译、PTY 相关测试。

- [x] 2.3 阶段检查：PTY 主链路
  - 状态：DONE
  - 这一步到底做什么：确认 shell 启动、写入、resize、退出事件和关闭策略没有回归。
  - 先依赖什么：2.1、2.2
  - 怎么验证：Host terminal runtime 测试和 Node 24/26 smoke test。

## 阶段 3：删除 Node 22 发布链路并验收

- [x] 3.1 删除 Node 22 强制运行和发布 vendor
  - 状态：DONE
  - 这一步到底做什么：移除 node22-runtime、Windows vendor 复制、postinstall native 修复和 onlyBuiltDependencies 旧条目。
  - 做完你能看到什么：构建、测试、发布脚本使用当前 Node，不再复制 Node 22 专用文件。
  - 先依赖什么：1.3、2.3
  - 怎么验证：构建、pack、发布包 tarball 自检。

- [x] 3.2 最终检查点
  - 状态：DONE
  - 这一步到底做什么：逐项核对依赖、源码、发布包和三版本兼容性。
  - 先依赖什么：3.1
  - 怎么验证：`docs/20260915-验收记录.md` 已记录 SQLite/PTY/构建/发布脚本验证；Node 24/26 采用前置 N-API 验证证据，当前验收机没有这两个 Node 可执行文件。

- [x] 3.3 清理旧实现和安装器分支
  - 状态：DONE
  - 这一步到底做什么：删除旧的 `@codingns/node-pty` fork、Node 22 SQLite vendor、Node 22 runtime 脚本和历史测试，并让所有安装入口只使用 `@lydell/node-pty` 与 `libsql`。
  - 做完你能看到什么：workspace、发布脚本、Windows 回放和官网安装入口都不再包含旧包或 Node 22 私有运行时路径。
  - 先依赖什么：3.1、3.2
  - 主要改哪里：`packages/node-pty-fork`、`packages/codingns/vendor-src`、安装脚本、Windows 回放 workflow 与验证器。
  - 这一步先不做什么：不修改数据库 schema、PTY 协议和业务功能。
  - 怎么验证：全库残留检索、三份安装脚本语法检查、发布包测试和 `pnpm install --frozen-lockfile`。

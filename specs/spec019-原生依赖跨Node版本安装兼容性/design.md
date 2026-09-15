# 设计文档 - 原生依赖跨 Node 版本安装兼容性

状态：DONE

## 1. 概述

### 1.1 目标

- 使用 `libsql` 替代 `better-sqlite3`，保留现有同步数据库调用形态。
- 使用 `@lydell/node-pty` 替代官方 `node-pty` 和 CodingNS 私有 fork。
- 删除 Node 22 强制运行、Windows vendor 复制和 postinstall native 修复。

### 1.2 覆盖需求

- `requirements.md` 需求 1、需求 2、需求 3

### 1.3 技术约束

- 后端：TypeScript、NodeNext、Fastify、Vitest
- 数据存储：SQLite 文件、WAL、现有 schema 和迁移
- 外部依赖：`libsql@0.5.29`、`@lydell/node-pty@1.1.0`
- 兼容边界：只依赖两者 npm 发布的预编译平台包，不承诺供应商未覆盖的平台

## 2. 架构

### 2.1 系统结构

Host 和 session-sync-core 的数据库代码继续调用统一适配器；适配器内部加载 `libsql` 并屏蔽 `_metadata` 等兼容差异。终端代码继续调用 `node-pty-loader`，loader 只解析 `@lydell/node-pty`。发布包只保留普通 npm optional dependency 和 Codex 校验，不再复制 native vendor。

### 2.2 模块职责

| 模块 | 职责 | 输入 | 输出 |
| --- | --- | --- | --- |
| Host SQLite adapter | 加载 libsql、暴露 Database 类型、清理结果元数据 | 数据库路径和 SQL | 现有数据库 API |
| session-sync-core SQLite adapter | 为独立包提供同样的 libsql 兼容入口 | 数据库路径和 SQL | core 内部数据库 API |
| PTY loader | 加载并缓存 @lydell/node-pty | 进程环境 | spawn/fork/API |
| 发布脚本 | 校验依赖是否存在和可加载 | package.json、平台 | 明确错误或成功 |

### 2.3 关键流程

#### 2.3.1 SQLite 加载

1. 适配器使用 `createRequire` 加载 `libsql`。
2. 统一导出构造器和数据库类型，业务仓库只从项目入口导入类型。
3. 对 `get/all` 返回值做轻量清理，避免 `_metadata` 改变现有结果结构。

#### 2.3.2 PTY 加载

1. loader 解析 `@lydell/node-pty` 的 package.json 和主入口。
2. 缓存模块、包名和根目录，供诊断使用。
3. 删除平台判断、官方包回退和 spawn-helper chmod 逻辑。

#### 2.3.3 发布安装

1. 发布暂存目录只改写 workspace 依赖版本，不复制 native vendor。
2. postinstall 只校验 Codex 和两个普通 npm 依赖是否可加载。
3. pack 自检确认 package.json、optionalDependencies 和 tar 条目没有旧包名或 Node 22 路径。

## 3. 组件和接口

### 3.1 核心组件

- `apps/host/src/shared/runtime/sqlite-runtime.ts`：Host 的 SQLite 统一入口，内部加载 libsql 并处理兼容差异。
- `packages/session-sync-core/src/sqlite/node-sqlite.ts`：改为 libsql 兼容入口，维持现有导出。
- `apps/host/src/modules/terminal/runtime/node-pty-loader.ts`：只加载 @lydell/node-pty。
- `packages/codingns/scripts/postinstall.mjs`：删除 native vendor 安装和 Node 22 重入。

### 3.2 数据结构

数据库和 PTY 的业务数据结构不变。适配层只允许增加内部类型字段，不改变仓库方法的返回类型。

### 3.3 接口契约

- `loadNodePty()`：返回与现有 node-pty API 兼容的模块；缺失时抛出明确错误。
- `Database` 构造器：接受现有数据库路径和 readonly 选项。

## 4. 数据与状态模型

### 4.1 数据关系

所有 Host repository 共享 Host SQLite adapter 的 `Database` 类型；session-sync-core 通过自己的 adapter 保持独立包边界。运行时二进制由 libsql/@lydell/node-pty 的 optional platform package 解析。

### 4.2 状态流转

| 状态 | 含义 | 进入条件 | 退出条件 |
| --- | --- | --- | --- |
| 未加载 | 尚未解析 native 模块 | 进程启动 | 首次调用 loader |
| 已加载 | native 模块可用 | require 成功 | 进程退出 |
| 加载失败 | 依赖缺失或平台不支持 | require 抛错 | 修复安装后重启 |

## 5. 错误处理

### 5.1 错误类型

- `SQLITE_RUNTIME_MISSING`：libsql 或平台包缺失。
- `PTY_RUNTIME_MISSING`：@lydell/node-pty 或平台包缺失。
- `PTY_START_FAILED`：PTY API 存在但启动失败。

### 5.2 处理策略

安装阶段只给出缺失平台包和安装命令，不尝试运行 npm install、node-gyp 或切换 Node 版本。运行时在适配器入口抛出可定位的错误。

## 6. 正确性属性

### 6.1 属性 1：数据库调用兼容

对于任何现有 schema 和参数绑定，适配器都应保持 `prepare/run/get/all/exec/transaction/pragma` 的同步语义。

### 6.2 属性 2：依赖无编译

对于 Node 22、24、26 的支持平台，安装过程只解析 npm 预编译包，不执行本机 native 编译脚本。

## 7. 测试策略

### 7.1 单元测试

- SQLite adapter 构造、WAL、事务、结果元数据清理。
- PTY loader 包名、缓存和 spawn 输入输出。
- 发布脚本 package.json 改写和 tarball 自检。

### 7.2 集成测试

- Host SQLite bootstrap、repository 相关测试。
- session-sync-core build 和 runtime 测试。
- Host PTY manager、broker 和 terminal runtime 测试。

### 7.3 端到端测试

- 使用 Node 22、24、26 执行最小 SQLite/PTY smoke test。
- `pnpm pack` 后在干净目录安装发布包，检查无 Node 22 vendor 和编译回退。

### 7.4 验证映射

| 需求 | 设计章节 | 验证方式 |
| --- | --- | --- |
| 需求 1 | §2.3、§6.2、§7.3 | 安装日志和三版本 smoke test |
| 需求 2 | §3.1、§6.1、§7.1 | TypeScript 编译、Host/core 测试 |
| 需求 3 | §2.3.3、§7.1、§7.3 | 发布包 tarball 自检 |

## 8. 风险与待确认项

### 8.1 风险

- `@lydell/node-pty` 主要使用 ConPTY，旧 Windows 系统的 winpty fallback 不再保留。
- libsql 与 better-sqlite3 的少数高级 API 不完全一致，需要通过编译和测试确认项目没有调用。
- 当前工作区存在用户未提交修改，实施时只改本 Spec 涉及文件。

### 8.2 待确认项

- 旧于 Windows 10 1809 的系统不在新 PTY 包的支持范围内，按 Out of Scope 处理。

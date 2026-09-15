# 需求文档 - 原生依赖跨 Node 版本安装兼容性

状态：DONE

## 简介

CodingNS 当前直接依赖 `better-sqlite3`、官方 `node-pty` 以及 Node 22 专用 fork。安装时可能触发本机编译，国内网络或缺少编译工具时会失败；已安装依赖还可能因为 Node ABI 版本变化而无法加载。发布包另外维护 Windows Node 22 vendor 和强制运行时，导致维护成本高且无法自然支持 Node 24/26。

本 Spec 将 SQLite 替换为 `libsql`，将 PTY 替换为 `@lydell/node-pty`。两者都通过 optional dependency 提供平台预编译 N-API 二进制，不在用户安装阶段调用 `node-gyp`。业务仓库通过项目内类型和运行时适配入口保持现有调用形态，减少业务 SQL 与终端逻辑改动。

## 术语表

- **N-API**：Node.js 稳定的原生模块 ABI 接口，允许同一二进制跨多个 Node 主版本使用。
- **libsql**：兼容 better-sqlite3 常用 API 的 SQLite 驱动，平台二进制由 npm 包分发。
- **@lydell/node-pty**：使用 N-API 和平台预编译包的 PTY 实现。
- **Host**：`apps/host` 后端服务及其 helper 子进程。

## 范围说明

### In Scope

- 将 Host、session-sync-core 和发布包的 SQLite 运行时改为 `libsql`。
- 将 PTY loader 改为只加载 `@lydell/node-pty`，并移除旧 Windows fork、winpty fallback 和 spawn-helper 权限修复。
- 删除发布包的 Node 22 专用 vendor、postinstall 修复和强制 Node 22 运行时。
- 将业务仓库中的 `import type Database from "better-sqlite3"` 改为项目统一类型入口。
- 增加 Node 22、24、26 的 SQLite/PTY smoke test 和发布包安装验证。

### Out of Scope

- 不改变现有数据库 schema、SQL 语义、事务边界和 WAL 配置。
- 不重写终端业务协议、WebSocket 事件或前端终端交互。
- 不在本 Spec 中支持旧于 `@lydell/node-pty` 官方预编译矩阵之外的 Windows 系统。

## 需求

### 需求 1：安装阶段不编译原生依赖

**用户故事：** 作为使用不同 Node.js 版本和网络环境的开发者，我希望安装依赖时直接获得匹配平台的预编译文件，以便不安装 Visual Studio、Python 或本机 C++ 工具链也能完成安装。

#### 验收标准

1. WHEN 使用 pnpm 安装工作区 THEN 安装日志不触发 `node-gyp rebuild`、`prebuild-install` 的本机编译回退或本地 C/C++ 构建。
2. WHEN 安装 `@jingyi0605/codingns` 发布包 THEN 不再下载或复制 Node 22 专用 SQLite/PTY vendor。
3. WHEN 使用 Node 22、24、26 安装并加载运行时 THEN SQLite 与 PTY native 二进制均能成功加载。

### 需求 2：业务代码保持现有调用语义

**用户故事：** 作为维护业务模块的开发者，我希望替换底层驱动时保留现有 `prepare`、`run`、`get`、`all`、`transaction`、`pragma` 和 `spawn` 调用，以便不重写大量业务逻辑。

#### 验收标准

1. WHEN 编译 Host 和 session-sync-core THEN 不再依赖 `better-sqlite3` 的类型声明包，所有数据库类型来自项目统一入口。
2. WHEN 执行现有仓库测试 THEN schema、迁移、事务、WAL、查询结果和终端输入输出行为与替换前一致。
3. WHEN `libsql` 返回额外元数据字段 THEN 适配层不会把 `_metadata` 泄漏到现有业务结果对象。

### 需求 3：删除 Node 22 和 Windows 特殊链路

**用户故事：** 作为发布维护者，我希望发布脚本只描述真实依赖和平台包，以便新 Node 主版本不需要新增一套 vendor 和强制运行时逻辑。

#### 验收标准

1. WHEN 执行构建、测试、打包脚本 THEN 不会切换或要求 Node 22。
2. WHEN Host 启动 PTY THEN 统一走 `@lydell/node-pty`，不再根据 Windows/Node 版本选择 `@codingns/node-pty` 或官方 `node-pty`。
3. WHEN 运行发布包自检 THEN 包内不包含 Node 22 vendor、winpty fork 或旧 spawn-helper 权限修复脚本。

## 非功能需求

### 非功能需求 1：兼容性

1. Node 22、24、26 在 macOS、Linux 和 Windows（以供应商预编译矩阵为准）均可完成安装和运行时 smoke test。

### 非功能需求 2：可维护性

1. 新增 SQLite 或 PTY 调用必须经过项目适配入口，不允许重新直接引入已删除的包名。
2. 发布包校验脚本必须能明确报告依赖包名、平台和 native 文件缺失原因。

## 成功定义

- 工作区和发布包不再声明 `better-sqlite3`、官方 `node-pty`、`@codingns/node-pty` 或 Node 22 vendor。
- `pnpm check:sqlite-runtime`、Host 相关测试、session-sync-core 构建和发布包 pack/install 验证通过。
- Node 24 和 Node 26 的 SQLite/PTY smoke test 通过，安装日志无本机编译回退。

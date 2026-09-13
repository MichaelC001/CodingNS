# 设计文档 - spec002.1.2 会话索引与显式扫描

## 1. 总体数据流

```text
普通列表 → session_index_repository.listByWorkspace → 返回摘要

新建会话 → provider.startSession → Host 事务写入 binding/index → 返回新会话

手动扫描 → workspace.discovery.scan(helper_process) → 合并写入 binding/index → 推送结果

打开会话 → session history helper → 首屏分页 → 虚拟会话按需加载
```

## 2. 创建会话

`SessionHistoryService.startSessionDirect` 在 provider 原生会话创建成功后，使用一个 SQLite 事务写入 binding、index 和初始状态快照。创建流程不调用 `discoverWorkspaceSessions`。

## 3. 列表与扫描

`GET /api/sessions` 只调用 `listWorkspaceSessions`。显式扫描使用新的 `workspace.discovery.explicit_scan` 任务，key 为 `workspaceId`，执行位点为 `helper_process`。扫描入口校验工作区和启用 provider，helper 再次过滤 provider。

## 4. 扫描合并

扫描结果按 `(workspaceId, provider, providerSessionId)` 幂等 upsert。已有 Host 会话保留用户侧标题、归档、收藏和绑定关系；外部发现会话只补齐来源和摘要。扫描失败保留旧索引并返回错误状态。

## 5. 前端交互

新建会话桌面弹窗和移动端 Sheet 共用“扫描当前工作目录会话”动作。按钮显示扫描中、完成数量和失败提示；关闭弹窗不取消已开始的扫描。普通打开工作区不显示扫描进度，也不触发扫描。

## 6. 兼容与风险

- 旧版本已有索引继续可读，不强制首次启动迁移扫描。
- 用户主动扫描是唯一恢复外部历史会话的入口。
- provider 原生会话创建失败时不得写入伪造成功记录。
- 全量扫描仍可能较重，但被限制为显式、可取消、可去重的 helper 任务。

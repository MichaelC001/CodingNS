# 需求文档 - spec010.7 Command Code 外部运行时接入

状态：IN_PROGRESS

## 目标

让 Command Code 作为独立会话类型进入现有 provider/runtime 体系，不新增前端特判，不依赖其未公开内部 API。

## 范围

- 新增 providerId `command-code`
- 启动、继续、恢复、分叉、终止
- NDJSON AgentEvent 解析与文本/工具事件映射
- JSONL transcript 受控读取
- plan、permission、ask_user_question capability 声明
- 真实 CLI 夹具和兼容性测试

## 首版不做

- 不伪造官方 SDK/server 主链路
- 不承诺 headless 人工等待式问答；headless question 仅支持自动默认结果
- 不把 diff、todo、sub-session 做成可编辑 UI

## 验收标准

1. Provider 可通过现有注册机制发现并启动。
2. NDJSON 未知事件可安全忽略且保留原始事件。
3. `--continue`、`--resume`、`--fork-session`、SIGINT 均映射到统一状态。
4. 默认权限、plan、auto-accept、yolo 的 capability 与终态准确表达。
5. ask_user_question 在启用工具后可完成工具调用并继续模型回合。
6. transcript 路径限制在 `~/.commandcode/projects/` 下，并支持游标增量读取。
7. 现有 Claude/Codex/OpenCode 测试不回归。

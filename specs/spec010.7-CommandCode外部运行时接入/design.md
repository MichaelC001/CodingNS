# 设计文档 - spec010.7 Command Code 外部运行时接入

## 1. 总体方案

新增 `CommandCodeRuntimeAdapter`，通过 `spawn(command-code, args)` 启动外部进程；stdout 按行解析 NDJSON，stderr 仅作诊断；Host 继续使用现有 `ProviderRuntimeService` 和 `SessionLiveRuntimeService`。

## 2. 会话生命周期

- 新建：`cmd -p <prompt> --output-format json --skip-onboarding`（Command Code 的 `json` 输出本身是 NDJSON 事件流，最后追加一行结果）
- 继续：追加 `--continue`
- 恢复：追加 `--resume <sessionId>`
- 分叉：追加 `--fork-session`
- 中断：发送 SIGINT，退出码 130 归一化为 `interrupted`

## 3. 事件映射

保留 `run_start/run_end`、`turn_*`、`model_request_*`、`thinking_*`、`text_delta`、`message_*`、`tool_*`、`permission_mode_changed`、`subagent_*` 原始 payload；公共模型只消费已知事件，未知事件不阻塞。

## 4. 问题与计划

`--plan` 是只读计划模式；交互模式支持 plan review。`ask_user_question` 必须通过 `--tools-enable ask_user_question` 或环境变量启用。headless 默认答案由 CLI UI bridge 自动给出，不能宣称支持外部人工 RPC。

## 5. 历史

只读取 `~/.commandcode/projects/<project-slug>/<session-id>.jsonl`，做路径归属校验、损坏行跳过和增量 cursor；不依赖其他私有目录。

## 6. 风险

CLI 版本升级可能改变事件字段和 transcript schema；通过版本记录、真实 fixture、未知事件兼容和专项回归控制。

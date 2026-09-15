# spec010.8 Pi Agent CLI 适配接入

状态：IN_PROGRESS

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

# spec010.6：Grok Build 外部运行时接入

状态：Draft

## 这份 Spec 要解决什么

把 xAI 发布的 Grok Build（命令名 `grok`）作为一个可选的 CodingNS Provider 接入。
用户仍然从 CodingNS 会话工作台创建、发送和查看会话，Grok 负责自己的 Agent 执行、文件操作和终端工具。

首版使用 Grok 官方的 Agent Client Protocol（ACP，Agent 客户端协议）stdio 入口，不复制 Grok 的 Rust 源码，也不把它误当成普通模型 API。

## 主要文档

- [需求文档](./requirements.md)：要交付什么，以及明确不做什么。
- [设计文档](./design.md)：模块边界、ACP 消息、权限边界和错误处理。
- [任务清单](./tasks.md)：按阶段拆开的可执行任务，每完成一步必须回写状态。
- [协议与版本基线](./docs/20260910-GrokBuild协议与版本基线.md)：本 Spec 采用的上游资料、版本和验证边界。

## 交付边界

第一阶段先做可验证的本地 ACP 会话：命令探测、握手、创建/加载会话、提示词、流式文本、思考、工具事件、完成和中断。

权限请求、历史扫描、原生 Fork、附件和 Windows 进程行为必须分别验证；未验证的能力不在能力矩阵中开启。

## 不做什么

- 不把 Grok 源码合并到 CodingNS。
- 不让前端直接连接 Grok 进程。
- 不把 `--always-approve` 描述成 CodingNS 已经接管了权限审计。
- 不按 Grok 应用版本硬编码拒绝未知运行时；先按 ACP 握手和能力降级。

# spec010.7 Command Code 外部运行时接入

状态：IN_PROGRESS

这份 Spec 记录把 Command Code CLI 接入 CodingNS 的完整方案。首版通过外部 CLI 进程、NDJSON 事件流和 JSONL transcript 接入，不依赖未公开的 SDK 或 server。

当前实测基线：Command Code 1.54.0；已验证启动、实时事件、continue、resume、fork、SIGINT（退出码 130）、默认权限拒绝、--yolo 写入和 ask_user_question（需启用工具）。

# Spec 019：原生依赖跨 Node 版本安装兼容性

本 Spec 解决 CodingNS 在不同 Node.js 版本安装失败的问题。核心做法是把 SQLite 和 PTY 统一切换到安装时不编译、通过 npm 分发预编译 N-API 二进制的包，并删除项目内围绕 Node 22 和 Windows 私有 native 包建立的特殊链路。

主文档：

- `requirements.md`：要达到的安装、运行和兼容性结果
- `design.md`：依赖、代码和发布链路如何调整
- `tasks.md`：按顺序执行的任务和验证记录


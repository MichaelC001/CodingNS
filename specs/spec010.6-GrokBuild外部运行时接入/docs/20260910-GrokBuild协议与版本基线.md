# Grok Build 协议与版本基线

状态：已记录，并已通过 macOS arm64 真实 Grok CLI 与自定义 endpoint 的最小 ACP 回放重新确认

## 1. 资料来源

- 仓库：[xai-org/grok-build](https://github.com/xai-org/grok-build)
- README：[Grok Build README](https://github.com/xai-org/grok-build/blob/main/README.md)
- ACP/Agent mode：[15-agent-mode.md](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md)
- Headless：[14-headless-mode.md](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md)
- Authentication：[02-authentication.md](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md)
- Sessions：[17-sessions.md](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/17-sessions.md)

## 2. 当前上游版本

本轮分析读取的 `main` 提交：

- Git commit：`37949780c144e37df692e3d669051a21fec24f20`
- Source revision：`c4ea71cfdbcdb21e32e41bc25a0043d7d4836714`
- 仓库许可证：Apache-2.0；仓库说明源码定期从 SpaceXAI monorepo 同步，根 `Cargo.toml` 为生成文件。

这两个 revision 只用于本轮 Spec 的分析基线。正式实现前必须重新执行 `grok --version`、ACP 握手和契约测试，不能只相信仓库 `main` 的文档。

## 3. 官方支持的接入入口

### 3.1 ACP stdio

官方文档给出的本机 SDK/IDE 接入命令为：

```bash
grok agent --always-approve stdio
```

本 Spec 计划在本地独立进程模式下补充 `--no-leader`：

```bash
grok agent --no-leader --always-approve stdio
```

`--no-leader` 是否在目标发布版本上可用，必须由实现阶段的 CLI 探测和 fake/真实最小握手确认。

ACP 基础生命周期：

1. `initialize`
2. `session/new` 或 `session/load`
3. `session/prompt`
4. 接收 `session/update`
5. 根据 ACP 取消契约中断，或在超时后回收进程

官方文档列出的 `session/update.sessionUpdate` 类型包括：

- `agent_message_chunk`
- `agent_thought_chunk`
- `tool_call`
- `tool_call_update`
- `plan`

`session/new` 和 `session/load` 会返回 `configOptions`，官方文档明确记录 `model` 和 `reasoning_effort` 两类配置选项。

### 3.2 Headless

Grok 还支持：

```bash
grok -p "prompt" --output-format streaming-json
```

该模式可以得到 text、thought、tool_call、usage、end 和 error 等 NDJSON 事件，但它是单轮进程模型，不提供 ACP stdio 的完整双向会话能力。本 Spec 只把它作为排障或降级方案，不作为主接入路径。

## 4. 认证资料

官方文档记录的认证方式包括：

- `XAI_API_KEY`
- 浏览器 OAuth，凭据默认位于 `~/.grok/auth.json`
- device auth
- OIDC
- external auth provider

CodingNS 规则：

- `auth.json` 和 MCP 凭据不能复制进共享目录、数据库或日志。
- 命令存在不代表认证可用，安装状态和认证状态分开报告。
- `GROK_HOME` 的最终目录策略需在实现阶段确认，优先使用用户私有目录。

## 5. 会话存储资料

官方文档记录会话默认位于：

```text
$GROK_HOME/sessions/<encoded-cwd>/<session-id>/
  summary.json
  updates.jsonl
  chat_history.jsonl
  plan.json
  signals.json
```

这些文件目前只能视为 Grok 本地实现细节：

- 首版只解析 CodingNS 已绑定的 Grok session；
- 不自动扫描并导入全部陌生 session；
- `updates.jsonl` 的字段变化必须通过 fixture 和真实版本回放发现；
- CodingNS 使用 `grok://session/...` 受控引用，不把本机路径直接返回给用户。

## 6. 权限和工具边界

官方文档说明 Grok 自己管理文件、终端、MCP 和工具权限。`--always-approve` 适合自动化，但它不会自动接入 CodingNS 的权限请求服务。

因此分两步：

1. 受控 MVP：明确声明权限由 Grok 处理，CodingNS 的 `supportsPermissionPrompt` 和 `supportsPermissionRequests` 保持关闭。
2. 生产权限桥接：锁定真实 ACP server-request 方法和字段后，再将权限请求映射到 CodingNS 现有权限服务；无法识别的请求必须 fail closed。

实现阶段只声明真正实现的 ACP client capabilities。不能为了让 Grok “看起来完整”而声明 CodingNS 尚未处理的 fs、terminal 或权限能力。

## 7. 当前不确认的协议项

以下内容不能仅凭当前文档直接开启：

- ACP 取消请求的最终方法名和参数。
- `session/request_permission`、fs、terminal、user input server request 的实际字段。
- `x.ai/session/fork` 在目标版本上的稳定性。
- token usage 与 `signals.json` 的可靠累计语义。
- Windows 下 `grok.exe` 的进程树回收和信号行为。

这些项目必须由实现阶段的 fake ACP 契约测试、真实最小握手和平台验证分别确认。

## 8. 版本兼容原则

- 应用版本用于诊断，不作为唯一能力门禁。
- ACP protocol version、initialize capabilities 和已验证方法集合用于能力判定。
- 未知版本保留 Provider 目录项；安全读取可以继续，未经验证的写操作进入 `degraded` 或 `read-only`。
- 上游文档、CLI 版本和实际握手结果不一致时，以实际握手和契约测试为准，并回写本文件。

## 9. 2026-09-10 真实回放结果

本轮在 macOS arm64 的隔离临时工作区执行，真实 CLI 版本为：

```text
grok 1.0.25 (f7e67d6988e2)
```

启动参数为：

```text
grok agent --no-leader --always-approve --xai-api-base-url <自定义地址> stdio
```

结果：

- `initialize`：成功，协议版本 `1`。
- `session/new`：成功，返回 Grok session id。
- `session/prompt`：成功，返回 `stopReason` 和 `_meta`。
- `session/update`：收到真实文本更新及其他状态通知。
- `session/load`：成功，返回 `models`、`configOptions` 和 `_meta`。
- `session/cancel`：真实版本返回 `Method not found`，中断能力保持关闭，不能宣称已支持。

认证信息使用 Grok 标准环境变量 `XAI_API_KEY`，只保存在本机用户私有的
`~/.grok/api-env`（权限 `600`）；未写入仓库、SQLite、会话消息或验收文档。

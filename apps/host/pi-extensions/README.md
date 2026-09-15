# CodingNS 的 Pi Agent 受控扩展

这个目录放的是 CodingNS 自己维护的 Pi Agent 扩展。它们由 Host 用 `pi --mode rpc` 子进程方式加载，
和 Pi 官方示例扩展不是一回事。

目录：

```
apps/host/pi-extensions/
├── README.md                  ← 你正在看的这份说明
├── question-rpc/index.ts      ← question 工具：让模型向用户提问
└── plan-mode-rpc/index.ts     ← 只读计划模式 + 计划生成后的下一步选择
```

## 这两个扩展是干什么的

### question-rpc

给模型一个 `question` 工具。模型需要用户拍板时调用它，用户在 Host 界面上从选项里挑一个，
或者选择「其他（手动输入）」后自己敲一段文字。结果会作为工具返回值回到模型上下文，
模型接着往下干。

参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `question` | 是 | 要问的问题 |
| `options` | 是 | 选项数组，每项是 `{ label, description? }`，1 到 8 个 |
| `allowFreeform` | 否 | 是否允许手动输入，默认 `true` |

返回值里 `details` 固定带 `{ question, options, answer, wasCustom }`，Host 可以直接拿去渲染。

### plan-mode-rpc

只读计划模式。开启之后：

- `edit`、`write` 被拦下，模型收到的是「计划模式下不允许修改」这个结果，而不是报错。
- 会改动状态的 bash 命令（`rm`、`mv`、`> file`、`git commit`、`npm install` 之类）被拦下。
- `read`、`grep`、`find`、`ls` 和只读 bash（`rg`、`git log`、`cat`…）照常可用。
- 模型输出计划后，弹一个选择框：`执行计划 / 继续完善计划 / 修改计划 / 取消`，
  用户的选择会作为一条用户消息回到会话，模型据此继续。
  选「执行计划」后写权限恢复，模型开始落地；选「取消」或直接关掉选择框就退出计划模式。

开启方式（两条路都行，CLI 参数优先）：

```bash
# 方式一：启动参数
pi --mode rpc --no-extensions \
  --extension /abs/path/apps/host/pi-extensions/plan-mode-rpc/index.ts \
  --plan

# 方式二：环境变量（Host 不方便加参数时用）
PI_PLAN_MODE=1 pi --mode rpc --no-extensions \
  --extension /abs/path/apps/host/pi-extensions/plan-mode-rpc/index.ts
```

会话里也能改：`/plan` 开关计划模式，`/plan-status` 看当前状态。
用 `/plan` 切换过的状态会写进会话，恢复会话时以会话里的记录为准，不会被启动参数重新打开。

## 为什么不能用官方示例里的 TUI 版本

官方示例 `examples/extensions/question.ts` 和 `examples/extensions/plan-mode/` 都是给交互式终端写的，
在 RPC 模式下会直接坏掉：

1. 官方 question 靠 `ctx.ui.custom()` 自己画整屏界面。RPC 模式下 `ctx.ui.custom()`
   在源码里就是 `async custom() { return undefined; }`，调用结果永远是 `undefined`，
   界面画不出来，工具也拿不到答案。
2. 它和 plan-mode 示例都 `import { Key, Editor, Text } from "@earendil-works/pi-tui"`。
   这些组件要挂在 TUI 的渲染循环上才有意义，走 stdout 的 JSON 协议时没有任何地方能渲染它们。
3. 官方 plan-mode 还用了 `ctx.ui.theme.fg(...)` 拼彩色状态栏。RPC 下这些 ANSI 转义
   只是一串乱码字符，Host 还得自己剥掉，不如不发。
4. 官方 plan-mode 用 `Key.ctrlAlt("p")` 注册快捷键，RPC 模式没有键盘输入通道。

所以这里的两个扩展只用 RPC 协议真正支持的四种对话框：`select`、`confirm`、`input`、`editor`。
这四种会被 Pi 转成 stdout 上的 `extension_ui_request`，Host 回 `extension_ui_response`；
`notify`、`setStatus`、`setWidget` 是单向通知，Host 收到就行，不需要回包。

## 怎么加载

Host 启动 Pi 时显式指定扩展路径，同时用 `--no-extensions` 关掉自动发现，
避免用户机器上装的别的扩展混进来：

```bash
pi --mode rpc --no-extensions \
  --extension /abs/path/apps/host/pi-extensions/question-rpc/index.ts \
  --extension /abs/path/apps/host/pi-extensions/plan-mode-rpc/index.ts
```

两个扩展互不依赖，可以只加载其中一个。

## 写这两个扩展时的硬约束

1. **扩展是源码，不编译。** Pi 用 jiti 直接加载 `.ts`，仓库里没有构建步骤，
   Host 也不需要为它们加 tsconfig 或打包配置。
2. **不引第三方依赖，不引仓库内相对导入。** 只能 import 两种东西：
   - `typebox`（提供参数 schema 的 `Type`）
   - `@earendil-works/pi-coding-agent` 的类型

   这两个由 Pi 运行时提供，扩展自己不带 `node_modules`。
   类型导入统一写成 `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`，
   避免运行时去解析一个其实用不到的模块。
3. **交互只用 select / confirm / input / editor。** 不要碰 `ctx.ui.custom()`，
   也不要 import `@earendil-works/pi-tui`。
4. **不要抛异常。** 用户取消、Host 回包异常、没有 UI，统统转成正常的工具返回值或通知，
   不能让一次 turn 因为扩展挂掉。
5. **注释写「为什么」。** 接手的人第一眼要能看懂这里为什么绕开了官方做法。

## 版本锁定

这两个扩展是按 **Pi Agent 0.85.1**（`@earendil-works/pi-coding-agent@0.85.1`）的扩展 API 写的：

- 用到的方法：`pi.registerTool`、`pi.registerCommand`、`pi.registerFlag`、`pi.getFlag`、
  `pi.appendEntry`、`pi.sendMessage`、`pi.sendUserMessage`、`pi.getAllTools`、`pi.on(...)`。
- 用到的事件：`session_start`、`input`、`tool_call`、`before_agent_start`、`agent_settled`。
- 用到的 UI 能力：`ctx.ui.select`、`ctx.ui.input`、`ctx.ui.notify`、`ctx.ui.setStatus`、`ctx.ui.setWidget`。

Pi 升级到 0.86 及以上之前，必须先确认上面这些方法、事件和 RPC 与对话框协议没有改名或改语义，
尤其这几点最容易变：

- `agent_settled` 是不是还在（计划模式靠它判断「模型这一轮真的结束了」）。
- `tool_call` 的 `{ block, reason }` 返回值语义。
- `sendUserMessage()` 在流式期间必须带 `deliverAs` 这条规则。
- `pi.getFlag()` 在 `session_start` 时能否读到 `--plan` 的值。

结论：**跟随 Pi 0.85.1，不追新版**。要升级就单独开一次升级验证，别顺手升。

## 怎么验证这两个扩展

最小验证（能加载 + 命令注册上了 + 工具注册上了）：

```bash
cd /tmp && mkdir -p pi-ext-check && cd pi-ext-check && \
HOME=/tmp/pi-ext-check PI_CODING_AGENT_DIR=/tmp/pi-ext-check/agent \
/opt/homebrew/bin/pi --mode rpc --no-extensions \
  --extension /Users/jackson/Code/CodingNS/apps/host/pi-extensions/question-rpc/index.ts \
  --extension /Users/jackson/Code/CodingNS/apps/host/pi-extensions/plan-mode-rpc/index.ts \
  --session-dir /tmp/pi-ext-check/sessions --offline <<< '{"type":"get_commands","id":"c1"}'
```

期望看到 `plan`、`plan-status` 两条 extension 命令，stdout/stderr 里没有报错。
`get_commands` 只列命令不列工具，想确认工具注册情况可以在会话里发 `/probe-tools`
（需要临时挂一个打印 `pi.getAllTools()` 的扩展），期望能看到 `question` 和 `plan_mode_status`。

确认没有 TUI 依赖：

```bash
grep -n "pi-tui\|ui.custom\|@earendil" \
  /Users/jackson/Code/CodingNS/apps/host/pi-extensions/question-rpc/index.ts \
  /Users/jackson/Code/CodingNS/apps/host/pi-extensions/plan-mode-rpc/index.ts
```

只应该出现 `@earendil-works/pi-coding-agent` 的类型导入。

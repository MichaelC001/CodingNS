# 任务清单 - spec001.9 公共隧道服务接入与端到端加密远程访问（人话版）

状态：IN_PROGRESS（2026-09-16 按 WebRTC 承载层改版）

## 2026-09-16 改版说明

**这一版把承载层从「WSS 盲中继 + 自研端到端加密」换成「WebRTC DataChannel」。**

为什么换，看 `docs/20260916-WebRTC承载层验证结论.md`。一句话：

- 自研加密那套（x25519 + HKDF + AES-GCM + 握手 proof + 加密帧）太重，
  658 行代码在 `apps/host`、`apps/user-app`、`relay-edge` 三处各存一份，其中一份已是死代码
- WebRTC 的 DTLS 本身就是端到端加密，信令服务器和 TURN 都拿不到密钥
- P2P 直连能省掉中继带宽成本

### 换完以后作废的工作

| 原方向的工作 | 处置 | 原因 |
| --- | --- | --- |
| 自研端到端加密协议（握手、密钥派生、加密帧） | **作废并删除** | DTLS 原生提供 |
| Host 挑战应答与公钥指纹登记 | **作废并删除** | 改用 SDP 里的 DTLS 指纹 |
| base64 + JSON 信封 | **作废并删除** | DataChannel 直接收发二进制 |
| 会话实例亲和与共享状态粘性 | **作废** | P2P 连接不需要会话粘在某个中继实例上 |
| relay-edge 密文帧中继 | **替换** | 由信令服务器 + coturn 接替 |
| 按流量计费与超额断流 | **替换** | P2P 打通后网络层无法计量，改固定订阅 |

### 继续有效的工作（控制面这套不用重做）

上一版已经落地、并且这一版继续沿用的能力：

| 能力 | 现状 |
| --- | --- |
| 独立子仓库分仓与主仓库忽略策略 | 已落地，`apps/codingns-proxy/` |
| 账号体系（注册、登录、验证码、管理员通路） | 已落地，完全保留 |
| Host 绑定与解绑 | 已落地，保留但去掉三级域名强绑定 |
| 实例级配置与状态存储、状态机、未初始化阻断 | 已落地，保留（状态枚举要调整） |
| 后台任务接入统一 `TaskManager` | 已落地，保留，新增信令连接任务 |
| 设置页「远程访问」provider 化 | 已落地，保留，新增链路类型展示 |
| 订单 / Paddle 支付骨架 | 已落地，语义从「流量包」改「周期订阅」 |
| 数据库迁移体系、部署脚本、控制台站点 | 已落地，保留 |

原 WSS 方案的逐条任务记录见 git 历史，这里不再整体保留，避免误导后来的人。

## 这份文档是干什么的

这份任务清单只负责把「公共隧道承载层切换到 WebRTC」拆成能执行、能验收的步骤。

要求还是那六个老问题：

1. 这一步到底做什么
2. 做完以后能看到什么结果
3. 依赖什么
4. 主要改哪些文件
5. 这一步明确不做什么
6. 怎么验证

## 状态说明

- `TODO`：还没开始
- `IN_PROGRESS`：正在做
- `BLOCKED`：被外部问题卡住
- `IN_REVIEW`：已有结果，待复核
- `DONE`：完成并验证
- `CANCELLED`：取消并写原因

规则：

- 只有 `状态：DONE` 的任务才能勾成 `[x]`
- 每做完一个任务，都要立刻回写这份文档
- `BLOCKED` 和 `CANCELLED` 必须写清楚原因

---

## 阶段 W0：先把选型和边界确认掉

- [x] W0.1 固化 WebRTC 承载层验证结论
  - 状态：DONE
  - 这一步到底做什么：把 demo 里的实测数据（可靠性、吞吐、踩过的坑）写成正式结论文档，作为改版的依据
  - 做完以后能看到什么结果：后续讨论不用再回到聊天记录里找数字
  - 依赖什么：无
  - 主要改哪些文件：
    - `specs/spec001.9-公共隧道服务接入与端到端加密远程访问/docs/20260916-WebRTC承载层验证结论.md`
  - 这一步明确不做什么：不改任何产品代码
  - 怎么验证：
    - 文档走查
  - 验证结果：
    - 已落库。包含：node-datachannel 接收侧不可靠（3/16）出局、werift 可用（11/11）、
      werift 上行 3–6 MB/s 下行 21–31 MB/s、分片与水位调优无效、多 DataChannel 无效、
      STUN 必需、PeerConnection 必须进程隔离

- [x] W0.2 确认 Host 侧接入进程的形态
  - 状态：DONE
  - 这一步到底做什么：定清楚 WebRTC 接入进程怎么跑、和主进程怎么通信、崩了怎么拉起
  - 做完以后能看到什么结果：有一份明确的进程模型说明，后面写代码不用现拍
  - 依赖什么：W0.1
  - 主要改哪些文件：
    - `specs/spec001.9-公共隧道服务接入与端到端加密远程访问/design.md`
    - `docs/20260916-Host接入进程模型.md`（新增）
  - 这一步明确不做什么：不写代码
  - 怎么验证：
    - 方案评审，重点确认「PeerConnection 必须隔离」这条怎么落实
  - 验证结果：
    - 已落库 `docs/20260916-Host接入进程模型.md`
    - 定下：主进程管配置 / 状态 / 设置页，werift PeerConnection 全部跑独立子进程；
      IPC 只传控制信号不传业务数据；崩溃按 1/2/4/8/16s 退避拉起，上限 30s，连续 5 次失败置 `error`；
      重启后主进程重新下发配置；不做多进程池
    - 后台任务命名沿用 `spec001.2` 规范：`webrtc.peer_supervise`、`relay_tunnel.state_refresh`、`relay_tunnel.usage_report`

- [x] W0.4 补一轮 Host 侧实现交替 A/B 实测并拍板
  - 状态：DONE
  - 这一步到底做什么：把 libdatachannel 与 werift 在 5 MB / 20 MB 两档上交替跑，各 5 轮，用失败率和 Host 侧实测吞吐决定选谁
  - 做完以后能看到什么结果：Host 侧实现不再有悬念，后面写接入层不用再摇摆
  - 依赖什么：W0.1
  - 主要改哪些文件：
    - `apps/codingns-proxy/local/webrtc-datachannel-demo/ab-bench.mjs`（新增）
    - `apps/codingns-proxy/local/webrtc-datachannel-demo/public/index.html`（补机器可读结果导出）
    - `specs/spec001.9-公共隧道服务接入与端到端加密远程访问/docs/20260916-Host侧WebRTC实现A-B定论.md`（新增）
  - 这一步明确不做什么：不再调分片 / 水位 / 多通道参数
  - 怎么验证：
    - `node ab-bench.mjs --mb=5,20 --rounds=5`
    - 只认 Host 侧打点吞吐，页面侧数字不计入
  - 验证结果：
    - **werift 10/10 通过（0% 失败），上行平均 11.12 MB/s，下行平均 28.32 MB/s**
    - **node-datachannel 6/10 通过（40% 失败），失败全部是 ICE 从 completed 直接跳 failed**
    - 结论：**Host 侧固定 werift，node-datachannel 不进生产依赖**
    - 原始数据：`apps/codingns-proxy/local/webrtc-datachannel-demo/ab-bench-result.json`

- [x] W0.3 确认计费模型切换范围
  - 状态：DONE
  - 这一步到底做什么：把「按流量」改成「固定订阅」涉及的控制面改动列清楚，尤其是存量订单、套餐、流量账本怎么办
  - 做完以后能看到什么结果：知道要改哪些表、哪些接口、哪些页面，存量数据怎么迁移
  - 依赖什么：无
  - 主要改哪些文件：
    - `specs/spec001.9-公共隧道服务接入与端到端加密远程访问/docs/20260916-计费模型切换范围.md`（新增）
  - 这一步明确不做什么：不在这一步写迁移脚本
  - 怎么验证：
    - 文档走查 + 与现有控制面代码对照
  - 验证结果：
    - 已落库 `docs/20260916-计费模型切换范围.md`
    - 核对了控制面真实代码后逐条列出：10 张要动的表（含 `traffic_wallets`、`traffic_orders`、
      `traffic_grants`、`activation_codes`、`relay_usage_events` 等）、11 个要动的接口、
      7 个要动的控制台页面、3 项配置
    - 点明了必须删掉的断流执行点：`/api/internal/relay/sessions/authorize` 里的
      `QUOTA_EXHAUSTED` 拒绝（`app.ts` 第 1983 行附近）
    - 存量数据处理逐条定了口径：剩余流量折算订阅周期、激活码改兑换订阅时长、
      历史订单与用量原样保留只做展示；迁移脚本要求幂等且可重复执行
    - 明确不做的范围：团队套餐、阶梯价、自动续费扣款重试、重写 Paddle 接入

---

## 阶段 W1：Host 侧 WebRTC 接入层

- [x] W1.1 搭起 Host 侧 WebRTC 接入进程骨架
  - 状态：DONE
  - 这一步到底做什么：新建独立进程，用 werift 建立 PeerConnection，接受客户端 DataChannel
  - 做完以后能看到什么结果：浏览器能通过 DataChannel 连上这个进程
  - 依赖什么：W0.2
  - 主要改哪些文件：
    - `packages/relay-tunnel-wire/*`（新增：DataChannel 帧格式，Host 与客户端共用一份）
    - `apps/host/src/modules/relay-tunnel/webrtc/webrtc-peer-ipc.ts`（新增：IPC 协议 + 上报合并限频）
    - `apps/host/src/modules/relay-tunnel/webrtc/webrtc-peer-process.ts`（新增：接入进程，werift + 信令 + 网关）
    - `apps/host/src/modules/relay-tunnel/webrtc/webrtc-peer-supervisor.ts`（新增：主进程侧监管者）
    - `apps/host/src/modules/relay-tunnel/webrtc/webrtc-frame-bridge.ts`（新增：帧 ↔ 网关包）
    - `apps/host/src/modules/relay-tunnel/webrtc/webrtc-dtls-certificate.ts`（新增：DTLS 证书，W4.1 前半）
    - `apps/host/src/modules/relay-tunnel/webrtc/relay-tunnel-webrtc-runtime-adapter.ts`（新增）
    - `apps/host/src/server/create-server.ts`（把运行时适配器换成 WebRTC 实现）
    - `apps/host/src/storage/sqlite/schema.sql` + `host-migrations.ts` + `instance-relay-tunnel-identity-repository.ts`（DTLS 材料落库）
  - 这一步明确不做什么：不做业务转发（那是 W1.2），不做信令鉴权（信令票据由控制面签，这里只带票）
  - 怎么验证：
    - `pnpm --dir packages/relay-tunnel-wire test`
    - `pnpm --dir apps/host test -- tests/integration/webrtc-peer-ipc.test.ts tests/integration/webrtc-frame-bridge.test.ts`
    - `cd apps/host && pnpm exec tsx scripts/relay-tunnel-webrtc-e2e.mjs`（真链路）
  - 验证结果：
    - 帧编解码单测 27 个全绿（含半帧 / 粘帧 / 超大 meta / 未知类型拒绝）
    - 真链路联调 9/9 通过：接入子进程 → 真信令服务（经 nginx `/signaling/signal`）→ 客户端 offer →
      子进程回 answer → DataChannel 打开。链路判定 `p2p`（本机 host 候选直连）
    - 子进程日志：`peer.connection_state connected` → `peer.transport_kind {"kind":"p2p"}` → `data_channel.open`
    - 同一条 PeerConnection 上只用一条 DataChannel：收到第二条会在子进程里直接关掉并留日志
    - 生产产物也验过：`node .build/src/modules/relay-tunnel/webrtc/webrtc-peer-process.js` 能在纯 node 下启动并上报 `ready`；
      `pnpm --dir apps/host build` 通过（生产构建会把新文件一起 emit）
    - 顺带更新了 `relay-tunnel-system-routes.test.ts`：Host 指纹的期望值从 x25519 的 `SHA256:` 前缀改成
      DTLS 的 `sha-256 XX:XX:...`；「本地 bind 但没登录控制站」那条用例现在如实报 `error`
      （拿不到信令票据），不再像老 WSS 实现那样一直挂在 `connecting`
    - 相关测试一起跑：9 个文件 106 个用例全绿

- [x] W1.2 打通 DataChannel 到本地业务接口的转发
  - 状态：DONE
  - 这一步到底做什么：把 DataChannel 收到的业务消息转成对本地 `127.0.0.1:<port>` 的 HTTP / WS 请求，响应再回传
  - 做完以后能看到什么结果：客户端能通过 WebRTC 通道正常使用 Host 业务接口
  - 依赖什么：W1.1
  - 主要改哪些文件：
    - `apps/host/src/modules/relay-tunnel/webrtc/webrtc-peer-process.ts`（每条连接一个 `RelayTunnelGatewayService`）
    - `apps/host/src/modules/relay-tunnel/webrtc/webrtc-frame-bridge.ts`
    - `apps/host/src/modules/relay-tunnel/relay-tunnel-gateway-service.ts`（三处 base64 解码改成直接用字节）
    - `apps/host/src/modules/relay-tunnel/crypto/relay-tunnel-packets.ts`（包类型改成带 `Uint8Array`）
  - 这一步明确不做什么：不改现有业务 API 语义；本地转发仍然直接复用 `RelayTunnelGatewayService`，没有重写
  - 怎么验证：
    - `pnpm --dir apps/host test -- tests/integration/webrtc-frame-bridge.test.ts`
    - `cd apps/host && pnpm exec tsx scripts/relay-tunnel-webrtc-e2e.mjs`
  - 验证结果：
    - 帧 ↔ 网关包双向转换单测 17 个全绿
    - 端到端：`http.request` 经 DataChannel 到本地业务接口并回传 `http.response.start/chunk/end`
      - `GET /ping?from=e2e` → `status=200 body={"ok":true,"path":"/ping?from=e2e"}`
      - `POST /upload` × 137 条 → 137/137 全部收到响应
      - `GET /download?mb=8` → 8.00 MB 完整回传，分片 24576 字节
    - **上行吞吐只认 Host 侧实测**（本地业务服务「第一个请求体字节到达 → 最后一个请求体字节收完」）：
      **8.03 MB / 779 ms / 10.30 MB/s**；客户端「写完全部帧」只用了 3 ms，这个数字明显不可信，所以只当参考
    - 下行（客户端实测，口径不同已在报告里写明）：8.00 MB / 2288 ms / 3.50 MB/s
    - 老 WSS 路径的两个测试本来就是失败的（HEAD 上就红），不是这次改动引起的，W6.2 会整体下线
  - 补充分片（2026-09-16，实测发现 DataChannel 单条消息硬上限 64 KB 之后）：
    - **缺口**：原来 `http.request` 是整块带 body 的，实测 256 KB 单条消息 `send()` 直接抛
      `max-message-size exceeded: 262144 > 65536`，对端一个字节都收不到 —— 也就是
      **任何超过 64 KB 的上传都会失败**。之前那条 137 个小请求体的联调正好绕过了这条路
    - **协议**（共享包 `packages/relay-tunnel-wire`，另一个代理改）：新增
      `http.request.chunk`(13) 与 `http.request.end`(14)；`http.request` 的 body 语义改成第一段；
      新增 `TUNNEL_MAX_FRAME_BODY_BYTES = 48 KB`，`encodeFrame` 超限直接抛 `BODY_TOO_LARGE`
    - **Host 侧**：新增 `webrtc-request-assembler.ts`，按 `streamId` 累积
      `http.request` + n × `http.request.chunk`，收到 `http.request.end` 才调
      `RelayTunnelGatewayService.handlePacket()`
    - 明确的行为约定：
      - 单请求体累积上限 **64 MB**（`REQUEST_BODY_MAX_BYTES`），超了回
        `REQUEST_BODY_TOO_LARGE` 错误帧并中止这条流
      - 连接断开 / 会话关闭时 `clear()` 把所有未完成缓冲一起清掉
      - 收到 chunk 但该 streamId 还没有 `http.request` → 回 `REQUEST_STREAM_UNKNOWN`，
        **绝不把半截数据发去本地**
      - 同一个 streamId 重复开 `http.request` → 丢掉旧的、以新的为准，不会拼接出错
      - **为什么不做「靠空闲超时猜请求体发完了」**：窗口调小会把真实网络下的大上传截断成
        半截 body（静默发错数据，比报错更糟），窗口调大则每个小请求都要多等几秒。
        所以规则定死：**发了 `http.request` 就必须补一条 `http.request.end`**，小请求体也一样，
        只是多一条 10 字节的帧。客户端忘了发 `end` 不会静默挂死：空闲 30 秒回
        `REQUEST_BODY_INCOMPLETE` 并丢掉缓冲
      - 转换层显式接住这两个新类型（返回 null，交给会话层的组装器），
        不再落进 `UNSUPPORTED_PACKET`
    - 单测：`tests/integration/webrtc-request-assembler.test.ts` **15 个全绿**，覆盖
      分片重组（含多流交错不串台）、孤儿 chunk / 孤儿 end 被拒、重复 `http.request`、
      超 64 MB 上限被拒并中止、`end` 后缓冲清零、`clear()` 断开清理、
      空闲超时（客户端忘发 `end`）、新分片会重置空闲计时（慢速上传不误判）、
      **小请求体一条 `http.request` 带完的兼容路径**
    - 端到端：`scripts/relay-tunnel-webrtc-e2e.mjs` **11/11**，新增三条用例：
      - 兼容底线：小请求体一条 `http.request` 带完（0 个 chunk），Host 收到字节与校验和一致
      - **1 MB 分片上传**：首段 49152 字节 + 21 条 chunk + 1 条 end，Host 侧收到
        1048576/1048576 字节，校验和 `26dc9dc5` 与客户端声明一致
      - **16 MB 分片上传**：首段 49152 字节 + 341 条 chunk + 1 条 end，Host 侧收到
        16777216/16777216 字节，校验和 `f71c9dc5` 一致
    - **量吞吐的口径换了**（这次踩出来的）：分片之后请求体是先由接入进程收齐、再一次性写进本地业务服务，
      所以业务服务测到的「首字节 → 收完」只反映本地回环写 HTTP（16 MB 只要 9 ms，换算出来 2000+ MB/s，假的）。
      现在只认**接入进程**从收到 `http.request` 第一帧到 `http.request.end` 的耗时：
      **1 MB → 45 ms / 22.22 MB/s；16 MB → 3784 ms / 4.23 MB/s**，
      落在验证结论文档给的 werift 上行 3~15 MB/s 区间内
  - 补充 WS 消息分片（2026-09-16，同一天紧接着 HTTP 分片做的）：
    - **缺口**：`ws.message` 同样受 64 KB 限制。`ws/workbench-ws-hub.ts` 的
      `fileTree.snapshot` 没有任何截断，一个正常规模仓库的文件树 JSON 轻松超过 64 KB，
      而旧 WSS 通道没有这个限制 —— 也就是**远程客户端打开工作台时文件树会直接加载不出来**，
      是相对旧路径的功能性回退，必须修
    - **协议**（共享包）：新增 `ws.message.chunk`(15) 与 `ws.message.end`(16)。
      规则和 HTTP 那条路**不同**：
      **小消息（≤ 48 KB）只发一条 `ws.message`、不发 end、收到即投递**（主路径零改动）；
      **大消息只发 `chunk` × N + `end`、不发 `ws.message`**，收到 end 才把拼接结果作为
      一条完整消息投递。这样 `ws.message` 永远等于「一条完整消息」，不会半截投递
    - **Host 侧**：
      - 入站：新增 `webrtc-ws-message-assembler.ts`，按 `streamId` 累积 chunk，
        收到 `end` 才作为一条 `ws.message` 交给 `RelayTunnelGatewayService` → 本地 `wsSockets`
      - 出站：`webrtc-frame-bridge.ts` 新增 `gatewayPacketToFrames()`，
        大 WS 消息展开成 `chunk` × N + `end`，其余包仍是一一对应
      - 单条消息累积上限 **64 MB**（`WS_MESSAGE_MAX_BYTES`），超了回 `WS_MESSAGE_TOO_LARGE` 并中止该流
      - 连接断开 / 会话关闭时 `clear()` 清掉所有未完成累积
      - 收到 `ws.message.end` 但该 streamId 没有任何 chunk → 回
        `WS_MESSAGE_STREAM_UNKNOWN`，**绝不投递空消息**
      - 转换层显式接住这两个新类型，不再落进 `UNSUPPORTED_PACKET`
    - 单测：`tests/integration/webrtc-ws-message-assembler.test.ts` **14 个全绿**，覆盖
      分片重组（含多流交错不串台、binary 标记跟随首片）、孤儿 end 被拒且不投递空消息、
      超 64 MB 上限被拒并中止、`end` 后缓冲清零、`clear()` 断开清理、`discard` 单流丢弃，
      以及出站方向：小消息单帧不分片、正好等于上限也不分片、
      超限只发 chunk+end（断言**一条 `ws.message` 都没有**）、每帧都小于 64 KB、
      出站分片能被对端组装回一模一样的字节，
      外加一条真实场景用例：**一个 200 KB 的 `fileTree.snapshot` 能完整过通道**
    - 端到端（`scripts/relay-tunnel-webrtc-e2e.mjs`，**15/15**）新增三条：
      - **Host → 客户端**：本地 WS 推一条 187818 字节的文件树 JSON，
        客户端收到 4 条 chunk 并拼回，内容与本地发出的逐字节一致（校验和 `7de04d64` 相同）
      - **客户端 → Host**：客户端发 109931 字节（3 条 chunk + 1 条 end），
        本地 WS 收到的字节数与校验和（`eb062c66`）完全一致
      - **小 WS 消息仍走单帧主路径**：服务端回的 ack 只有 63 字节、0 条 chunk
    - 接入进程日志佐证：
      `peer.ws_message_assembled {"streamId":"stream-ws-big","bytes":109931,"chunkCount":3,"elapsedMs":3}`

- [x] W1.3 把信令连接接入 TaskManager
  - 状态：DONE
  - 这一步到底做什么：信令连接、状态刷新、用量上报都走 `TaskManager`，不自己长私有 timer
  - 做完以后能看到什么结果：网络抖动后能自动恢复，设置页能看到当前阶段
  - 依赖什么：W1.1
  - 主要改哪些文件：
    - `apps/host/src/modules/tasks/task-types.ts`（新增 `webrtc.peer_supervise` / `relay_tunnel.state_refresh` / `relay_tunnel.usage_report`）
    - `apps/host/src/modules/relay-tunnel/webrtc/webrtc-peer-supervisor.ts`
    - `apps/host/src/modules/relay-tunnel/webrtc/relay-tunnel-webrtc-runtime-adapter.ts`
  - 这一步明确不做什么：不重写 TaskManager 本身
  - 怎么验证：
    - `pnpm --dir apps/host test -- tests/integration/webrtc-peer-supervisor.test.ts tests/integration/relay-tunnel-webrtc-runtime-adapter.test.ts`
    - `cd apps/host && pnpm exec tsx scripts/relay-tunnel-webrtc-adapter-e2e.mjs`
  - 验证结果：
    - 三个 taskType 全部按要求命名，注册放在初始化路径里并用 `has()` 防重复注册
    - 监管任务的退避等待发生在任务内部，没有私有 inflight 表 / 重试队列；
      重复请求只记 `superviseAgain`，跑完再补一次（对应 `spec001.2` 3.13）
    - 状态刷新走 `relay_tunnel.state_refresh` 落库，联调里 `enqueue=1` 并成功写入 DTLS 指纹
    - 用量上报走 `relay_tunnel.usage_report`，按会话 key 去重；计费已改固定订阅，这里只做风控参考，没有任何「用完断流」
    - 修掉一个真缺陷：原来的用量上报把「增量数组」交给限频合并器，窗口内被顶掉的增量会永久丢，
      联调时 8 MB 上行只报出 203 字节；改成「递增序号做触发、发送时再从累计器取走全部增量」后，
      联调实测 `upstreamBytes=8436486 ≥ 业务体 8417280`，并且有回归单测兜住
    - 状态映射如实：`starting` / `signaling_connecting` / `waiting_for_peer` → `connecting`，
      `running_p2p` / `running_relay` → `running`，`error` → `error`；
      `connected` 只在真的有客户端 DataChannel 打通时为 true
    - 断网 / 恢复：信令断线由子进程按 1s→30s 退避重连，重连时通过 `ticket.request` 找主进程换新票据
      （票据只有 60 秒有效期，不能复用旧的）。这一条只做了代码路径 + 单测，没有做真实断网演练

- [x] W1.4 接入进程崩溃自动拉起
  - 状态：DONE
  - 这一步到底做什么：主进程监控 WebRTC 接入进程，崩了自动重启，并把原因记进状态
  - 做完以后能看到什么结果：接入进程挂掉不影响 Host 其他功能，且能自动恢复
  - 依赖什么：W1.1
  - 主要改哪些文件：
    - `apps/host/src/modules/relay-tunnel/webrtc/webrtc-peer-supervisor.ts`
  - 这一步明确不做什么：不做多进程池
  - 怎么验证：
    - `pnpm --dir apps/host test -- tests/integration/webrtc-peer-supervisor.test.ts`
    - `cd apps/host && pnpm exec tsx scripts/relay-tunnel-webrtc-supervise-e2e.mjs`（真子进程 + 真 `kill -9`）
  - 验证结果：
    - 退避序列单测：`0 / 1s / 2s / 4s / 8s / 16s / 30s（封顶）/ 30s`，连续失败 5 次后停止自动拉起并置 `error`
    - 真 `kill -9` 联调 12/12 通过：
      - `kill -9 37660` → 主进程（pid 37635）存活
      - 挂掉期间状态 `phase=error`，`lastError=接入进程意外退出（code=null，signal=SIGKILL）`，不是 `running_*`
      - 1 秒后自动拉起新进程（pid 37662），**重新收到一次 configure**（configure 次数 1 → 2）
      - 连续失败计数在成功拉起后清零
      - 拉起动作确实记在 `webrtc.peer_supervise` 任务上（`enqueue=2`）
    - 子进程被 `shutdown` 触发的退出不会触发自动拉起（单测覆盖）
    - 没做的：进程模型文档第七节第 6 条「压一条连接打满带宽确认主进程事件循环没被拖慢」没有量化测（只做了结构隔离，没有实测 event loop 延迟）

---

## 阶段 W2：客户端接入层

- [x] W2.1 新增客户端 WebRTC transport
  - 状态：DONE（类型检查、相关单测、真实端到端联调都过了；跨网走中继那条路径留给 W7 验收）
  - 这一步到底做什么：在 user-app 里实现基于 DataChannel 的传输实现，替代现有 relay-tunnel transport；
    同时补上「登录控制站账号 → 换信令票据」这一步（见下面「前置决定」）
  - 做完以后能看到什么结果：客户端能通过 WebRTC 通道访问远程 Host
  - 依赖什么：W1.2
  - **前置决定（2026-09-16 已拍板，不要再改）**：
    - 客户端**必须先登录控制站账号**才能换信令票据。控制站的
      `POST /api/v1/relay/signaling/ticket` 要求账号 Bearer，原来的匿名 `connect-init`
      那套信任级别不再沿用
    - 允许连接的账号**必须就是绑定这台 Host 的账号**；控制面已有
      `BINDING_FORBIDDEN` 校验，本轮**不做**账号之间的共享授权（无邀请、无成员列表、无撤销）
    - **注册、登录、设备（绑定）分配一律复用现有 CodingNS Connect，不新建账号体系、不新增控制面接口**。
      登录用现成的 `POST /api/public/auth/login`；账号名下的「设备」就是已有的绑定列表，
      用现成的 `GET /api/v1/hosts`（带 Bearer），**不新造「设备」这个概念**。
      客户端走「登录 → 拉绑定列表 → 选一台 → 换信令票据 → 建 WebRTC 连接」，
      不让用户手输 tunnelDomain。本轮唯一新增的是传输层
    - 后果要说清楚：H5 从「打开链接就能用」变成「先登录」。这是有意为之——
      原来 tunnelDomain 事实上当口令用，泄漏一个链接等于把 Host 交出去
  - 主要改哪些文件：
    - `apps/user-app/src/network/webrtc/*`（新增：控制站客户端、登录态、信令、会话、传输、链路类型等 10 个文件）
    - `apps/user-app/src/network/host-transport-registry.ts`（relay 分支换成新 transport，保留缓存与直连回退）
    - `apps/user-app/src/settings/RelayWebRtcClientPanel.tsx`、`control-client-actions.ts`（新增，登录与设备入口）
    - `apps/user-app/src/features/settings/pages/SettingsPage.tsx`（远程访问区块）
    - `apps/user-app/src/bootstrap/bootstrap-app.ts`（启动时载入登录态）
    - `apps/user-app/src/app/workbench-native.css`、i18n 字典与测试
    - `apps/user-app/scripts/relay-tunnel-webrtc-client-e2e.mts`（新增，真实端到端联调脚本）
  - 这一步明确不做什么：不重写业务层 API 调用方式；不做账号共享授权；不删旧 relay 实现（W6.1 删）；
    不改控制面、不改共享包
  - 怎么验证：
    - `pnpm --dir apps/user-app exec vitest run src/network/*.test.ts`
    - `pnpm --dir apps/user-app exec tsc --noEmit -p tsconfig.json`
  - 验证结果：
    - `pnpm --dir apps/user-app exec tsc --noEmit -p tsconfig.json`：通过（无输出）
    - 相关单测本轮共 141 条全绿，其中 W2 新增 101 条：
      `tunnel-transport`(22)、`tunnel-client`(15)、`control-site-client`(12)、`tunnel-target`(9)、
      `secure-context`+链路类型(11)、`dtls-fingerprint`(15)、`RelayWebRtcClientPanel`+i18n(9)、
      `host-transport-registry`(11)
    - 单测覆盖：帧 ↔ HostTransport 语义映射（http 请求/响应/分片/错误、ws 开/消息/关）、
      streamId 生命周期与清理、背压等待与超时放行、请求体 48 KB 分片与重组、
      WebSocket 大消息分片与重组、登录与换票各错误分支（401 / 403 / 404 / 409）、
      链路类型上报、会话用量字节统计
    - 安全上下文：HTTPS 或本机地址放行，局域网裸 HTTP 给出「请改用 HTTPS 地址」的人话提示
    - **真实端到端联调：9/9 通过**（跑的是 user-app 里真实的客户端 transport，
      对端是真实的 Host 接入子进程；PeerConnection 用 werift 适配，其余全是生产代码）：
      命令 `pnpm --dir apps/user-app exec tsx scripts/relay-tunnel-webrtc-client-e2e.mts`
      ```text
      [w2-e2e] PASS 控制站登录拿到 accessToken — HTTP 200
      [w2-e2e] PASS Host 侧登记绑定并写入 DTLS 指纹 — bindingId=binding_b0301a4112a8
      [w2-e2e] PASS Host 侧换到 host 票据 — HTTP 201
      [w2-e2e] Host 接入进程已进入 waiting_for_peer
      [w2-e2e] PASS 客户端通过 DataChannel 拿到真实业务响应 — status=200 body={"ok":true,"from":"local-business","path":"/api/client/runtime-config?from=w2"}
      [w2-e2e] PASS 1 MB 请求体分片上传（1048576 字节） — Host 侧收到 1048576 字节
      [w2-e2e] PASS 120 KB WebSocket 大消息往返（分片 + 重组） — 回显 122880 字符，一致=true
      [w2-e2e] PASS W2.3 真实连接上报链路类型 — phase=connected transportKind=p2p
      [w2-e2e] PASS W2.2 指纹被换掉时拒绝连接真实 Host — 拒绝原因：对方的身份指纹和你的 Host 记录不一致，连接已断开。这通常意味着连接被第三方劫持了。
      [w2-e2e] PASS 会话用量统计有上下行字节 — 上行 1173693 / 下行 124026
      [w2-e2e] 结果：9/9 通过
      ```
      前置：`pnpm local:stack:start`（信令服务）+ 一个隔离的文件库控制面（18093，
      不用共享库）；脚本头部注释里有完整命令。
    - 控制面契约单独核对过（真实 HTTP，不是 mock）：
      `GET /api/v1/hosts` 带 Bearer 返回 200、不带 Bearer 返回 401；
      `POST /api/v1/relay/signaling/ticket` 传 `{ tunnelDomain }` 返回 201 且带
      `ticket` / `signalingBaseUrl` / `iceServers` / `iceTransportPolicy="all"` /
      `hostDtlsFingerprint` / `bindingId`；不存在的绑定返回 404 `TUNNEL_NOT_FOUND`；
      别人的绑定返回 403 `BINDING_FORBIDDEN`；Host 不在线时发 offer 会收到
      `{"type":"error","errorCode":"HOST_NOT_CONNECTED"}`
    - 还没验的：真实浏览器里的麦克风/摄像头那种 `srflx`、真正跨网走 TURN 的 `relay` 链路；
      本轮真实联调两端都在本机，只覆盖了直连（`transportKind=p2p`）

- [x] W2.2 客户端 DTLS 指纹校验
  - 状态：DONE
  - 这一步到底做什么：建立连接时比对 SDP 里的 DTLS 指纹与控制面返回的指纹，不一致直接断开
  - 做完以后能看到什么结果：中间人无法冒充 Host
  - 依赖什么：W2.1
  - 主要改哪些文件：
    - `apps/user-app/src/network/webrtc/dtls-fingerprint.ts`（新增，解析与比对）
    - `apps/user-app/src/network/webrtc/tunnel-session.ts`（收到 answer 时先校验再 setRemoteDescription）
  - 这一步明确不做什么：不做「指纹不符但允许继续」的降级开关
  - 怎么验证：
    - 构造指纹不匹配场景，确认连接被拒绝
    - 单元测试覆盖比对逻辑
  - 验证结果：
    - `pnpm --dir apps/user-app test src/network/webrtc/dtls-fingerprint.test.ts` → 15/15 通过：
      相等 / 大小写不同 / 分隔符（`:` 与 `-`）不同 / 真的不一致 / 算法名不同 /
      SDP 里没有 `a=fingerprint` / 控制面没给指纹 / 太短的十六进制不当有效指纹
    - `pnpm --dir apps/user-app test src/network/webrtc/tunnel-client.test.ts` → 15/15 通过，
      其中两条断言「指纹不一致」「answer 缺 fingerprint」时：不调用 `setRemoteDescription`、
      `PeerConnection` 被关闭、请求 Promise 被拒绝
    - 实现里把顺序固定成「先校验指纹，再碰 PeerConnection」：
      指纹不对时那段 SDP 根本不会进入 WebRTC 栈
    - 没有提供任何绕过开关（代码里没有对应的配置项）

- [x] W2.3 展示当前链路类型
  - 状态：DONE（组件与文案层已验证；真实中继链路上也确认过会切到「经中继」）
  - 这一步到底做什么：识别当前是 P2P 直连还是 TURN 中继，并在设置页和连接状态处展示
  - 做完以后能看到什么结果：用户知道自己现在走的是哪条路
  - 依赖什么：W2.1
  - 开始前必须先阅读：
    - `docs/开发设计规范/20260419-前端页面与样式设计规范.md`（已读，面板按该规范沿用设置页现有基线）
  - 主要改哪些文件：
    - `apps/user-app/src/network/webrtc/link-info.ts`、`webrtc-link-store.ts`（新增，判定与状态）
    - `apps/user-app/src/settings/RelayWebRtcClientPanel.tsx`（设置页展示）
    - `apps/user-app/src/features/conversation/components/ConnectionBanner.tsx`（连接状态提示里带链路类型）
    - i18n 字典与测试
  - 这一步明确不做什么：不把 ICE 候选类型这种术语暴露给用户
  - 怎么验证：
    - 组件测试 + 手工联调
  - 验证结果：
    - 判定规则：选中候选对里本地或远端任一侧是 `relay` 就算「经中继」，否则「直连」
      （`resolveTunnelLinkTransportKind`，单测覆盖 relay / p2p / 候选缺失）
    - `pnpm --dir apps/user-app test src/network/webrtc/tunnel-client.test.ts`：
      两条用例分别断言连上后链路类型是 `p2p` 与 `relay`
    - `pnpm --dir apps/user-app test src/settings/RelayWebRtcClientPanel.test.tsx` → 9/9 通过，
      含「链路状态区显示『直连』/『经中继』」和「面板文案里不出现 ICE / 候选 / srflx / DTLS / SDP / TURN」
    - i18n 中英文字典都补齐了本次新增键，并有测试逐键断言存在；
      用户看到的是「直连 / 经中继」（英文 Direct / Relayed），不是 ICE 术语
    - 面板只新增布局与分割线样式，按钮、输入框、文字色沿用设置页现有基线
    - **真实中继链路上已确认（2026-09-16）**：在 `CODINGNS_PROXY_FORCE_TURN_BY_DEFAULT=true`
      的隔离控制面 + 本机 coturn 下跑真实端到端，客户端上报 `transportKind=relay`，
      界面显示「经中继」而不是「直连」。也就是说这条判定在本机直连与真实中继两种链路下都验过了，
      不再只是组件测试里的构造场景

---

## 阶段 W3：信令与 TURN

- [x] W3.1 实现信令服务器
  - 状态：DONE
  - 这一步到底做什么：在子仓库实现信令服务，负责注册、房间、SDP / ICE 转发和凭据校验
  - 做完以后能看到什么结果：Host 和客户端能通过它完成建连
  - 依赖什么：W0.2
  - 主要改哪些文件：
    - `apps/codingns-proxy/apps/relay-signaling/*`（新增）
    - `apps/codingns-proxy/packages/shared-contracts/*`
  - 这一步明确不做什么：不转发业务数据，不碰业务消息
  - 怎么验证：
    - 信令层并发、重连、凭据过期测试
    - 抓包确认信令只经手 SDP / ICE
  - 验证结果：
    - 新增 `apps/codingns-proxy/apps/relay-signaling/`：Fastify + WebSocket，房间模型在 `signaling-hub.ts`
    - 票据签发与校验放在 `shared-contracts/src/signaling-ticket.ts`，HMAC-SHA256，控制面与信令服务共用同一份实现
    - 覆盖：票据过期 / 篡改 / 换密钥 / 无票据拒绝、Host 与客户端完整信令交换、
      Host 不在线明确报错、角色越权拒绝、同绑定 Host 重连顶号、客户端上限、在线快照
    - `pnpm --filter @codingns-proxy/relay-signaling test` → 24/24 通过
    - `pnpm --filter @codingns-proxy/shared-contracts test` → 13/13 通过
    - 信令服务器不解析 SDP 内容，只做转发，代码层面没有接触业务数据的路径
    - **真实端到端联调（本地栈）**：造真实账号 → `POST /api/v1/hosts/bind` 绑定 →
      分别换 client / host 票据 → 两个 WebSocket 连上 nginx 反代的 `/signaling/signal` →
      客户端发 offer 被 Host 收到 → Host 回 answer 被客户端收到 → 双方都收到 `peer-ready`
    - 信令服务已接入本地栈（`pnpm local:stack:start`），监听 18085，nginx 反代 `/signaling/*`

- [x] W3.2 部署 coturn 并接入控制面
  - 状态：DONE（2026-09-17 安全组放行后完成公网验收）
  - 这一步到底做什么：部署 TURN 服务，控制面负责下发 ICE 配置和临时凭据
  - 做完以后能看到什么结果：NAT 打洞失败的用户能通过 TURN 连上
  - 依赖什么：W3.1
  - 主要改哪些文件：
    - `apps/codingns-proxy/deploy/templates/coturn.conf.template`（新增）
    - `apps/codingns-proxy/apps/control-api/*`
  - 这一步明确不做什么：不自研 TURN
  - 怎么验证：
    - 强制 `iceTransportPolicy: "relay"` 跑通
    - TURN 侧能看到用量数据
  - 已完成：
    - 新增 `deploy/templates/coturn.conf.template`：REST 临时凭据模式、内网地址黑名单、
      配额、日志与运行用户都已配好
    - 控制面侧凭据签发已完成（W3.3）：HMAC-SHA1 + 过期时间戳，不存长期密码
    - 部署与验证步骤已落库 `docs/20260916-TURN部署与接入说明.md`
    - 新增 `scripts/verify-turn.mjs`（`pnpm verify:turn`）：部署后一条命令自检，
      查凭据签发、STUN 可达性（含「服务端看到的是不是内网地址」这个 `external-ip` 判据）、
      以及**自己发一次完整的 TURN Allocate** 精确验证凭据是否被接受
    - 自检脚本已实测四条路径：正常通过 `exit 0`、未配 TURN / 未配密钥 `exit 1`、
      地址格式错 `exit 1`、端口不可达 `exit 2`；STUN 探测对着 demo 的最小 STUN 服务真跑通过
    - **本机装了真 coturn（4.18.0）做了端到端验证**：
      - 用仓库模板生成配置起 coturn，`pnpm verify:turn` → `exit 0`，
        第 3 步报「成功分配到中继地址（realm=local.test）」
      - **反向验证**：把共享密钥换成错的，同一个脚本 → `exit 2` 且明确报
        「凭据被拒：401」。证明这个检查真的能区分对错，不是走过场
      - 过程中修掉了自检脚本自身的两个真 bug：`turnutils_uclient` 缺 `-y`/`-e` 参数被
        误判成「密钥不一致」；两次请求用了不同 UDP 源端口导致 coturn 回 `438 Stale Nonce`
        （nonce 绑五元组，必须复用同一条通道）
      - 记了一个本地自测的坑：生产模板里的 `denied-peer-ip=127.0.0.0/8` 会让回环自测出现
        `403 Forbidden IP`，但那是 peer 策略拒绝回环对端，**ALLOCATE 已成功、凭据没问题**
    - **强制 relay 真实验收也做了**（新增 `local/webrtc-datachannel-demo/turn-relay-check.mjs`）：
      - 建两个真 werift PeerConnection，两端都强制 `iceTransportPolicy: "relay"`，
        且**只给 TURN 不给 STUN**——即使策略写错也没有直连候选，排除「其实走了直连却以为在测中继」
      - 实测结果：两端候选都是 `relay`；选中的候选对是
        `relay 127.0.0.1:53347 ↔ relay 127.0.0.1:62622`；一条特意造的内容原样穿过中继，`exit 0`
      - 又踩到一个坑并写进文档：**coturn 默认拒绝回环对端**，这跟 `denied-peer-ip` 是两回事。
        注掉 `denied-peer-ip=127.0.0.0/8` 之后 `CREATE_PERMISSION` / `CHANNEL_BIND` 照样回
        `403 Forbidden IP`，本机回环自测必须额外加 `allow-loopback-peers`（**生产绝对不能开**）
    - **强制 relay 下的完整真实链路也已跑通（2026-09-16，本机 coturn）**：
      起了一个 `CODINGNS_PROXY_FORCE_TURN_BY_DEFAULT=true` 的隔离控制面（18094）+ 本机 coturn，
      跑 user-app 的真实端到端脚本（客户端用的是真实 `ManagedWebRtcTunnelHostTransport`，
      对端是真实 Host 接入子进程）→ **9/9 全部通过**：
      - 客户端通过 DataChannel 拿到真实业务响应
      - **1 MB 请求体分片上传**，Host 侧收到 1048576 字节
      - **120 KB WebSocket 大消息**往返一致
      - **`transportKind=relay`**——客户端在真实中继链路上正确识别出「经中继」
        （这条同时把 W2.3 那个「真实链路上会不会切到经中继」的悬空点补掉了）
      - 指纹被改后拒绝连接、会话用量有上下行字节
      旁证：coturn 日志里能看到本次运行的账号（`acct_c26005b942e4`）在对应时刻
      `allocation new`，说明中继确实被用上了，不是「其实走了直连」。
      复跑命令：`CONTROL_BASE_URL=<带 TURN 的控制面> ADMIN_EMAIL=… ADMIN_PASSWORD=… pnpm exec tsx scripts/relay-tunnel-webrtc-client-e2e.mts`
  - **正式服务器部署记录（2026-09-16，服务器 100.64.0.3 / 公网 42.193.118.236，Ubuntu 22.04）**：
    - 服务器原状：跑的是 4 月的旧代码（`830e4b1`），只有 console-web / control-api / relay-edge；
      且**生产控制面自 4 月起就没起来过**（下面两条根因）
    - **根因一：数据库凭据是错的**。控制面连 `codingns_proxy_control` 用的是 `postgres` 超级用户，
      密码认证失败；而且 4 月 21 日第一次部署时就是同一个错。该库属主其实是专用角色 `codingns_proxy`，
      已把 `.env` 改为用该角色（并给角色设了强密码），直连测试通过。旧 `.env` 备份为 `.env.bak-*`
    - **根因二：没有任何进程守护**。没有 pm2 配置、没有 systemd 单元、没有 crontab，
      服务是手工起的，一死就没人拉。已用仓库的 pm2 模板渲染出 `deploy/ecosystem.config.cjs`，
      接入 control-api / relay-edge / relay-signaling 三个应用，并 `pm2 save` + `pm2 startup`（`pm2-root` enabled）
    - 部署步骤：服务器拉代码 → `pnpm install` → 构建（只建 shared-contracts / relay-signaling /
      control-api / relay-edge，**没动 console-web**）→ `apt-get install coturn` → 渲染 coturn 配置 →
      补 `.env` 的 TURN/STUN/信令共 9 个键 → pm2 起服务 → nginx 加 `/signaling/*` 路由
    - **coturn 配置要点**（这台机器在腾讯云 NAT 后面，这几点配错就会「平时能连、跨网连不上」）：
      `external-ip=42.193.118.236/10.2.24.2`、`relay-ip=10.2.24.2`、
      中继端口段**收窄成 49152-49200**（默认的 49152-65535 有一万多个端口，
      让云安全组只开一小段就够）、`realm=channel.codingns.com`、`use-auth-secret`；
      并按仓库模板去掉已废弃的 `no-cli`
    - **已在服务器上验证通过**：coturn `active`；`node scripts/verify-turn.mjs` 对着 `127.0.0.1:3478`
      → `exit 0`，成功分配到中继地址（realm 正确）
    - **已从外网验证通过**：`https://channel.codingns.com:1443/api/public/meta` 从 502 恢复为 **200**；
      `/signaling/healthz` **200**；`/signaling/api/public/meta` 返回
      `transport: webrtc-datachannel` / `websocketPath: /signal`，与客户端实现一致
    - 回滚手段：代码回滚点 `3488bac`；`.env` 与 nginx 配置都有带时间戳的备份；
      nginx 备份放在 `/root/nginx-backups/`（**不能放在 `sites-enabled/` 里**，
      那个目录被 `include` 通配，放进去会导致「重复的 default server」而重载失败）
  - **公网验收已完成（2026-09-17，安全组放行后）**：
    - 腾讯云安全组已放行 `3478/udp`、`3478/tcp`、`49152-49200/udp`（中继段已从默认一万多个
      收窄成 49 个，只开一小段就够）
    - **从外网实测端口真的通了**：`nc -z 42.193.118.236 3478` → TCP succeeded；
      自己发 STUN Binding Request → 收到 `0x101` 响应，magic cookie 与 txId 都对
    - **`pnpm verify:turn` 从外网跑 → `exit 0`**：第 2 步回显的映射地址是公网地址
      `144.255.31.231`（不是内网地址，说明 `external-ip` 配对了）；第 3 步
      **真的完成了一次 TURN Allocate**，分配到中继地址（realm `channel.codingns.com`）——
      这条同时证明了共享密钥一致、两台机器时间同步
    - **从外网强制 relay 真跑通**（`turn-relay-check.mjs`，只给 TURN 不给 STUN）：
      两端候选都是 `relay`，选中的候选对 `relay 42.193.118.236:49193 ↔ relay 42.193.118.236:49175`
      （端口都落在收窄后的 49152-49200 段内），一条特意造的内容原样穿过中继，`exit 0`
    - **真实完整链路也跑通**：隔离控制面开 `FORCE_TURN_BY_DEFAULT=true` + 生产 coturn，
      跑 user-app 的真实端到端脚本（真实 `ManagedWebRtcTunnelHostTransport` 对真实 Host 接入子进程）
      → **9/9 通过**，`transportKind=relay`，含 1 MB 分片上传与 120 KB WebSocket 大消息
    - 完整记录：`specs/spec001.9.1-公共隧道服务二阶段收口与生产化验收/docs/20260917-生产环境TURN跨网与中继密文验收记录.md`
  - 备注：按账号粒度的 TURN 开关还没做，目前只有全局开关，等 W5 订阅模型落地后一起补。

- [x] W3.3 ICE 配置下发
  - 状态：DONE
  - 这一步到底做什么：控制面按账号 / 订阅状态下发 STUN 与 TURN 地址，并支持关闭指定账号的 TURN
  - 做完以后能看到什么结果：客户端拿到完整 ICE 配置，不用本地硬编码
  - 依赖什么：W3.2
  - 主要改哪些文件：
    - `apps/codingns-proxy/apps/control-api/*`
    - `apps/codingns-proxy/packages/shared-contracts/*`
  - 这一步明确不做什么：不做按地域分片的 ICE 调度
  - 怎么验证：
    - 接口测试 + 客户端联调
  - 验证结果：
    - 新增 `POST /api/v1/relay/signaling/ticket`：一次返回信令票据、ICE 配置、传输策略、Host DTLS 指纹
    - TURN 用 coturn REST 约定的临时凭据（HMAC-SHA1 + 过期时间戳），控制面不存长期密码
    - STUN 恒定下发（客户端侧 STUN 是必需项，见验证结论第四节）
    - TURN 未配置时不下发 TURN 候选，避免给出连不上的地址
    - 全局开关 `CODINGNS_PROXY_FORCE_TURN_BY_DEFAULT` 控制 `iceTransportPolicy`
    - 覆盖：client / host 两种票据、归属校验（别人的绑定换不到票）、未登录 / 未绑定 / 不存在的绑定
    - `pnpm --filter @codingns-proxy/control-api test` → 64 通过，1 个既有失败与本轮无关
      （`管理员可以查看全局账号…` 在改动前的 HEAD 上同样失败，已用干净 worktree 复现确认）
  - 遗留：**按账号粒度的 TURN 开关还没做**，目前只有全局开关。等 W5 订阅模型落地后一起补。

---

## 阶段 W4：安全验收

- [x] W4.1 DTLS 指纹登记与下发
  - 状态：DONE（控制面 / Host / 客户端三端都已落地，并端到端验证过）
  - 这一步到底做什么：Host 首次启用时生成 DTLS 证书、把指纹注册到控制面，客户端连接前取回
  - 做完以后能看到什么结果：指纹机制替代了原来的公钥指纹
  - 依赖什么：W1.1、W2.1
  - 主要改哪些文件：
    - `apps/host/src/modules/relay-tunnel/*`
    - `apps/codingns-proxy/apps/control-api/*`
  - 这一步明确不做什么：不做证书轮换 UI（先记录，后续再单开）
  - 怎么验证：
    - 接口测试 + 端到端联调
  - 已完成（控制面侧，2026-09-16）：
    - 修掉一个会让 W2.2 指纹校验永远失败的缺陷：换票接口原来把请求体里自报的
      `hostDtlsFingerprint` 直接下发，但**从不落库**。客户端只带 tunnelDomain 换票时，
      拿到的仍是绑定记录里老的 x25519 指纹，跟 SDP 里的 DTLS 指纹永远对不上
    - 现在的规则：换票接口**只下发绑定记录里持久化的指纹**；Host 自报的值只用于一致性校验，
      不一致直接 `409 HOST_DTLS_FINGERPRINT_MISMATCH`，detail 里写清两边各是什么
    - 新增 `POST /api/v1/hosts/:bindingId/dtls-fingerprint`：存量绑定把老指纹换成 DTLS 指纹的入口。
      需要账号 Bearer；**先校验归属再写入**（顺序反了会变成猜到 bindingId 就能改别人的指纹）；
      非归属账号与不存在统一返回 404，指纹被别的 Host 占用返回 409
    - `binding-store.ts` 与本地栈用的 `persistence.ts` 两份实现都补了 `updateHostDtlsFingerprintById`，
      语义保持一致（指纹全局唯一）
    - 新增 `apps/control-api/src/dtls-fingerprint.ts`：指纹比较先归一化再比。
      能认出标准 SHA-256 摘要（64 个十六进制字符）时只比摘要，忽略算法前缀、大小写和分隔符；
      认不出来就退回整串大写比较，不做猜测性裁剪。**只处理写法差异，不降低强度**
    - 测试：新增 4 条接口用例（自报指纹不一致被拒 / 同一指纹不同写法按一致处理 /
      重新登记后客户端拿到新指纹 / 重新登记要求登录、归属正确、指纹非空）
      + 4 条归一化单测
    - `pnpm --filter @codingns-proxy/control-api test` → 72 通过，1 个既有失败与本轮无关
      （同 W3.3 记录的那条）
  - 客户端侧（随 W2.2，2026-09-16 已完成）：
    - `apps/user-app/src/network/webrtc/dtls-fingerprint.ts`：从 answer SDP 解析 `a=fingerprint`，
      与控制面下发的值归一化后比对；不一致直接断开，**不提供任何降级开关**
    - 两个刻意的设计：用抛错而不是返回布尔值（调用点在建连流程里，返回值容易被漏判）；
      两边都解析不出指纹时判失败（宁可断开，也不要「都没解析出来所以放行」）
    - **端到端验证**：真实链路上把控制面下发的指纹改掉一位，客户端拒绝连接真实的 Host，
      给出的原因是「对方的身份指纹和你的 Host 记录不一致，连接已断开。
      这通常意味着连接被第三方劫持了」，不是裸错误码
  - 整条链路的说明文档：`docs/20260916-DTLS指纹登记与校验说明.md`
  - 没做：证书轮换 UI（按任务要求不做）
  - 本次补上的 Host 侧（随 W1.1，2026-09-16）：
    - Host 首次启用时用 werift 的 `RTCDtlsTransport.SetupCertificate()` 生成一张自签 ECDSA P-256 证书，
      指纹按 `sha-256 XX:XX:...` 格式化；证书材料落进 `instance_relay_tunnel_identity` 同一行
      （新增 6 个 `dtls_*` 列 + 一条 host migration，不新开表），所以**指纹跨重启稳定**
    - 子进程用 `new RTCCertificate(privateKeyPem, certPem, signatureHash)` 并通过 `RTCPeerConnection`
      的 `certificates` 选项传进去，保证握手用的就是登记的那张证书
    - 换票时把 DTLS 指纹作为 `hostDtlsFingerprint` 上传做一致性校验
    - 心跳 `POST /api/v1/hosts/:bindingId/heartbeat` 的 `hostFingerprint` 也改成 DTLS 指纹
      （原来传的是 x25519 指纹，换承载层后会一直 409）
    - `POST /api/v1/hosts/bind` 的 `hostFingerprint` 同样改成 DTLS 指纹，
      这样新绑定一步到位，不需要事后补登记
    - `config.hostKeyFingerprint` 在存在 DTLS 身份时收敛成 DTLS 指纹，
      设置页「Host 指纹」显示的就是客户端要校验的那个值
    - **存量绑定自动迁移**：换票或心跳收到 `409 HOST_DTLS_FINGERPRINT_MISMATCH` 时，
      自动调 `POST /api/v1/hosts/:bindingId/dtls-fingerprint` 重新登记，然后**只重试一次**；
      重新登记本身失败（401 / 404 / 409）才上报成需要用户处理的错误，并写清该怎么做。
      老用户升级后不用重新绑定、不用换域名、没有新增界面步骤
    - 验证：
      - 单测：`tests/integration/relay-tunnel-webrtc-runtime-adapter.test.ts` 覆盖
        「首次换票带指纹 / 409 后自动登记再重试 / 只重试一次 / 登记冲突与绑定丢失的提示文案 / 登录失效提示」
      - 真链路：`scripts/relay-tunnel-webrtc-adapter-e2e.mjs` 12/12。其中
        `adapter.dtls_fingerprint.registered` + `adapter.ticket.reregistered_fingerprint`
        是**真的撞上了 409 并自动完成迁移**（两次运行之间换了证书），不是构造出来的
      - 真链路：`scripts/relay-tunnel-webrtc-supervise-e2e.mjs` 里显式把绑定指纹置成旧值，
        验证控制面返回 `409 HOST_DTLS_FINGERPRINT_MISMATCH`，重新登记后换票立即成功（201）
      - 心跳口径：DTLS 指纹 → 204；老的 x25519 指纹 → 409 `HOST_BINDING_MISMATCH`
    - 没做：证书轮换 UI（按任务要求不做）

- [x] W4.2 固定「中继不可见明文」的验收清单
  - 状态：DONE（2026-09-17 三层全部通过，第二层已在生产服务器上真抓包）
  - 这一步到底做什么：写出并执行抓包、日志、数据库三层验收步骤，证明信令和 TURN 都拿不到明文
  - 做完以后能看到什么结果：有一份可重复执行的验收记录
  - 依赖什么：W3.2、W4.1
  - 主要改哪些文件：
    - `specs/spec001.9/docs/*`
  - 这一步明确不做什么：不拿「看起来差不多」当验收
  - 怎么验证：
    - 抓包记录 + 测试命令固化
  - 已完成：
    - 清单已落库 `docs/20260916-中继不可见明文验收清单.md`，拆成三层，每层都写清
      「怎么执行 / 通过判据 / 失败判据 / 要留什么证据」
    - **第一层（信令层）已自动化**：新增用例
      「信令链路不承载业务数据：业务形状的消息一律拒绝且不转发」——
      客户端发一条 `type: "http.request"` 的业务形状消息，断言发送方收到 `MESSAGE_INVALID`
      且 **Host 侧消息条数一条都没多**。`pnpm --filter @codingns-proxy/relay-signaling test`
      → 25 通过
    - 记了一条已知边界：SDP 是文本字段，理论上可以被塞额外字节让信令服务器搬运；
      这不影响「中继不可见明文」（DTLS 密钥不在 SDP 里），但信令通道不该当数据通道用
  - 第二层执行要求（已按此执行完毕）与此前的有限条件记录：
    - **第二层（TURN 抓包）必须在 TURN 部署完成后真跑**：强制 `iceTransportPolicy: "relay"`，
      先用 `apps/host/scripts/relay-tunnel-webrtc-e2e.mjs` 确认链路类型真的是 `relay`
      （不是 `p2p`），再用一个自己造的、不可能碰巧出现的字符串做业务内容，
      在 TURN 服务器上 `tcpdump -i any -n -s0 -A port 3478`，确认搜不到该字符串，
      也搜不到 `GET `/`POST `/`/api/`
    - **抓包需要 root，开发机上拿不到**（macOS 上 `lo0` 同样要权限）。
      所以这一层要在目标服务器上做，不能在本地糊弄过去。
      拿不到 root 时最多只能做到「链路类型是 relay」——**那只证明流量经过中继，
      证明不了中继看不到内容，两者不能互相替代**，验收记录里必须写清楚实际做到哪一步
    - **第二层已在正式服务器上抓包验证（2026-09-16，有限条件下）**：
      因为公网 TURN 端口还在等云安全组放行，改用一个**临时 coturn 实例**在服务器的
      Tailscale 地址上做（临时实例、临时端口、临时中继段，**全程没碰生产 coturn 配置**，
      做完即停并清理）：
      - 从本机（10.255.0.83，经代理到服务器）跑 `turn-relay-check.mjs`：
        两端候选都是 `relay`，选中的候选对 `relay 100.64.0.3:49310 ↔ relay 100.64.0.3:49309`，
        一条特意造的标记串原样穿过中继，`exit 0`
      - 服务器上 `tcpdump -i any -n -s0 -A` 抓 327 行，判定结果：
        **业务标记串出现 0 次**、**`GET `/`POST `/`/api/` 出现 0 次**
      - 抓包里能看到的是 TURN **协议层**的东西（`Unauthorized`、realm `channel.codingns.com`、
        `Coturn-4.5.2`、以及 TURN REST 凭据的用户名标识），这些是连接元数据不是业务内容
      - **必须说清这次的边界**：两个 WebRTC peer 都在本机，所以
        **client ↔ TURN 那一跳是真跨网**（我的机器 → 服务器），
        而 **peer ↔ TURN 那一跳落在服务器本地**（抓包里能看到 `lo` 上 49309↔49310 的转发）。
        要跑通「两个公网端点 + 生产 coturn + 生产端口」的完整形态，需要另一台公网机器上跑着 Host，
        这属于 W7 真实网络验收的范围，**不能用这次的结果冒充**
    - 第三层里的控制面库检查已按真实 schema 写准（2026-09-16 核对 `database-migrations.ts`）：
      思路从「搜关键词」改成**先确认表里根本没有能放内容的列**——
      `relay_usage_events` 与 `relay_usage_daily_summaries` 的列只有标识、字节数、时间戳，
      没有任何 text / json / blob 业务内容列；再列一遍全库的 text / json / bytea 列逐个确认。
      **列结构能证明「这里压根没地方可以存」，比「这次没搜到」强得多**，
      而且以后有人加了内容列这个检查会立刻失败。清单里附了两张表的完整列。
      信令日志与 Host 侧已可从代码走查确认（Host 接入进程不写任何持久化）
    - 按清单要求把三层的原始输出追加成一份验收记录
  - 结论口径（已满足）：**第二层没真跑完之前，W4.2 不算完成**。
    第一层通过只说明「我们自己的服务没被当通道用」，说明不了「中继看不到明文」。
    下面是 2026-09-17 第二层真跑完的结果。
  - **第二层已在生产服务器上真抓包完成（2026-09-17，安全组放行后）**：
    - 抓包窗口里跑的是**真实完整链路**，不是构造的 demo：真实客户端 transport
      （`ManagedWebRtcTunnelHostTransport`）+ 真实 Host 接入子进程，端到端 **9/9 通过**，
      含 `GET /api/client/runtime-config`、1 MB 的 `POST /api/client/upload`、
      120 KB 的 WebSocket 大消息。抓的就是这些真实业务字节
    - 服务器上 `sudo tcpdump -i any -n -s0 -U -w /tmp/turn-cap.pcap
      'port 3478 or udp portrange 49152-49200'`，共 `9166` 个包，按网络跳拆开判定：
      - **跨网跳（本机 ↔ 生产 TURN，3478）：6120 个包 / 4,535,648 字节载荷，
        业务明文 0 命中**；DTLS 记录 `Handshake 26` + `ApplicationData 6040` + `ChangeCipherSpec 4`
      - 服务器本地 `lo`（中继端口互转）：3046 个包 / 2,254,360 字节，业务明文 0 命中，
        DTLS 记录 `Handshake 13` + `ApplicationData 3020` + `ChangeCipherSpec 2`
    - 搜的明文特征**全部 0 次命中**：`runtime-config`、`/api/client/upload`、`local-business`、
      `GET ` / `POST `、`HTTP/1.1`、`/api/`、`Host:`、`content-type`、
      120 KB WS 消息内容（`zzzz…`）、`"ok":true`
    - **正向证据齐**：中继链路上确实抓到了 6040 条 DTLS ApplicationData。
      「0 命中」如果建立在空抓包上没有意义，这次不是空抓包
    - coturn 全程没改配置、没重启，服务 `active`；抓包用 root，做完即停并清理临时文件
    - 第三层也在生产库上跑了：`relay_usage_events` / `relay_usage_daily_summaries`
      的列只有标识、字节数、时间戳；全库按 `body/content/payload/message/request/response`
      搜列名只命中 `email_verification_requests` 的 `request_id` / `requested_at`（都不是业务内容）；
      信令日志里 `GET `/`POST `/`/api/`/`HTTP/1.1` 各 0 命中
    - **这次明确没做到的**：两个 WebRTC peer 都在本机，所以 `client ↔ TURN` 那一跳是真跨公网的
      （4.5 MB 载荷，只有密文），而 `peer ↔ TURN` 那一跳落在服务器本地 `lo`。
      完整的双公网端点形态属于 W7，**不能用这次结果冒充**
    - 完整记录：`specs/spec001.9.1-公共隧道服务二阶段收口与生产化验收/docs/20260917-生产环境TURN跨网与中继密文验收记录.md`

---

## 阶段 W5：计费模型切换

- [ ] W5.1 控制面订阅模型
  - 状态：TODO
  - 这一步到底做什么：把「流量包 + 流量钱包」改成「周期订阅」，订单和支付流程跟着调整
  - 做完以后能看到什么结果：用户能买订阅、能续费、能在控制台看到状态
  - 依赖什么：W0.3
  - 主要改哪些文件：
    - `apps/codingns-proxy/apps/control-api/*`
    - `apps/codingns-proxy/apps/console-web/*`
  - 这一步明确不做什么：不做复杂套餐组合和团队共享
  - 怎么验证：
    - 订单与订阅状态一致性测试

- [ ] W5.2 用量统计改成风控口径
  - 状态：TODO
  - 这一步到底做什么：保留用量记录但标注来源为客户端上报；TURN 用量以服务端实测为准
  - 做完以后能看到什么结果：界面不再出现「剩余流量耗尽后断流」这类硬限额语义
  - 依赖什么：W5.1
  - 主要改哪些文件：
    - `apps/codingns-proxy/apps/control-api/*`
    - `apps/codingns-proxy/apps/console-web/*`
  - 这一步明确不做什么：不删除历史用量数据
  - 怎么验证：
    - 接口测试 + 文案走查

- [ ] W5.3 TURN 限速与告警
  - 状态：TODO
  - 这一步到底做什么：对走 TURN 的会话单独限速，并监控 TURN 用量异常
  - 做完以后能看到什么结果：TURN 成本可控，异常增长能被发现
  - 依赖什么：W3.2
  - 主要改哪些文件：
    - `apps/codingns-proxy/*`
  - 这一步明确不做什么：不做自动封禁
  - 怎么验证：
    - 限速生效验证 + 告警触发验证

---

## 阶段 W6：下线旧链路

- [x] W6.1 删除自研加密协议
  - 状态：DONE（三份拷贝全部删除，共约 4800 行）
  - 这一步到底做什么：把三份协议副本全部删掉，包括已经没用的死代码
  - 做完以后能看到什么结果：仓库里再也搜不到自研握手和加密帧
  - 依赖什么：W2.2、W4.1；**第三份副本（relay-edge）要等 W6.2 把 relay-edge 数据面停掉才能删**
  - **Host 侧与 user-app 侧已于 2026-09-16 完成**：
    - Host 侧删除 `relay-tunnel-runtime-adapter.ts`（869 行）、`crypto/relay-tunnel-protocol.ts`（584 行）、
      `relay-tunnel-edge-proof.ts`（52 行）及对应两个测试文件
    - user-app 侧删除 6 个源文件（`relay-tunnel-protocol.ts` 658 行等）与 5 个测试文件，共约 2446 行
    - 前置核实：Host 没有别的入口在服务老客户端（`relay-tunnel-controller.ts` 只是 Fastify HTTP 路由、
      `ws/ws-server.ts` 里没有 relay 引用），所以这是纯死代码清理，不改运行时行为
    - 连带改动：`RelayTunnelRuntimeHttpError` 是适配器与服务之间的契约（不是老适配器的私货），
      已迁到 `relay-tunnel-runtime-error.ts`，`relay-tunnel-background.test.ts` 的 import 跟着改
    - **验证**：host `tsc` 通过、relay-tunnel 相关 **133 个测试全绿**；
      user-app `tsc` 通过、相关 **135 个测试全绿**；E2EE 关键词全仓无残留。
      原先两条长期红灯（老适配器超时、网关用例停留在旧协议形状）一条随删除消失、一条已修
    - **明确保留**：`relay-tunnel-identity-service.ts`（DTLS 证书材料复用同一行记录）、
      Host 侧 `relay-tunnel-packets.ts`（网关包类型是业务多路复用协议不是加密套件）、
      `relay-session-traffic-store.ts`（新传输也在用它记会话用量）、
      `secret-box.ts` 里的 aes-256-gcm（存控制站 token 用的通用加密，与隧道无关）
  - **relay-edge 那一份（2026-09-16 已完成）**：那份是**封闭死代码簇**，4 个文件互相引用、外部零引用，
    删除是纯清理、无行为变更，已直接删掉：
    - `relay-tunnel-client-session.ts`（239 行）
    - `relay-tunnel-protocol.ts`（567 行）
    - `relay-tunnel-identity.ts`（37 行）
    - `relay-tunnel-packets.ts`（75 行）
    - 共 918 行。验证：`pnpm --filter @codingns-proxy/relay-edge exec tsc -p tsconfig.json --noEmit`
      通过；`pnpm --filter @codingns-proxy/relay-edge test` → 34 通过
    - `host-proof.ts`（172 行）当时没删：它还被 `relay-edge/src/app.ts` 用来做 Host 挑战应答。
      已在 W6.2 连同整个 `apps/relay-edge` 一起删除
  - **实际删除清单（执行记录）**：
    - Host 侧：`relay-tunnel-runtime-adapter.ts`（869 行）、`crypto/relay-tunnel-protocol.ts`（584 行）、
      `relay-tunnel-edge-proof.ts`（52 行），以及 `relay-tunnel-runtime-adapter.test.ts`、
      `relay-tunnel-protocol.test.ts`
    - user-app 侧：`relay-tunnel-protocol.ts`（658 行）、`relay-tunnel-client-transport.ts`（522 行）、
      `relay-tunnel-edge-client.ts`（500 行）、`relay-tunnel-client-session.ts`（373 行）、
      `relay-tunnel-managed-transport.ts`（304 行）、`relay-tunnel-packets.ts`（89 行），
      以及对应 5 个测试文件
    - relay-edge 侧：见上一段的 918 行（已先行删除）
  - **明确保留的东西，以及为什么不删**：
    - `relay-tunnel-identity-service.ts`：DTLS 证书材料是作为**同一行的新列**存在
      `instance_relay_tunnel_identity` 里的，这个服务仍负责那行记录的读写。
      x25519 那几列是保留还是走一次迁移删掉，留到后续决定
    - Host 侧 `relay-tunnel-packets.ts`：里面的**网关包类型**是「一条连接上怎么复用多条
      HTTP / WebSocket 流」的业务协议（streamId 多路复用），不是加密套件，WebRTC 链路照样要用。
      WebRTC 只是换掉了它的**编码方式**（base64 JSON → `@codingns/relay-tunnel-wire` 二进制帧）
    - `network/relay-session-traffic-store.ts`：新传输也在用它记会话用量，
      工作台的 `WorkbenchHostSwitcher` 还在展示它。按 W0.3 的口径用量数据降级为
      「展示 + 风控参考」，这个 store 正好是展示那一半
    - `shared/utils/secret-box.ts` 里的 `aes-256-gcm`：那是存控制站 token 用的通用加密，
      跟隧道端到端加密没关系，别看到关键词就一起删
  - **删除后的连带改动**：`RelayTunnelRuntimeHttpError` 已从老适配器搬到
    `relay-tunnel-runtime-error.ts`（它是适配器与服务之间的契约），
    `relay-tunnel-background.test.ts` 的 import 跟着改；另更新了两处指向已删文件的过时注释
  - 主要改哪些文件：
    - 上面清单里的 8 个文件，以及引用它们的所有调用点
  - 这一步明确不做什么：不保留「以防万一」的兼容开关
  - 怎么验证：
    - 全仓搜索确认无残留引用（`x25519`、`hkdf`、`aes-256-gcm`、`createRelayTunnelHostClaimProof`、
      `acceptRelayTunnelClientHandshake` 这些关键词应该一个都搜不到）
    - 相关测试全部清理或改写
    - `pnpm --dir apps/host exec tsc --noEmit -p tsconfig.json` 与
      `pnpm --dir apps/user-app exec tsc --noEmit -p tsconfig.json` 通过

- [x] W6.2 relay-edge 数据面下线
  - 状态：DONE
  - 这一步到底做什么：停用密文帧中继职责，保留控制面内部接口但改语义
  - 做完以后能看到什么结果：数据面只剩信令和 TURN
  - 依赖什么：W3.1、W3.2
  - 实际做了什么：
    - 删掉 `apps/relay-edge/*` 全部代码（密文转发、会话注册表、Redis 共享状态、usage 补报）
    - 在线会话改从信令服务读（`GET /api/internal/signaling/bindings`），
      `relay-edge-client` 相应改名成 `online-session-source`
    - `POST /api/v1/tunnels/:tunnelDomain/connect-init` 改成 410 `LEGACY_TRANSPORT_RETIRED`
    - 四级域名入口跳转从 relay-edge 搬到 control-api。这是动手时才发现的范围：
      它不是数据面，但一直挂在 relay-edge 上，而新前端依赖它，
      所以必须在停进程之前先搬走
    - 部署链路同时清掉 relay-edge 与 Redis：pm2 模板、nginx 模板、
      一键部署脚本、本地联调脚本
  - 主要改哪些文件：
    - `apps/codingns-proxy/apps/relay-edge/*`（删除）
    - `apps/codingns-proxy/apps/control-api/src/entry-redirect.ts`（新增）
    - `apps/codingns-proxy/apps/control-api/src/online-session-source.ts`（新增）
    - `apps/codingns-proxy/deploy/templates/*`、`scripts/deploy-production.sh`
  - 这一步明确不做什么：不保留双轨长期运行
  - 怎么验证：
    - 部署验证 + 旧链路明确拒绝
    - 生产实测（2026-09-17）：
      - `pm2 delete codingns-proxy-relay-edge`，4320 端口已无监听；
        relay-edge 日志自 2026-04-21 起一直是 0 字节，确认本来就没人用
      - 四级域名 `izozo.channel.codingns.com` 仍返回 302 到
        `https://app.codingns.com/connect/...`，参数与停用前完全一致
      - 旧链路 `POST /api/v1/tunnels/.../connect-init` 返回 410
      - 主站首页、`/api/public/meta`、`/signaling/healthz` 均 200

- [ ] W6.3 存量绑定与订阅迁移
  - 状态：TODO
  - 这一步到底做什么：把已有绑定关系和流量钱包数据迁移到新模型
  - 做完以后能看到什么结果：老用户不用重新绑定，已购流量有明确处置
  - 依赖什么：W5.1
  - 主要改哪些文件：
    - `apps/codingns-proxy/apps/control-api/src/scripts/*`
    - 数据库迁移
  - 这一步明确不做什么：不做自动退款
  - 怎么验证：
    - 迁移脚本幂等性测试 + 迁移后读回验证

---

## 阶段 W7：回归与验收

- [ ] W7.1 真实网络吞吐验收
  - 状态：TODO
  - 这一步到底做什么：在真实链路（跨地域、弱网、对称 NAT）跑吞吐和延迟，不能只测 loopback
  - 做完以后能看到什么结果：知道真实可用性能，能判断上行 3–6 MB/s 够不够用
  - 依赖什么：W1.2、W2.1
  - 主要改哪些文件：
    - 验收记录
  - 这一步明确不做什么：不做性能优化
  - 怎么验证：
    - 实测记录 + 与业务典型流量对照

- [ ] W7.2 移动端真机验收
  - 状态：TODO
  - 这一步到底做什么：在 iOS 和 Android 真机上验证 WebRTC 建连、指纹校验和传输
  - 做完以后能看到什么结果：确认移动端可用
  - 依赖什么：W2.1
  - 主要改哪些文件：
    - 验收记录
  - 这一步明确不做什么：不改移动端壳工程
  - 怎么验证：
    - 真机联调记录

- [ ] W7.3 长时间稳定性验收
  - 状态：TODO
  - 这一步到底做什么：连续跑几十分钟到几百 MB，观察内存、CPU 和性能衰减
  - 做完以后能看到什么结果：确认纯 JS 实现能不能长期跑
  - 依赖什么：W1.2
  - 主要改哪些文件：
    - 验收记录
  - 这一步明确不做什么：不做压测平台
  - 怎么验证：
    - 长跑记录（内存曲线、吞吐变化）

- [ ] W7.4 自动直连与回退回归
  - 状态：TODO
  - 这一步到底做什么：验证直连可用、直连断开能回落中继、旧客户端不受影响
  - 做完以后能看到什么结果：链路切换不会把现有远程访问搞挂
  - 依赖什么：W2.3、W3.2
  - 主要改哪些文件：
    - 集成测试
    - 验收记录
  - 这一步明确不做什么：不顺手扩需求
  - 怎么验证：
    - 集成测试 + 手工联调记录

---

## 附：改版对既有实现的具体影响

上一版留下、这一版需要跟着调整的地方：

- `InstanceRelayTunnelStatus` 的阶段枚举要按新链路调整：`running` 拆成 `running_p2p` / `running_relay`
- 设置页面板要补「当前链路类型」展示（新增需求 11）
- 指纹字段语义从「Host 公钥指纹」换成「DTLS 指纹」
- 控制面「流量钱包 / 超额断流」相关语义按 `W5` 调整，界面上不再出现硬限额文案
- `relay-edge` 的 Host challenge / claim-next-session 链路随数据面一起下线

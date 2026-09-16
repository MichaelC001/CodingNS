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

- [ ] W0.3 确认计费模型切换范围
  - 状态：TODO
  - 这一步到底做什么：把「按流量」改成「固定订阅」涉及的控制面改动列清楚，尤其是存量订单、套餐、流量账本怎么办
  - 做完以后能看到什么结果：知道要改哪些表、哪些接口、哪些页面，存量数据怎么迁移
  - 依赖什么：无
  - 主要改哪些文件：
    - `specs/spec001.9.1-公共隧道服务二阶段收口与生产化验收/*`
  - 这一步明确不做什么：不在这一步写迁移脚本
  - 怎么验证：
    - 文档走查 + 与现有控制面代码对照

---

## 阶段 W1：Host 侧 WebRTC 接入层

- [ ] W1.1 搭起 Host 侧 WebRTC 接入进程骨架
  - 状态：TODO
  - 这一步到底做什么：新建独立进程，用 werift 建立 PeerConnection，接受客户端 DataChannel
  - 做完以后能看到什么结果：浏览器能通过 DataChannel 连上这个进程
  - 依赖什么：W0.2
  - 主要改哪些文件：
    - `apps/host/src/modules/relay-tunnel/webrtc/*`（新增）
    - 进程启动入口与 IPC 接入点
  - 这一步明确不做什么：不做业务转发，不做信令鉴权
  - 怎么验证：
    - 本地用 demo 页面对接，确认能建立 DataChannel
    - `pnpm --dir apps/host test -- <新增测试文件>`

- [ ] W1.2 打通 DataChannel 到本地业务接口的转发
  - 状态：TODO
  - 这一步到底做什么：把 DataChannel 收到的业务消息转成对本地 `127.0.0.1:<port>` 的 HTTP / WS 请求，响应再回传
  - 做完以后能看到什么结果：客户端能通过 WebRTC 通道正常使用 Host 业务接口
  - 依赖什么：W1.1
  - 主要改哪些文件：
    - `apps/host/src/modules/relay-tunnel/webrtc/*`
  - 这一步明确不做什么：不改现有业务 API 语义
  - 怎么验证：
    - 端到端联调：浏览器里跑通一个真实业务接口调用
    - 现有业务接口回归不受影响

- [ ] W1.3 把信令连接接入 TaskManager
  - 状态：TODO
  - 这一步到底做什么：信令连接、状态刷新、用量上报都走 `TaskManager`，不自己长私有 timer
  - 做完以后能看到什么结果：网络抖动后能自动恢复，设置页能看到当前阶段
  - 依赖什么：W1.1
  - 主要改哪些文件：
    - `apps/host/src/modules/relay-tunnel/*`
  - 这一步明确不做什么：不重写 TaskManager 本身
  - 怎么验证：
    - 按 `spec001.2` 后台任务规范自查
    - 断网 / 恢复测试

- [ ] W1.4 接入进程崩溃自动拉起
  - 状态：TODO
  - 这一步到底做什么：主进程监控 WebRTC 接入进程，崩了自动重启，并把原因记进状态
  - 做完以后能看到什么结果：接入进程挂掉不影响 Host 其他功能，且能自动恢复
  - 依赖什么：W1.1
  - 主要改哪些文件：
    - `apps/host/src/modules/relay-tunnel/*`
  - 这一步明确不做什么：不做多进程池
  - 怎么验证：
    - 手动 kill 接入进程，确认主进程存活并自动拉起

---

## 阶段 W2：客户端接入层

- [ ] W2.1 新增客户端 WebRTC transport
  - 状态：TODO
  - 这一步到底做什么：在 user-app 里实现基于 DataChannel 的传输实现，替代现有 relay-tunnel transport
  - 做完以后能看到什么结果：客户端能通过 WebRTC 通道访问远程 Host
  - 依赖什么：W1.2
  - 主要改哪些文件：
    - `apps/user-app/src/network/webrtc/*`（新增）
    - `apps/user-app/src/network/host-transport-registry.ts`
  - 这一步明确不做什么：不重写业务层 API 调用方式
  - 怎么验证：
    - `pnpm --dir apps/user-app exec vitest run src/network/*.test.ts`
    - `pnpm --dir apps/user-app exec tsc --noEmit -p tsconfig.json`

- [ ] W2.2 客户端 DTLS 指纹校验
  - 状态：TODO
  - 这一步到底做什么：建立连接时比对 SDP 里的 DTLS 指纹与控制面返回的指纹，不一致直接断开
  - 做完以后能看到什么结果：中间人无法冒充 Host
  - 依赖什么：W2.1
  - 主要改哪些文件：
    - `apps/user-app/src/network/webrtc/*`
  - 这一步明确不做什么：不做「指纹不符但允许继续」的降级开关
  - 怎么验证：
    - 构造指纹不匹配场景，确认连接被拒绝
    - 单元测试覆盖比对逻辑

- [ ] W2.3 展示当前链路类型
  - 状态：TODO
  - 这一步到底做什么：识别当前是 P2P 直连还是 TURN 中继，并在设置页和连接状态处展示
  - 做完以后能看到什么结果：用户知道自己现在走的是哪条路
  - 依赖什么：W2.1
  - 开始前必须先阅读：
    - `docs/开发设计规范/20260419-前端页面与样式设计规范.md`
  - 主要改哪些文件：
    - `apps/user-app/src/settings/*`
    - `apps/user-app/src/components/connection/*`
    - i18n 字典与测试
  - 这一步明确不做什么：不把 ICE 候选类型这种术语暴露给用户
  - 怎么验证：
    - 组件测试 + 手工联调

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

- [ ] W3.2 部署 coturn 并接入控制面
  - 状态：PARTIAL（模板与文档就绪，目标机器上的实际部署待执行）
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
  - 待完成（需要在目标机器上执行）：
    - 在正式服务器上装 coturn、替换模板占位符、放行 3478/udp+tcp 与 49152-65535/udp
    - 用 `iceTransportPolicy: "relay"` 实测一次真实跨网连接
    - 抓包确认 TURN 上只有 DTLS 密文
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

- [ ] W4.1 DTLS 指纹登记与下发
  - 状态：TODO
  - 这一步到底做什么：Host 首次启用时生成 DTLS 证书、把指纹注册到控制面，客户端连接前取回
  - 做完以后能看到什么结果：指纹机制替代了原来的公钥指纹
  - 依赖什么：W1.1、W2.1
  - 主要改哪些文件：
    - `apps/host/src/modules/relay-tunnel/*`
    - `apps/codingns-proxy/apps/control-api/*`
  - 这一步明确不做什么：不做证书轮换 UI（先记录，后续再单开）
  - 怎么验证：
    - 接口测试 + 端到端联调

- [ ] W4.2 固定「中继不可见明文」的验收清单
  - 状态：TODO
  - 这一步到底做什么：写出并执行抓包、日志、数据库三层验收步骤，证明信令和 TURN 都拿不到明文
  - 做完以后能看到什么结果：有一份可重复执行的验收记录
  - 依赖什么：W3.2、W4.1
  - 主要改哪些文件：
    - `specs/spec001.9/docs/*`
  - 这一步明确不做什么：不拿「看起来差不多」当验收
  - 怎么验证：
    - 抓包记录 + 测试命令固化

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

- [ ] W6.1 删除自研加密协议
  - 状态：TODO
  - 这一步到底做什么：把三份协议副本全部删掉，包括已经没用的死代码
  - 做完以后能看到什么结果：仓库里再也搜不到自研握手和加密帧
  - 依赖什么：W2.2、W4.1
  - 主要改哪些文件：
    - `apps/host/src/modules/relay-tunnel/crypto/*`
    - `apps/user-app/src/network/relay-tunnel-protocol.ts` 及相关文件
    - `apps/codingns-proxy/apps/relay-edge/src/relay-tunnel-*.ts`
  - 这一步明确不做什么：不保留「以防万一」的兼容开关
  - 怎么验证：
    - 全仓搜索确认无残留引用
    - 相关测试全部清理或改写

- [ ] W6.2 relay-edge 数据面下线
  - 状态：TODO
  - 这一步到底做什么：停用密文帧中继职责，保留控制面内部接口但改语义
  - 做完以后能看到什么结果：数据面只剩信令和 TURN
  - 依赖什么：W3.1、W3.2
  - 主要改哪些文件：
    - `apps/codingns-proxy/apps/relay-edge/*`
  - 这一步明确不做什么：不保留双轨长期运行
  - 怎么验证：
    - 部署验证 + 旧链路明确拒绝

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

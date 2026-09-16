# 设计文档 - spec001.9 公共隧道服务接入与端到端加密远程访问

状态：Draft（2026-09-16 按 WebRTC 承载层改版）

## 0. 这版改了什么，为什么改

上一版设计的是「WSS 盲中继 + 自研应用层端到端加密」。这一版换成「WebRTC DataChannel」。

换的原因不是追新，是算账算出来的：

1. **自研加密这套东西太重**：x25519 + HKDF + AES-GCM + 握手 proof + 加密帧 + base64 信封，
   658 行代码在 `apps/host`、`apps/user-app`、`relay-edge` 各存一份副本，靠人工保持一致，
   其中 relay-edge 那份已经是死代码。WebRTC 的 DTLS 本身就是端到端加密，
   这部分可以整段删掉。
2. **P2P 直连能省掉中继带宽成本**：打洞成功后数据根本不过我们的服务器。
3. **中继看不到明文这条底线仍然成立**：DTLS 在客户端和 Host 之间协商，信令服务器和 TURN 都拿不到密钥。

代价也很明确，写在这里不回避：

- **Host 侧只能用 werift（纯 TypeScript）**，另一个候选 node-datachannel 收数据会丢，已实测出局。
- **上行吞吐只有 3–6 MB/s**，下行 21–31 MB/s。下行够用，上行是瓶颈。
- **必须配 STUN，且必须有 TURN 兜底**，不然局域网直连会退化、NAT 打洞失败时连不上。

实测数据和复现步骤见 `docs/20260916-WebRTC承载层验证结论.md`，那份文档是本设计的依据。

一句话：
**这次是把「自建加密 + 自己转发」换成「用浏览器原生的加密能力 + 能直连就直连、连不上才走 TURN」。**

## 1. 概述

### 1.1 目标

- 让没有公网地址的 Host 也能通过 CodingNS 官方公共隧道服务被访问
- 优先走 P2P 直连，把中继带宽成本降到最低
- 端到端加密由 WebRTC 的 DTLS 直接提供，不再自研
- 在本仓库内实现 Host 侧接入层、客户端 / H5 接入层和信令交互
- 把公共云站点、支付、账号和数据面信令放到独立子仓库
- 保持现有 Host 业务接口、登录体系和本地直连流程稳定

### 1.2 覆盖需求

- `requirements.md` 需求 1：强制分仓
- `requirements.md` 需求 2：实例级公共隧道配置模型
- `requirements.md` 需求 3：账号绑定
- `requirements.md` 需求 4：端到端加密信道
- `requirements.md` 需求 5：可信接入端边界
- `requirements.md` 需求 6：保留现有业务认证
- `requirements.md` 需求 7：用量统计（风控口径，不再作为计费依据）
- `requirements.md` 需求 8：固定订阅购买
- `requirements.md` 需求 9：长连接、自动重连和启动恢复
- `requirements.md` 需求 10：未初始化实例阻断

### 1.3 技术约束

- Host 继续沿用现有 `Node.js + Fastify`，业务接口不动
- WebRTC 实现固定用 `werift`（纯 TypeScript，行为可控、能自己打补丁）
- **PeerConnection 必须跑在独立进程里**：底层一旦抛未捕获异常会直接杀掉 Node 主进程
- 客户端侧统一走系统 WebView / 浏览器原生 WebRTC，不引入第三方 WebRTC SDK
- 公共隧道数据面必须默认视为不可信，只能看到密文字节和连接元数据
- 前端显示文案必须进入 i18n 字典

### 1.4 当前实现诊断

当前项目已有的访问方式：

1. 本地 / 局域网直连
2. `spec001.4` 定义的 Tailscale 远程访问
3. `spec001.9`~`spec001.9.4` 已落地的 WSS 盲中继公共隧道（线上运行中）

第 3 条是本版要替换的对象。它已经跑通了账号、绑定、三级域名、流量账本、订单支付这一整套控制面，
**这些控制面能力继续保留**，要换的是数据面承载方式和加密实现。

需要替换的具体部分：

| 现有实现 | 位置 | 处置 |
| --- | --- | --- |
| 自研端到端加密协议 | `apps/host/src/modules/relay-tunnel/crypto/*`、`apps/user-app/src/network/relay-tunnel-protocol.ts` | 删除 |
| WSS 密文帧中继 | `relay-edge/src/session-registry.ts` | 替换为信令 + STUN/TURN |
| Host 挑战应答与公钥指纹 | `host-proof.ts`、`relay-tunnel-identity-service.ts` | 删除，改校验 SDP DTLS 指纹 |
| 会话实例亲和 | `session-registry.ts` | 删除，P2P 连接不需要会话粘性 |
| 按字节计费的计量链路 | `usage-reporter.ts`、控制面 usage 接口 | 保留但降级为风控参考 |

一句人话：
**控制面基本不用动，数据面要换一遍。**

## 2. 总体架构

### 2.1 三个边界，别混

1. **本仓库**
   - Host 侧 WebRTC 接入层（werift 独立进程）
   - 客户端 / H5 接入层（浏览器原生 WebRTC）
   - 信令交互与身份校验
   - 设置页和状态接口
2. **独立子仓库：`apps/codingns-proxy/`**
   - 账号系统
   - 支付、订单、订阅
   - 信令服务器
   - STUN / TURN 服务（coturn）
3. **现有 Host 业务层**
   - 继续提供 `/api/*` 和 `/ws`
   - 继续负责业务登录、Token 和权限

### 2.2 信任模型

#### 2.2.1 谁能看到什么

| 角色 | 能看到 | 看不到 |
| --- | --- | --- |
| 信令服务器 | 哪个账号、哪个 Host、SDP、ICE 候选、何时建立/断开 | 业务明文、DTLS 密钥 |
| STUN | 客户端的公网地址映射 | 业务明文 |
| TURN | 转发的密文字节数、连接元数据 | 业务明文、DTLS 密钥 |
| 对端 | 对方的公网 IP（P2P 直连时） | — |

**DTLS 密钥只在客户端和 Host 之间协商，中继任何环节都拿不到。**

#### 2.2.2 不能自欺欺人的地方

三条底线，缺一不可：

1. **业务 H5 必须从固定可信域名加载**，不能从用户自己的域名或中继域名加载。
   只要页面代码能被替换，后面的加密就没有意义。
2. **P2P 直连会暴露双方公网 IP**。自己连自己的设备没问题，但将来如果做「把访问权限分享给第三方」，
   必须重新评估——那时候对端不再是本人。
3. **TURN 兜底流量是真实成本**。P2P 省下的钱，会被对称 NAT 用户走 TURN 吃回去一部分，
   定价时必须把这块算进去。

### 2.3 总体链路

```text
官方客户端 / 可信 H5
        |
        | 1. 向控制面拿绑定信息 + 信令凭据
        | 2. 连信令服务器，交换 SDP / ICE 候选
        v
信令服务器（只转 SDP，不碰业务数据）
        |
        | 3. 双方尝试打洞
        |
   +----+----+
   |         |
打洞成功   打洞失败
   |         |
   |         +--> TURN 中继（只转发 DTLS 密文，可计量、可限速）
   |                   |
   +---------+---------+
             |
             v
   WebRTC DataChannel（DTLS 端到端加密）
             |
             v
   Host 侧 werift 接入层（独立进程）
             |
             | 解密后转为本地 HTTP / WS
             v
        本地 CodingNS Host
```

一句人话：
**能用直连就直连，直连不了才让 TURN 帮转发，两种情况下我们都看不到内容。**

## 3. 模块划分

### 3.1 本仓库新增 / 改造模块

| 模块 | 职责 | 位置 |
| --- | --- | --- |
| `relay-tunnel-service` | 管理实例级公共隧道配置和状态机（保留，改造） | `apps/host/src/modules/relay-tunnel/*` |
| `webrtc-host-peer` | Host 侧 werift 接入层，跑在独立进程 | `apps/host/src/modules/relay-tunnel/webrtc/*` |
| `relay-signaling-client` | 与信令服务器交互：注册、交换 SDP / ICE | `apps/host/src/modules/relay-tunnel/signaling/*` |
| `relay-system-routes` | 对设置页暴露状态、绑定、启停接口（保留） | `apps/host/src/routes/system.ts` 附近 |
| `webrtc-client-transport` | 客户端 / H5 建立 DataChannel、收发二进制帧 | `apps/user-app/src/network/webrtc/*` |
| `RemoteAccessPanel` | 远程访问设置页入口（保留，补充链路来源展示） | `apps/user-app/src/settings/*` |

**要删除的模块**：

- `apps/host/src/modules/relay-tunnel/crypto/*`（自研握手与加密帧）
- `apps/user-app/src/network/relay-tunnel-protocol.ts`、`relay-tunnel-packets.ts`、`relay-tunnel-client-transport.ts`
- `relay-edge/src/relay-tunnel-*.ts`（死代码）

### 3.2 独立子仓库模块

| 模块 | 职责 |
| --- | --- |
| `console-web` | 用户控制台站点（保留） |
| `control-api` | 账号、Host 绑定、订阅、订单、用量统计（保留，计费口径调整） |
| `relay-signaling` | 信令服务器：注册、房间、SDP / ICE 转发（新增，替代原 relay-edge 的数据面角色） |
| `turn` | coturn，NAT 打洞失败时的兜底中继（新增） |

**原 `relay-edge` 的处置**：密文帧中继职责整体移除，代码和数据面角色由信令服务器 + coturn 接替。
控制面里与它相关的内部接口（`sessions/authorize`、`sessions/consume`）保留，但语义从
「按字节授权扣量」改成「用量统计上报」。

## 4. 数据结构

### 4.1 InstanceRelayTunnelConfig

```ts
export interface InstanceRelayTunnelConfig {
  enabled: boolean;
  provider: "codingns_relay";
  signalingBaseUrl: string | null;
  controlBaseUrl: string | null;
  accountId: string | null;
  bindingId: string | null;
  hostDeviceId: string | null;
  hostDtlsFingerprint: string | null;
  localTargetBaseUrl: string;
  iceServers: IceServerConfig[];
  turnFallbackEnabled: boolean;
  updatedAt: string;
}
```

说明：

- `signalingBaseUrl` 替代原来的 `relayBaseUrl`：现在数据面入口不再是一个转发地址，而是一个信令地址
- `hostDtlsFingerprint` 替代原来的 `hostPublicKey` / `hostKeyFingerprint`：
  身份材料改用 DTLS 证书指纹，由 WebRTC 自己生成和维护
- `tunnelDomain` 不再是必须项——客户端通过控制面拿绑定信息就能连，域名只作为入口标识
- `iceServers` 里同时下发 STUN 和 TURN 地址
- `turnFallbackEnabled` 预留开关：可以按账号或套餐决定是否允许走 TURN

### 4.2 InstanceRelayTunnelStatus

```ts
export type RelayTunnelPhase =
  | "disabled"
  | "blocked_uninitialized"
  | "unbound"
  | "binding"
  | "signaling_connecting"
  | "waiting_for_peer"
  | "connecting"
  | "running_p2p"
  | "running_relay"
  | "error";

export interface InstanceRelayTunnelStatus {
  phase: RelayTunnelPhase;
  connected: boolean;
  bindingId: string | null;
  hostDtlsFingerprint: string | null;
  activeConnectionCount: number;
  transportKind: "p2p" | "relay" | null;
  usageUsedBytes: string | null;
  subscriptionStatus: "active" | "expired" | "none";
  subscriptionRenewsAt: string | null;
  lastError: string | null;
  observedAt: string | null;
}
```

说明：

- `running_p2p` 和 `running_relay` 必须分开：用户有权知道当前走的是直连还是中继
- `transportKind` 供设置页和会话提示展示当前链路来源
- 原 `trafficRemainingBytes` / `quotaResetAt` 改成订阅语义，
  用量字段保留但只作展示和风控，不再有「用完就断」的硬限额（除非风控触发）

### 4.3 传输层协议

**不再需要自定义帧结构。**

DataChannel 本身就是可靠的、有序的字节流，业务层直接收发：

- 业务 HTTP 请求 / 响应：按现有的方向封成二进制消息，两端约定一个极薄的头（类型 + 长度）
- WebSocket 消息：直接透传
- 心跳：用 DataChannel 自身的状态 + 应用层轻量 ping

对比原来的设计，这里省掉了：帧类型枚举、AAD 构造、base64 编解码、JSON 信封。

## 5. 加密方案

### 5.1 基本原则

- **端到端加密由 WebRTC 的 DTLS 提供**，不再自研
- DTLS 密钥在客户端和 Host 之间协商，信令服务器和 TURN 都拿不到
- 不允许明文回退

### 5.2 身份校验

自研的公钥登记与握手 proof 全部删除，改用 WebRTC 自带的机制：

1. Host 侧首次启用时生成 DTLS 证书，指纹（`a=fingerprint`）注册到控制面
2. 客户端连接前，先从控制面拿到 Host 的 DTLS 指纹
3. 信令交换 SDP 后，客户端比对 SDP 里的指纹与从控制面拿到的指纹是否一致
4. 不一致直接断开，不做任何自动信任

这样做的价值：
**即使信令服务器被完全控制，攻击者也换不掉指纹——因为指纹是从控制面独立取到的。**

### 5.3 关于「H5 在第三方托管平台」的边界

如果把 H5 静态资源托管在第三方平台（Vercel 之类），信任链变成：

```
第三方平台（托管 H5 代码） → 可信域名 → H5 里的 WebRTC 客户端 → Host
```

第三方平台能替换页面代码，**所以它必须被当成可信方**，这一点不能含糊。
如果连这一层也不信任，就得把 H5 换回自托管。

### 5.4 不再需要的东西

- ❌ Host 长期身份密钥对（x25519）
- ❌ 应用层握手与 proof 校验
- ❌ 会话密钥派生（HKDF）与轮换
- ❌ AES-GCM 加密帧与 AAD

## 6. 核心流程

### 6.1 首次启用与绑定流程

1. 管理员在设置页选择「公共隧道」
2. Host 检查 bootstrap 是否完成
3. Host 生成 DTLS 证书，把指纹注册到控制面
4. 管理员登录公共隧道账号
5. 控制面创建或确认 Host 绑定，返回订阅状态
6. Host 保存 `bindingId / hostDtlsFingerprint / iceServers`
7. Host 侧拉起 WebRTC 接入进程，连上信令服务器并注册
8. 状态进入 `waiting_for_peer`，有客户端接入时进入 `running_p2p` 或 `running_relay`

### 6.2 客户端访问流程

1. **客户端先登录控制站账号**（邮箱 + 密码，`POST /api/public/auth/login` 拿 `accessToken`）。
   允许连接的账号**必须就是绑定这台 Host 的那个账号**，控制面会校验绑定归属，
   不是自己的绑定直接返回 `BINDING_FORBIDDEN`。
   这一轮**不做账号之间的共享授权**（没有邀请、成员列表、撤销这些）。
2. 客户端带着 `accessToken` 向控制面请求连接信息，拿到 Host 的 DTLS 指纹、信令地址、ICE 服务器配置和信令凭据
3. 客户端连信令服务器，加入对应 Host 的会话
4. 双方交换 SDP / ICE 候选
5. 建立 DataChannel，**校验对端 DTLS 指纹**
6. 指纹一致后，客户端把业务请求封成二进制消息发出
7. Host 侧解密后转发到本地 `http://127.0.0.1:<host-port>`
8. Host 把响应回传

**这条流程对 H5 同样适用**：H5 不再是「打开链接就能用」，必须先登录。
这是有意的——原来的匿名入口只靠 tunnelDomain 当口令，换成登录后，
凭据绑定到具体账号，泄漏一个链接不再等于把 Host 交出去。

### 6.2.1 明确复用现有 CodingNS Connect，不另起一套（2026-09-16 定）

**注册、登录、设备（绑定）分配、设置页那套「登录账号 → 主机名确认 → 启动」向导，
全部直接复用现有的 CodingNS Connect，本轮不改。**

本轮唯一新增的东西是**传输层**：把承载从「WSS 盲中继 + 自研端到端加密」换成 WebRTC DataChannel。
除此之外的账号、绑定、设备、订阅、控制台这些流程都保持原样。

具体到代码：

- 登录继续用控制站现成的 `POST /api/public/auth/login`
- 账号名下的「设备」就是**已有的绑定列表**，现成接口 `GET /api/v1/hosts`，
  **不新造「设备」这个概念**
- 客户端走「登录 → 拉绑定列表 → 选一台 → 换信令票据 → 建 WebRTC 连接」，
  不让用户手输 tunnelDomain
- Host 侧的登录 / 绑定 / 心跳流程调用方式不变，只是「Host 身份指纹」
  从 x25519 公钥指纹换成 DTLS 证书指纹
- 存量绑定的指纹字段存的是老的 x25519 指纹，Host 升级后会自动重新登记一次
  （见 W4.1），用户不需要重新绑定、不需要换域名、也不会看到新的界面

### 6.3 官方 H5 流程

1. 用户打开可信 H5
2. H5 走和客户端完全相同的流程（同一套 WebRTC 代码）
3. 如果还保留入口域名，入口域名只做跳转，不承载业务页面

### 6.4 用量统计流程

1. P2P 直连的会话，服务端**无法**统计真实流量
2. 客户端按会话上报用量，作为风控参考，不作为计费依据
3. 走 TURN 的会话，TURN 侧可以拿到准确的转发字节数，这部分是真实成本，单独统计
4. 风控规则基于客户端上报 + TURN 实测做交叉校验，异常时告警

### 6.5 启动恢复与自动重连

1. Host 启动时读取实例级配置
2. 若 `enabled=true` 且已绑定，注册后台任务并尝试恢复信令连接
3. 网络抖动时由 `TaskManager` 管理重连节奏
4. 长时间失败写入 `error`

## 7. 与现有业务链路的关系

### 7.1 业务 Host 不改语义

现有 Host 仍提供 `GET/POST /api/...` 和 `WebSocket /ws`。

WebRTC 接入层只负责把这些请求转成「本地转发」，业务语义一行不改。

### 7.2 认证仍由业务 Host 负责

1. 先通过公共隧道到达 Host
2. 再由 Host 执行现有业务登录、Token 校验和 WebSocket 鉴权

- 公共隧道负责「通路」
- CodingNS Host 负责「业务认证」

### 7.3 与局域网直连的关系

`spec001.9.3` 已经做了「局域网候选入口自动直连」。切换到 WebRTC 后：

- 局域网场景下，WebRTC 的 host 候选本身就能直连，不需要再走那套候选入口探测
- 但候选入口机制在「客户端与 Host 在同一内网、但信令服务器在公网」的场景下仍有价值，
  可以先保留，等 WebRTC 稳定后再评估是否简化

## 8. 后台任务与进程模型

### 8.1 为什么必须走 TaskManager

信令连接有这些特点：跨请求长期存在、要自动重连、要去重、要可观测。

规则定死：

- Host 侧信令连接恢复、重连、状态刷新都走 `TaskManager`
- 设置页只读状态和发操作，不直接跑重逻辑

### 8.2 进程隔离是硬要求

**PeerConnection 必须跑在独立进程里。**

实测证据：libdatachannel 在异常状态下会抛未捕获的 C++ 异常，直接终止整个 Node 进程。
werift 是纯 JS 实现，风险比 native 低，但仍然要保持隔离——WebRTC 状态机复杂，
一个 PeerConnection 出问题不应该带走整个 Host。

推荐形态：

- 主进程：配置、状态、与设置页交互
- 接入进程：werift PeerConnection、DataChannel 收发、本地转发
- 两者之间用 IPC 通信，接入进程崩溃时由主进程重启

### 8.3 推荐任务

- `relay_tunnel.signaling_connect`
- `relay_tunnel.signaling_reconnect`
- `relay_tunnel.state_refresh`
- `relay_tunnel.usage_report`
- `webrtc.peer_supervise`（监控接入进程健康，崩了就拉起）

## 9. UI 方案

### 9.1 设置页结构

「远程访问」页继续 provider 化：本地 / 局域网、Tailscale、公共隧道。

公共隧道面板展示：

- 当前状态
- 绑定账号
- Host 指纹（DTLS 指纹）
- **当前链路：直连 / 中继**（这一项是新增的，用户有权知道）
- 订阅状态与下次续费时间
- 用量（标注为「参考用量」）
- 最近错误
- 启用 / 停用
- 绑定 / 解绑
- 打开控制台

### 9.2 用户文案

必须说人话：

- 已绑定，可以直接连接
- 当前正在直连，速度更快
- 当前通过中转连接，速度可能较慢
- 正在建立安全连接
- 安全校验失败，已断开（指纹不一致时）

不要把 `dtls fingerprint mismatch` 这种内部错误直接甩给用户。

## 10. 独立子仓库约束

### 10.1 路径

固定 `apps/codingns-proxy/`：自己的 `.git`，主仓库 `.gitignore` 忽略，主仓库 CI 不扫描。

### 10.2 支付边界

支付只发生在独立子仓库控制面。本仓库只关心：

- 当前订阅是否有效
- 下次续费时间
- 为什么被风控限制

本仓库不关心：订单创建细节、第三方支付 SDK、支付回调签名。

## 11. 计费模型

**这一节是本次方案变更的核心，比技术选型更重要。**

### 11.1 为什么不能按流量计费

P2P 打通后，数据不经过我们的服务器，**网络层拿不到计量数据**。
客户端上报天然不可信，用户少报我们无法发现。

**按流量计费的商业模式和 P2P 直连是互斥的，只能二选一。**

### 11.2 采用固定订阅

- 按固定周期收费，不按流量
- 用户不关心用量，我们也不承诺计量精度
- 计量数据保留，定位是风控和运营参考，不是计费依据

### 11.3 TURN 成本怎么办

P2P 不可能 100% 成功，走 TURN 的用户产生真实带宽成本：

1. 定价时必须把 TURN 成本计入（按最坏情况估算比例）
2. TURN 链路单独限速（比如 2 Mbps），P2P 不限速 —— 天然激励用户留在直连
3. `turnFallbackEnabled` 做成可配置开关，必要时可以关掉某些账号的 TURN
4. TURN 用量单独统计和告警，防止被薅

## 12. 风险与取舍

### 12.1 最大风险

**上行吞吐只有 3–6 MB/s。**

这个数字来自单机 loopback 实测，真实网络下只会更差。它决定了：

- 适合：终端输出、文件树、Git 状态、代码浏览、小文件传输（都是下行为主）
- 可能不适合：大文件上传、大量数据推送

**上生产前必须用真实业务流量验证这一条**，不能只看 loopback 数字。

### 12.2 其它风险

| 风险 | 说明 | 应对 |
| --- | --- | --- |
| NAT 穿透失败率 | 对称 NAT、CGNAT、企业防火墙下打洞会失败 | TURN 兜底 + 定价计入成本 |
| 首次建连变慢 | WebRTC 建连比 WSS 慢，用户能感知 | 设置页给出明确进度提示 |
| TURN 被滥用 | 用户可能故意走 TURN 绕限速 | TURN 单独限速 + 用量告警 |
| 移动端未验证 | iOS / Android WebView 没实测过 | 上生产前必须真机验证 |
| 纯 JS 实现性能 | werift 单核打满，多连接并发时 CPU 是瓶颈 | 压测后再定单机连接数上限 |

### 12.3 第一阶段取舍

先做：

- 官方客户端 + 可信 H5 接入
- P2P 优先、TURN 兜底
- 固定订阅
- 单账号、单 Host 绑定

先不做：

- 团队共享订阅
- 第三方自建中继
- 多入口品牌域名
- 把访问权限分享给第三方（涉及 P2P 暴露 IP 的重新评估）

## 13. 验证策略

### 13.1 本仓库验证

- Host 侧 WebRTC 接入进程的生命周期与重启测试
- DTLS 指纹校验：指纹不匹配必须拒绝，且不能自动降级
- DataChannel 二进制收发与业务转发正确性测试
- 信令连接与自动重连测试
- 未初始化阻断测试
- 本地直连 / Tailscale / 公共隧道并存测试

### 13.2 独立子仓库验证

- 信令服务器：并发、重连、鉴权、凭据过期
- TURN：实际转发与用量统计准确性
- 订阅订单与状态一致性
- 风控：客户端上报与 TURN 实测的交叉校验

### 13.3 联调验证

- 通过客户端访问无公网地址 Host（P2P 路径）
- 强制 `iceTransportPolicy: "relay"` 走 TURN，验证兜底路径
- 抓包确认信令服务器和 TURN 都看不到业务明文
- 真实网络下的吞吐与延迟（不能只测 loopback）
- 移动端真机

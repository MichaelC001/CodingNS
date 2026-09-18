# 需求文档 - spec001.9 公共隧道服务接入与端到端加密远程访问

状态：Draft（2026-09-16 按 WebRTC 承载层改版）

## 简介

当前 `CodingNS` 的远程访问方式有两个明显问题：

1. 很多用户没有公网地址，只能在局域网或自建网络里访问 Host
2. 现有访问链路把「公共中继不可见明文」和「按流量计费」绑在了一起，而这两件事本身是矛盾的

这次要解决的事：

1. 提供一个 CodingNS 自己托管的公共隧道服务，让没有公网地址的 Host 也能被访问
2. 承载层改用 **WebRTC DataChannel**：能 P2P 直连就直连，连不上才走 TURN 中转
3. 端到端加密由 **DTLS 原生提供**，不再自研加密协议
4. 计费改成**固定订阅**，不再按流量收费（P2P 打通后网络层无法计量）
5. 在本仓库实现 Host 侧接入层和客户端 / H5 接入层，不实现公共云站点代码
6. 保持现有业务登录、Token、权限和本地直连流程不被破坏

**这一版和上一版的关键差别**：

| 维度 | 上一版 | 这一版 |
| --- | --- | --- |
| 承载 | WSS 盲中继 | WebRTC DataChannel，P2P 优先 |
| 加密 | 自研 x25519 + HKDF + AES-GCM | DTLS（WebRTC 原生） |
| 身份校验 | 公钥注册 + 握手 proof | SDP 里的 DTLS 指纹比对 |
| 计费 | 按流量 | 固定订阅 |
| 计量定位 | 计费依据 | 风控参考 |

## 术语表

- **公共隧道服务**：CodingNS 官方托管的公网接入服务，负责账号、订阅、信令和兜底中继
- **控制面**：负责账号、Host 绑定、订阅、订单和用量统计的服务
- **信令服务器**：只转发 SDP 和 ICE 候选，不接触业务数据
- **TURN**：NAT 打洞失败时的兜底中继，只转发 DTLS 密文
- **P2P 直连**：客户端和 Host 直接建立连接，数据不经过我们的服务器
- **DTLS 指纹**：WebRTC 用来自证身份的证书指纹，客户端靠它确认对端是不是真正的 Host
- **可信接入端**：官方桌面端、移动端，或从固定可信域名加载的官方 H5
- **独立子仓库**：放公共隧道云端代码的单独 Git 仓库，不由本仓库跟踪

## 范围说明

### In Scope

- 定义实例级公共隧道配置、绑定状态和 DTLS 指纹模型
- 定义 Host 侧 WebRTC 接入层、信令交互、自动重连和错误状态
- 定义客户端 / H5 侧 DataChannel 建立、指纹校验和业务转发
- 定义设置页里的公共隧道入口、绑定、启停和状态展示（含当前链路类型）
- 定义公共隧道控制面、信令服务和 TURN 的仓库边界
- 定义订阅购买、用量统计和 TURN 兜底限速边界
- 定义本地直连、局域网直连、Tailscale 与公共隧道并存规则

### Out of Scope

- 在本仓库里实现公共隧道站点代码
- 在本仓库里实现支付后台代码
- 用公共隧道账号替代 CodingNS 业务登录
- 让用户自有域名直接托管完整 H5 业务页面并仍宣称中继不可见明文
- 第一阶段就做企业组织、共享订阅、经销商和复杂结算
- 把访问权限分享给第三方（涉及 P2P 暴露 IP，需单独评估）

## 需求

### 需求 1：本仓库与公共隧道站点必须强制分仓

**用户故事：** 作为项目维护者，我希望本仓库只承担客户端和协议接入，不跟踪公共云站点代码。

#### 验收标准

1. WHEN 启动 `spec001.9` THEN System SHALL 明确规定本仓库只实现 Spec、Host 侧接入层、客户端 / H5 接入层和信令交互
2. WHEN 后续开始实现公共隧道站点 THEN System SHALL 要求其放入当前仓库下的独立子仓库
3. WHEN 主仓库检查版本控制边界 THEN System SHALL 不跟踪公共隧道站点代码

### 需求 2：系统必须有正式的实例级公共隧道配置模型

**用户故事：** 作为服务管理员，我希望公共隧道配置属于当前 Host 实例，而不是某个登录用户的私人偏好。

#### 验收标准

1. WHEN 系统保存公共隧道配置 THEN System SHALL 将其保存为实例级配置，而不是账户偏好
2. WHEN 不同业务用户登录同一台 Host THEN System SHALL 看到同一份公共隧道当前状态
3. WHEN 服务重启 THEN System SHALL 恢复上次保存的公共隧道配置和绑定状态

### 需求 3：Host 必须支持绑定公共隧道账号

**用户故事：** 作为服务管理员，我希望在设置页里把当前 Host 绑定到我的公共隧道账号。

#### 验收标准

1. WHEN 管理员在设置页启用公共隧道 THEN System SHALL 支持登录公共隧道账号并绑定当前 Host
2. WHEN 绑定成功 THEN System SHALL 返回当前 Host 的绑定标识、DTLS 指纹和订阅状态
3. WHEN 管理员解绑当前 Host THEN System SHALL 释放本地绑定状态，并停止继续使用旧绑定

### 需求 4：客户端与 Host 之间必须建立端到端加密信道

**用户故事：** 作为使用公共隧道访问 Host 的用户，我希望信令服务器和 TURN 都只能看到密文，不能查看或篡改业务内容。

#### 验收标准

1. WHEN 客户端或 H5 通过公共隧道访问 Host THEN System SHALL 使用 WebRTC 的 DTLS 建立端到端加密信道
2. WHEN 信令服务器或 TURN 转发数据 THEN System SHALL 保证它们拿不到 DTLS 密钥，只能看到连接元数据和密文字节
3. WHEN 对端 DTLS 指纹与控制面登记的不一致 THEN System SHALL 拒绝建立业务连接，且不得自动降级或忽略
4. WHEN 只测试「能连通」而不校验指纹 THEN System SHALL 视为未满足本需求

### 需求 5：系统必须把「可信接入端」边界写死

**用户故事：** 作为架构维护者，我希望系统不要一边说中继不可见内容，一边又让不可信来源托管业务 H5 页面。

#### 验收标准

1. WHEN 官方 H5 需要访问 Host THEN System SHALL 从固定可信域名加载 H5 代码
2. WHEN H5 代码由第三方平台托管 THEN System SHALL 在文档中明确该平台属于可信方，不得宣称其不可见内容
3. WHEN 用户访问入口域名 THEN System SHALL 只把它当成跳转入口或连接标识，不承载业务页面

### 需求 6：公共隧道启用后必须保持现有业务认证体系不变

**用户故事：** 作为现有用户，我希望只是网络接入方式变了，不是整个登录体系被推翻。

#### 验收标准

1. WHEN 外部用户通过公共隧道访问 Host THEN System SHALL 继续使用现有 CodingNS 登录流程
2. WHEN 公共隧道启用或停用 THEN System SHALL 不重写现有用户名密码、Access Token、Refresh Token 和 WebSocket 鉴权语义
3. WHEN 未启用公共隧道 THEN System SHALL 保持当前本地 / 局域网 / Tailscale 访问方式不变

### 需求 7：系统必须支持用量统计（风控口径）

**用户故事：** 作为公共隧道运营者，我希望能看到用量异常，防止被滥用，但我不再把它当作计费依据。

#### 验收标准

1. WHEN 会话产生数据 THEN System SHALL 记录用量，但明确标注其来源是客户端上报，不具备计费精度
2. WHEN 会话走 TURN THEN System SHALL 以 TURN 侧实测字节数为准，这部分是可核实的真实成本
3. WHEN 客户端上报与 TURN 实测出现显著背离 THEN System SHALL 触发风控告警
4. WHEN 用户查看状态 THEN System SHALL 展示订阅状态和参考用量，不得展示「剩余流量将耗尽后断流」这类硬限额语义

### 需求 8：系统必须支持固定订阅购买

**用户故事：** 作为公共隧道用户，我希望按周期订阅，而不是按流量购买和担心超额。

#### 验收标准

1. WHEN 用户进入公共隧道站点 THEN System SHALL 支持通过成熟支付方式购买固定周期订阅
2. WHEN 支付成功 THEN System SHALL 激活或续期订阅，并更新状态
3. WHEN 订阅到期 THEN System SHALL 停止提供公共隧道服务，但不得影响用户通过其他方式访问自己的 Host
4. WHEN 支付失败、取消或回调异常 THEN System SHALL 保持订单和订阅状态一致

### 需求 9：Host 侧接入层必须支持自动重连和启动恢复

**用户故事：** 作为服务管理员，我希望 Host 重启后能恢复服务，网络抖动后能自动重连。

#### 验收标准

1. WHEN Host 已启用公共隧道且服务重启 THEN System SHALL 尝试恢复信令连接和绑定状态
2. WHEN 信令连接断开或网络抖动 THEN System SHALL 自动重连，并在设置页展示当前阶段
3. WHEN 持续重连失败 THEN System SHALL 明确显示失败原因，而不是静默离线
4. WHEN WebRTC 接入进程崩溃 THEN System SHALL 由主进程自动拉起，且不影响 Host 其他功能

### 需求 10：未初始化实例必须避免通过公共隧道直接暴露初始化入口

**用户故事：** 作为服务管理员，我不希望一台还没初始化的 Host 一启用公共隧道就把首个管理员入口暴露到公网。

#### 验收标准

1. WHEN 当前实例尚未完成 bootstrap THEN System SHALL 阻止正式启用公共隧道对外暴露
2. WHEN 管理员尝试在未初始化状态启用公共隧道 THEN System SHALL 明确提示必须先完成初始化
3. WHEN 实例完成初始化后再次启用公共隧道 THEN System SHALL 正常继续绑定和连通流程

### 需求 11：用户必须能知道当前走的是直连还是中继

**用户故事：** 作为用户，我希望能看出当前连接是直连还是走中转，因为两者速度差别很大。

#### 验收标准

1. WHEN 连接建立成功 THEN System SHALL 识别当前链路类型（P2P 直连或 TURN 中继）
2. WHEN 在设置页或连接状态处展示 THEN System SHALL 用普通用户能懂的话说明当前链路
3. WHEN 链路在中继和直连之间切换 THEN System SHALL 更新展示，不需要用户重新连接

### 需求 12：TURN 兜底必须可控

**用户故事：** 作为运营者，我需要控制 TURN 成本，不能让它变成无限量免费带宽。

#### 验收标准

1. WHEN 用户走 TURN 中继 THEN System SHALL 对其实施单独限速
2. WHEN 用户走 P2P 直连 THEN System SHALL 不额外限速
3. WHEN 需要关闭某个账号或某类场景的 TURN 时 THEN System SHALL 支持通过配置开关控制
4. WHEN TURN 用量异常增长 THEN System SHALL 触发告警

### 需求 13：远程入口必须区分 Connect 认证和 Host 认证

**用户故事：** 作为远程访问用户，我希望先证明自己拥有这台设备的 CodingNS Connect 绑定，再用这台 Host 上的本地账号登录业务，避免把两种账号混在一起。

#### 验收标准

1. WHEN 用户打开四级域名入口且没有有效 Connect 会话 THEN System SHALL 先显示 CodingNS Connect 邮箱和密码表单，不得直接调用 Host 登录接口
2. WHEN Connect 认证成功并且 WebRTC 隧道建立 THEN System SHALL 通过隧道读取当前 Host 的活动账号列表
3. WHEN Host 返回账号列表 THEN System SHALL 只返回 `userId`、`username`、`role`，不得返回密码、密码哈希、Token、设备或会话信息
4. WHEN 用户选择 Host 账号并提交密码 THEN System SHALL 继续调用原有 Host `/api/auth/login`，由 Host 本地权限决定是否登录成功
5. WHEN 请求账号列表没有 relay session THEN System SHALL 返回 403，不能因为知道四级域名就读取本地账号

## 非功能需求

### 非功能需求 1：安全性

1. WHEN 客户端和 Host 建立连接 THEN System SHALL 使用 DTLS 提供的端到端加密，不得自研加密协议
2. WHEN 校验对端身份 THEN System SHALL 比对 DTLS 指纹，指纹不符必须拒绝
3. WHEN 端到端加密未建立成功 THEN System SHALL 不得回退到明文业务传输
4. WHEN WebRTC 进程出现异常 THEN System SHALL 保证不影响 Host 主进程与其他功能

### 非功能需求 2：可观测性

1. WHEN 隧道在线状态变化 THEN System SHALL 记录可观测事件和最近错误
2. WHEN 链路类型变化 THEN System SHALL 记录发生了直连/中继切换
3. WHEN 订阅失效或风控触发 THEN System SHALL 给出可追踪的状态和错误码

### 非功能需求 3：兼容性

1. WHEN 客户端不启用公共隧道 THEN System SHALL 保持当前本地地址、局域网地址、Tailscale 地址的连接方式不变
2. WHEN 公共隧道不可用 THEN System SHALL 允许用户继续使用本地直连或其他已有远程访问方式
3. WHEN 客户端运行在系统 WebView 中 THEN System SHALL 使用原生 WebRTC，不引入额外 WebRTC SDK

### 非功能需求 4：性能

1. WHEN 传输业务数据 THEN System SHALL 以实测数据为验收依据，不得使用客户端本地的发送侧统计
2. WHEN 评估方案可行性 THEN System SHALL 以真实网络实测为准，不得只凭单机 loopback 数据下结论

## 成功定义

- 本仓库只承担客户端和接入层，公共云站点代码明确分仓
- 管理员可以在设置页启用、绑定、停用和查看公共隧道状态
- 客户端 / H5 与 Host 之间端到端加密，信令服务器和 TURN 看不到业务明文
- 对端身份通过 DTLS 指纹校验，指纹不符时拒绝连接
- P2P 直连能覆盖多数场景，TURN 兜底可用且成本可控
- 用户可以按固定周期订阅
- 现有业务认证、本地直连和 Tailscale 访问方式保持可用

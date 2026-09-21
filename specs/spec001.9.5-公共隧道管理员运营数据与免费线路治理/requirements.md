# 需求文档 - spec001.9.5 公共隧道管理员运营数据与免费线路治理

状态：DONE

## 简介

公共隧道的 WebRTC 连接链路已经具备，但管理员后台仍然只能看到账号和绑定的静态列表，不能可靠回答“谁在线、谁正在访问、流量是多少、当前走直连还是中继、能不能立即停用”。

本 Spec 先把免费线路和运营状态定清楚，再补齐控制面、信令服务和控制台页面。它不提前设计付费会员。

## 术语表

- **账号状态**：`pending_verification`、`active`、`disabled` 三种状态。
- **设备**：一条 Host 绑定记录，拥有稳定的设备 ID、域名和历史流量。
- **Host 在线**：最近一次 Host 心跳在 30 秒有效窗口内。
- **正在访问**：WebRTC DataChannel 已建立成功的客户端会话。
- **访问模式**：根据实际选中的 ICE candidate pair 判定的 `direct`、`relay` 或 `unknown`。
- **免费线路**：验证账号默认获得的长期基础线路，不限总流量，页面显示 `500 KB/s`，内部按上下行合计 `512000 bytes/s` 限速。

## 范围说明

### In Scope

- 管理员运营总览、账号和设备详情
- 账号和设备启用、禁用、设备凭据重置、密码重置邮件
- Host 在线、DataChannel 会话和直连/中继状态采集
- 实时速率、账号/设备累计用量和每日汇总
- 免费线路准入、限速、设备数和会话数
- 状态变更审计日志

### Out of Scope

- 付费会员、月度订阅、自动续费和付费权益
- 多级管理员和复杂 RBAC
- 永久撤销设备状态；设备只保留 `active / disabled`
- 通过 `iceTransportPolicy` 推断真实访问模式

## 需求

### 需求 1：免费线路准入

**用户故事：** 作为普通用户，我希望验证邮箱后能立即使用基础线路，作为平台方，我希望未验证账号不能消耗线路资源。

#### 验收标准

1. WHEN 账号未完成邮箱验证 THEN System SHALL 允许有限控制台访问，但拒绝绑定设备、申请连接票据和建立免费线路会话。
2. WHEN 账号完成邮箱验证 THEN System SHALL 将账号置为 `active`，并允许使用免费线路。
3. WHEN 免费线路建立会话 THEN System SHALL 不设置总流量上限，但 SHALL 对上下行合计速率限制为 `512000 bytes/s`。
4. WHEN 免费线路选择 ICE 路径 THEN System SHALL 先允许 P2P 直连，直连失败后允许 TURN 中继。
5. WHEN 一个账号已经有设备或访问会话 THEN System SHALL 拒绝额外设备和额外并发会话。

### 需求 2：账号状态控制

**用户故事：** 作为管理员，我希望冻结账号时立即阻断所有入口，并在恢复时保留用户原有设备状态。

#### 验收标准

1. WHEN 管理员禁用账号 THEN System SHALL 立即使该账号全部登录令牌失效。
2. WHEN 账号处于 `disabled` THEN System SHALL 拒绝登录、密码重置邮件、连接票据和所有新会话。
3. WHEN 管理员禁用账号 THEN System SHALL 断开该账号下所有 Host 和 DataChannel 会话。
4. WHEN 管理员重新启用账号 THEN System SHALL 恢复账号能力，但 SHALL 保留每台设备原来的 `active / disabled` 状态。

### 需求 3：设备状态和凭据重置

**用户故事：** 作为管理员，我希望单独冻结一台设备或更换它的凭据，而不影响同一账号的其他设备。

#### 验收标准

1. WHEN 管理员禁用设备 THEN System SHALL 立即断开该设备全部连接，并拒绝后续连接票据。
2. WHEN 管理员启用设备 THEN System SHALL 在账号也为 `active` 且邮箱已验证时恢复连接能力。
3. WHEN 管理员重置设备凭据 THEN System SHALL 立即断开设备连接，使旧 Host 凭据或 DTLS 指纹失效。
4. WHEN 设备凭据被重置 THEN System SHALL 保留设备 ID、域名、绑定关系和历史流量，Host 必须重新认证或登记新凭据。
5. WHEN 设备被淘汰 THEN System SHALL 通过长期保持 `disabled` 表示，不删除绑定记录。

### 需求 4：在线状态和访问会话

**用户故事：** 作为管理员，我希望区分“Host 在线但没人访问”和“当前正在访问”。

#### 验收标准

1. WHEN 最近一次 Host 心跳距离当前不超过 30 秒 THEN System SHALL 将设备标记为 Host 在线。
2. WHEN WebRTC DataChannel 建立成功 THEN System SHALL 创建正在访问的会话记录。
3. WHEN 只有信令连接、SDP 协商或 ICE 等待状态 THEN System SHALL 不计入正在访问。
4. WHEN DataChannel 断开 THEN System SHALL 结束会话并从实时访问列表移除。
5. WHEN 管理员读取总览 THEN System SHALL 同时返回 Host 在线设备数、离线设备数、正在访问设备数和访问会话数。

### 需求 5：真实访问模式

**用户故事：** 作为管理员，我希望看到真实的直连/中继结果，而不是看到连接策略的猜测。

#### 验收标准

1. WHEN 会话建立后客户端或 Host 上报实际选中的 ICE candidate pair THEN System SHALL 保存访问模式。
2. WHEN 选中的 pair 不包含 `relay` THEN System SHALL 记录 `direct`。
3. WHEN 任一端选中的 candidate type 为 `relay` THEN System SHALL 记录 `relay`。
4. WHEN 没有成功上报 pair THEN System SHALL 记录 `unknown`，不能根据 `iceTransportPolicy` 推断。

### 需求 6：实时速率和历史用量

**用户故事：** 作为管理员，我希望看到当前网络负载和按账号、设备归属的历史用量。

#### 验收标准

1. WHEN 管理员查看实时速率 THEN System SHALL 按最近 60 秒滑动窗口返回上行、下行和总 `bytes/s`。
2. WHEN 管理员查看历史用量 THEN System SHALL 返回上行 + 下行的累计字节数。
3. WHEN 管理员查询历史用量 THEN System SHALL 支持账号、设备、今日、本月和自定义日期范围。
4. WHEN 原始流量事件超过 30 天 THEN System SHALL 删除原始事件，但 SHALL 永久保留按天账号和设备汇总。
5. WHEN 管理员查看中继用量 THEN System SHALL 单独返回中继会话数和中继流量总量。

### 需求 7：管理员运营总览和刷新

**用户故事：** 作为管理员，我希望打开后台就能看到完整运营情况，并在状态变化后马上看到结果。

#### 验收标准

1. WHEN 管理员打开总览 THEN System SHALL 展示在线状态、实时流量、直连/中继数量、今日流量、本月流量、账号排行、设备排行和中继流量。
2. WHEN 页面处于打开状态 THEN System SHALL 每 15 秒轮询一次在线状态和实时速率。
3. WHEN 管理员完成账号或设备状态变更 THEN System SHALL 主动刷新相关列表和总览数据。
4. WHEN 实时数据来源不可用 THEN System SHALL 明确返回不可用状态，不得用伪造的在线会话或 0 字节冒充实时数据。

### 需求 8：管理员密码操作

**用户故事：** 作为管理员，我希望帮助用户重置密码，但不接触用户的新密码。

#### 验收标准

1. WHEN 管理员触发密码重置 THEN System SHALL 发送密码重置邮件，不返回临时密码。
2. WHEN 账号处于 `disabled` THEN System SHALL 不发送密码重置邮件，必须先启用账号。
3. WHEN 密码重置成功 THEN System SHALL 使旧登录令牌失效。

### 需求 9：状态变更审计

**用户故事：** 作为平台维护者，我希望知道是谁在什么时候冻结、恢复或重置了哪个对象。

#### 验收标准

1. WHEN 管理员执行账号或设备状态变更、设备凭据重置、密码重置邮件或限速修改 THEN System SHALL 写入审计日志。
2. WHEN 写入审计日志 THEN System SHALL 保存操作者、动作、目标、原因、前后状态、时间和请求 IP。
3. WHEN 管理员只是查询列表或报表 THEN System SHALL 不写入第一版审计日志。
4. WHEN 状态变更缺少原因 THEN System SHALL 拒绝提交。

## 非功能需求

### 非功能需求 1：一致性和安全

1. 账号禁用、令牌失效、连接断开和审计记录 SHALL 在一个可追踪的操作流程中完成。
2. 所有连接票据签发 SHALL 同时检查账号状态、邮箱验证状态和设备状态。
3. 设备凭据重置 SHALL 不能删除历史流量和审计记录。

### 非功能需求 2：性能

1. 管理员总览快照在正常数据库负载下 SHALL 在 1 秒内返回。
2. 15 秒轮询不能创建重复的长连接或后台私有定时器。
3. 实时速率计算 SHALL 使用已有流量事件和明确窗口，不扫描无限期原始数据。

### 非功能需求 3：可维护性

1. 账号状态、设备状态和会话状态 SHALL 使用共享契约中的明确枚举。
2. 访问模式 SHALL 使用真实遥测字段，不复用连接策略字段。
3. 后续增加会员权益时 SHALL 能在免费线路之上增加独立权益层，不修改账号和设备状态机。

## 成功定义

- 管理员能看到全部约定的在线、实时、历史和访问模式指标。
- 禁用账号或设备后，旧令牌和旧连接不能继续使用。
- 设备凭据重置不删除设备和历史数据。
- 免费线路规则能被 API、客户端、Host 和后台统一解释。
- 原始流量事件保留 30 天，日汇总永久可查。
- 所有状态变更都有审计记录，查询不产生审计噪音。

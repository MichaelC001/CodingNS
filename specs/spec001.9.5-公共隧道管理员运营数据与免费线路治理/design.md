# 设计文档 - spec001.9.5 公共隧道管理员运营数据与免费线路治理

状态：DONE

## 1. 概述

### 1.1 目标

- 用真实运行态数据补齐管理员总览、账号列表和设备列表。
- 把账号、设备、会话和凭据重置拆成清晰的状态模型。
- 用一个可配置的免费线路策略承载试运行规则，不提前引入会员系统。
- 让控制面、信令服务、Host 和控制台对在线状态和访问模式使用同一口径。

### 1.2 覆盖需求

- `requirements.md` 需求 1～9

### 1.3 技术约束

- 后端：`apps/codingns-proxy/apps/control-api`、`apps/codingns-proxy/apps/relay-signaling`
- 前端：`apps/codingns-proxy/apps/console-web`
- 共享契约：`apps/codingns-proxy/packages/shared-contracts`
- 数据库：现有 PostgreSQL 迁移体系；本地兼容现有文件状态实现
- 认证：现有 Bearer session + admin role
- 连接层：WebRTC DataChannel、信令服务和 TURN
- 不启动第二套后台任务体系；15 秒刷新由前端轮询完成

## 2. 架构

### 2.1 系统结构

```text
Host / 客户端
  -> WebRTC DataChannel 建连与状态上报
  -> relay-signaling 保存连接快照
  -> control-api 读取快照并写入会话、流量和审计数据
  -> console-web 每 15 秒读取管理员运营快照
```

控制面负责权威判断：账号状态、设备状态、票据签发、免费线路策略和历史汇总。信令服务只负责真实连接成员和会话状态，不负责猜测流量或访问模式。

### 2.2 模块职责

| 模块 | 职责 | 输入 | 输出 |
| --- | --- | --- | --- |
| `account-store` | 账号状态、邮箱验证、令牌失效 | 管理员动作、认证请求 | 账号状态和版本 |
| `binding-store` | 设备状态、凭据版本、域名和绑定记录 | Host 绑定、启用/禁用、重置 | 设备快照 |
| `relay-signaling` | 真实 Host / DataChannel 成员快照 | WebSocket、WebRTC 状态上报 | 在线会话快照 |
| `runtime-session-store` | 会话生命周期、访问模式、实时活动 | DataChannel 事件、流量事件 | 活跃会话 |
| `traffic-usage-store` | 原始流量事件和每日汇总 | 上下行字节、会话结束 | 账号/设备用量 |
| `admin-audit-store` | 状态变更审计 | 管理员操作 | 审计记录 |
| `console-web` | 管理员总览、列表和操作 | 管理员 API | 页面快照和操作反馈 |

### 2.3 关键流程

#### 2.3.1 连接票据校验

1. 客户端请求连接票据。
2. 控制面检查邮箱验证、账号 `active`、设备 `active` 和免费线路会话/设备上限。
3. 控制面生成短期票据，并带上 `free` 策略和 `512000 bytes/s` 总限速。
4. WebRTC DataChannel 建立后，客户端或 Host 上报连接成功和实际 candidate pair。
5. 控制面创建会话记录并开始收集流量事件。

#### 2.3.2 禁用账号

1. 管理员提交原因。
2. 控制面在事务中更新账号状态并使 session 版本失效。
3. 控制面通知信令服务断开该账号的 Host 和客户端连接。
4. 控制面写入审计日志。
5. 控制台刷新总览和账号/设备列表。

#### 2.3.3 重置设备凭据

1. 管理员提交设备 ID 和原因。
2. 控制面递增凭据版本或生成新的 DTLS 指纹登记版本。
3. 旧票据和旧 Host 身份立即失效，当前会话断开。
4. 设备绑定、域名和历史流量保持不变。
5. 控制面写入审计日志并刷新设备列表。

## 3. 组件和接口

### 3.1 核心组件

- `FreeRoutePolicy`：集中保存验证账号、免费限速、设备数和会话数规则。
- `RuntimeSessionStore`：保存 DataChannel 成功建立后的会话，不接受仅信令连接作为访问会话。
- `RuntimeTelemetryCollector`：接收实际 ICE pair、活动时间和字节增量。
- `AdminOverviewService`：聚合在线、实时速率、历史用量和访问模式。
- `AdminAuditStore`：记录所有状态变更和管理员操作。

### 3.2 数据结构

#### 3.2.1 账号状态

| 字段 | 类型 | 必填 | 说明 | 约束 |
| --- | --- | --- | --- | --- |
| `status` | enum | 是 | `pending_verification / active / disabled` | 禁用账号不能登录和换票 |
| `email_verified` | boolean | 是 | 邮箱验证状态 | 未验证不能使用线路 |
| `session_version` | integer | 是 | 令牌失效版本 | 禁用、密码重置时递增 |
| `role` | enum | 是 | `user / admin` | 第一版只有 admin 全权限 |

#### 3.2.2 设备状态

| 字段 | 类型 | 必填 | 说明 | 约束 |
| --- | --- | --- | --- | --- |
| `status` | enum | 是 | `active / disabled` | 与账号状态独立保存 |
| `credential_version` | integer | 是 | Host 凭据版本 | 重置时递增 |
| `credential_reset_at` | timestamp | 否 | 最近一次重置时间 | 用于排障和审计 |
| `created_at` | timestamp | 是 | 设备创建时间 | 永久保留 |

#### 3.2.3 运行会话

| 字段 | 类型 | 必填 | 说明 | 约束 |
| --- | --- | --- | --- | --- |
| `session_id` | string | 是 | 稳定会话 ID | 不能使用绑定+序号伪造 |
| `account_id` | string | 是 | 所属账号 | 必须来自真实票据 |
| `binding_id` | string | 是 | 所属设备 | 必须属于账号 |
| `status` | enum | 是 | `active / closed` | DataChannel 建立后才 active |
| `transport_mode` | enum | 是 | `direct / relay / unknown` | 来自实际 candidate pair |
| `connected_at` | timestamp | 是 | DataChannel 建立时间 | 真实事件时间 |
| `last_activity_at` | timestamp | 是 | 最近业务活动时间 | 用于实时窗口 |
| `upstream_bytes` | bigint | 是 | 累计上行字节 | 非负 |
| `downstream_bytes` | bigint | 是 | 累计下行字节 | 非负 |

#### 3.2.4 审计记录

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `audit_id` | string | 是 | 审计 ID |
| `operator_account_id` | string | 是 | 操作管理员 |
| `action` | string | 是 | 启用、禁用、重置等 |
| `target_type` | string | 是 | `account / binding / session` |
| `target_id` | string | 是 | 目标 ID |
| `reason` | string | 是 | 操作原因 |
| `before_state` | jsonb | 是 | 操作前状态 |
| `after_state` | jsonb | 是 | 操作后状态 |
| `created_at` | timestamp | 是 | 操作时间 |
| `request_ip` | string | 否 | 请求来源 |

### 3.3 接口契约

#### 3.3.1 管理员总览

- 类型：HTTP GET
- 路径或标识：`/api/admin/overview`
- 输入：管理员 Bearer token、可选日期范围
- 输出：在线设备、活跃会话、实时上下行速率、直连/中继/未知数量、今日/本月/自定义用量、排行和中继总量
- 校验：必须是 `admin`；日期必须为合法 ISO 日期
- 错误：`401`、`403`、`INVALID_INPUT`、`RUNTIME_DATA_UNAVAILABLE`

#### 3.3.2 管理员账号操作

- `POST /api/admin/accounts/:accountId/enable`
- `POST /api/admin/accounts/:accountId/disable`
- `POST /api/admin/accounts/:accountId/password-reset`
- 输入：管理员 token、必填 `reason`
- 输出：更新后的账号状态和审计 ID
- 约束：禁用自己、重复状态变更和禁用最后一个管理员需要明确拒绝策略并写测试

#### 3.3.3 管理员设备操作

- `POST /api/admin/bindings/:bindingId/enable`
- `POST /api/admin/bindings/:bindingId/disable`
- `POST /api/admin/bindings/:bindingId/reset-credentials`
- 输入：管理员 token、必填 `reason`
- 输出：更新后的设备状态、凭据版本和审计 ID
- 约束：不删除绑定、不释放域名、不删除历史流量

#### 3.3.4 运行态上报

- 类型：内部 HTTP 或受信事件
- 路径或标识：`/api/internal/runtime/sessions`、`/api/internal/runtime/telemetry`
- 输入：真实 `sessionId`、`accountId`、`bindingId`、DataChannel 状态、candidate pair、字节增量和时间戳
- 输出：幂等接收结果
- 校验：内部 API key、字段归属、时间窗口、非负字节数、重复事件 ID
- 错误：`RUNTIME_AUTH_INVALID`、`SESSION_NOT_FOUND`、`TELEMETRY_INVALID`

## 4. 数据与状态模型

### 4.1 数据关系

```text
accounts 1 --- N tunnel_bindings
accounts 1 --- N runtime_sessions
tunnel_bindings 1 --- N runtime_sessions
runtime_sessions 1 --- N relay_usage_events
accounts / tunnel_bindings 1 --- N daily_usage_summaries
管理员操作 1 --- 1 admin_audit_logs
```

账号和设备状态独立保存，实际是否允许连接由以下条件共同决定：

```text
email_verified
&& account.status === active
&& binding.status === active
&& 免费线路设备/会话上限未超出
```

### 4.2 状态流转

| 对象 | 状态 | 进入条件 | 退出条件 |
| --- | --- | --- | --- |
| 账号 | `pending_verification` | 注册完成但邮箱未验证 | 邮箱验证成功 |
| 账号 | `active` | 邮箱验证成功或管理员启用 | 管理员禁用 |
| 账号 | `disabled` | 管理员禁用 | 管理员启用 |
| 设备 | `active` | 绑定完成或管理员启用 | 管理员禁用 |
| 设备 | `disabled` | 管理员禁用 | 管理员启用 |
| 会话 | `active` | DataChannel 建立成功 | 断开、账号禁用或设备禁用 |
| 会话 | `closed` | 会话结束 | 不再恢复，重新建新会话 |

设备凭据重置不改变设备状态，只递增 `credential_version` 并结束当前会话。

## 5. 错误处理

### 5.1 错误类型

- `ACCOUNT_EMAIL_NOT_VERIFIED`：账号未完成邮箱验证。
- `ACCOUNT_DISABLED`：账号已被管理员禁用。
- `BINDING_DISABLED`：设备已被管理员禁用。
- `DEVICE_LIMIT_REACHED`：账号已达到 1 台设备上限。
- `SESSION_LIMIT_REACHED`：设备已有访问会话。
- `RUNTIME_DATA_UNAVAILABLE`：实时来源不可用，不能伪造快照。
- `AUDIT_REASON_REQUIRED`：状态变更缺少原因。
- `CREDENTIAL_VERSION_INVALID`：旧设备凭据已失效。

### 5.2 处理策略

1. 输入验证错误直接返回 400，不写状态和审计。
2. 状态冲突返回明确业务错误，不覆盖已有状态。
3. 信令服务不可用时，管理员页面显示实时数据不可用；历史汇总仍可读。
4. 重复遥测事件使用事件 ID 幂等处理。
5. 账号或设备禁用失败时不能只写审计，必须保证状态、连接断开和审计结果可追踪。

## 6. 正确性属性

### 6.1 账号禁用阻断所有入口

*对于任何* `account.status = disabled` 的账号，系统都应该拒绝登录、密码重置邮件、连接票据和新会话，并结束已有会话。

验证需求：需求 2、需求 8。

### 6.2 账号和设备状态独立恢复

*对于任何* 账号禁用前的设备状态集合，账号重新启用后，设备状态集合必须保持不变。

验证需求：需求 2、需求 3。

### 6.3 访问模式不可由策略字段替代

*对于任何* 会话，后台的 `transport_mode` 必须来自实际 candidate pair 上报；没有上报时只能是 `unknown`。

验证需求：需求 5。

### 6.4 历史数据不可因状态操作丢失

*对于任何* 设备禁用或凭据重置操作，设备 ID、域名、日汇总和审计记录必须继续可查。

验证需求：需求 3、需求 6、需求 9。

## 7. 测试策略

### 7.1 单元测试

- 账号、设备和会话状态转移。
- 免费线路限速和 1 设备/1 会话上限。
- candidate pair 到 `direct / relay / unknown` 的转换。
- 60 秒速率窗口和上下行合计计算。
- 审计原因必填和幂等遥测事件。

### 7.2 集成测试

- 账号禁用后登录、换票和已有连接全部失效。
- 设备禁用只影响目标设备。
- 设备凭据重置保留域名和历史数据。
- 信令服务返回真实会话后，管理员总览能正确聚合。
- 原始事件 30 天清理后日汇总仍可查询。

### 7.3 前端测试

- 管理员总览指标、15 秒刷新和变更后主动刷新。
- 账号/设备操作原因填写、确认和错误反馈。
- `direct / relay / unknown` 状态展示。
- 实时数据不可用时不显示伪造 0 值为正常在线数据。

### 7.4 验证映射

| 需求 | 设计章节 | 验证方式 |
| --- | --- | --- |
| 需求 1 | §3.2、§4.2 | 免费线路和票据接口测试 |
| 需求 2、3 | §2.3、§3.3、§4.2 | 状态机和 API 集成测试 |
| 需求 4、5 | §3.2.3、§3.3.4 | WebRTC / 信令运行态测试 |
| 需求 6、7 | §3.1、§3.3.1 | 聚合接口和前端刷新测试 |
| 需求 8、9 | §3.3.2、§3.3.3、§3.2.4 | 邮件和审计测试 |

## 8. 风险与待确认项

### 8.1 风险

- 免费线路不限流量且允许 TURN，必须依赖管理员禁用和中继用量报表处理滥用。
- 信令服务当前只提供绑定级在线快照，不能继续生成伪造 session；必须补真实 DataChannel 会话上报。
- 多实例部署时，账号禁用通知必须能到达承载该连接的信令实例。
- 512000 bytes/s 是上下行总和，限速执行点必须统一在客户端/Host，不允许后台展示和实际执行不一致。

### 8.2 待确认项

- 多实例信令服务的账号断连广播方式。
- Host 侧和客户端侧谁作为访问模式上报的权威来源；第一版允许任一侧上报，但需要去重。
- 本地文件状态实现是否继续支持新状态字段，还是只保留迁移兼容读取。

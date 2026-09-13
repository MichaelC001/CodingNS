# 任务清单 - spec002.1.2 会话索引与显式扫描

状态：Draft

## 阶段 1：收紧后端入口

- [ ] 1.1 创建会话成功后单条写入 SQLite
  - 状态：TODO
  - 主要改哪里：`apps/host/src/modules/sessions/session-history-service.ts`、会话索引/绑定仓储
  - 怎么验证：创建接口测试确认只新增一条索引且不调用 discovery

- [ ] 1.2 普通会话列表完全改为索引读取
  - 状态：TODO
  - 主要改哪里：`apps/host/src/modules/sessions/session-controller.ts`、`session-history-service.ts`
  - 怎么验证：列表接口测试确认 provider discovery 调用次数为 0

## 阶段 2：显式扫描

- [ ] 2.1 新增显式扫描任务和 API
  - 状态：TODO
  - 主要改哪里：`task-types.ts`、`session-history-service.ts`、`session-controller.ts`、路由
  - 怎么验证：任务去重、启用 provider 过滤、结果幂等写入测试

- [ ] 2.2 新增扫描结果观测和错误状态
  - 状态：TODO
  - 主要改哪里：扫描诊断仓储、观测接口、helper 返回协议
  - 怎么验证：检查扫描指标和失败后旧索引保留

## 阶段 3：前端入口与延迟加载

- [ ] 3.1 新建会话桌面弹窗增加手动扫描按钮
  - 状态：TODO
  - 主要改哪里：`apps/user-app/src/features/conversation/components/WorkbenchLayout.tsx`、i18n、API
  - 怎么验证：按钮状态、重复点击去重、结果提示

- [ ] 3.2 移动端新建会话 Sheet 增加同一动作
  - 状态：TODO
  - 主要改哪里：`MobileCreateSessionSheet.tsx`、i18n、API
  - 怎么验证：移动端组件测试

- [ ] 3.3 虚拟会话和历史改为打开会话后加载
  - 状态：TODO
  - 主要改哪里：会话列表 API、详情加载链路、虚拟会话组件
  - 怎么验证：工作区初始化请求中不出现虚拟会话和历史请求

## 阶段检查

- [ ] 4.1 性能回归检查
  - 状态：TODO
  - 怎么验证：Host 类型检查、相关集成测试、SQLite 检查、手动确认普通刷新不触发扫描

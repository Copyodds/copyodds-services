# 独立后台系统需求文档

## 1. 背景
- 当前 `polymarket-frontend` 是面向普通用户的前台系统，不适合作为运营后台的承载容器。
- 混合交易 MVP 已经在后端具备基础能力：
  - 统一交易风控
  - 系统级开关
  - Leader 风控状态
  - 统一审计事件
  - 基础账务流水与对账摘要
- 运营后台应作为一个独立系统建设，独立部署、独立登录、独立导航，不嵌入当前前台站点。

## 2. 产品目标
- 提供一个仅供内部运营、风控、客服、财务使用的后台系统。
- 实现“可看、可查、可控、可追溯”的最小闭环。
- 首版优先满足混合交易 MVP 的运营与风控需求，不追求复杂 BI、财务总账、审批流。

## 3. 产品边界

### 3.1 包含
- 后台管理员登录与会话管理
- 系统交易模式控制
- Leader 风控管理
- 用户交易冻结与恢复
- 审计事件查询
- 账务流水查询
- 基础对账摘要查看
- 基础仪表盘

### 3.2 不包含
- 完整 OA / RBAC 权限中心
- 多级审批流
- 财务正式结算系统
- 发票、退款、冲正引擎
- 复杂报表与 BI 自助分析
- 与前台共享 UI、共享导航、共享用户登录态

## 4. 目标用户

### 4.1 运营
- 查看系统当前状态
- 暂停交易 / 切换跟踪模式
- 下架或恢复 leader
- 冻结或恢复用户交易

### 4.2 风控
- 查询拦截记录
- 查看原因码与阈值快照
- 标记观察名单或停用 leader

### 4.3 客服
- 按用户或订单排查“为什么没下单”
- 查询账户当前交易限制状态

### 4.4 财务 / 业务
- 查看账务流水
- 查看套餐、Gas、佣金相关记录
- 查看日报级对账摘要

## 5. 系统形态
- 独立前端项目，建议单独目录，例如：
  - `apps/admin-console`
  - 或 `admin-frontend`
- 独立部署域名，建议如：
  - `admin.xxx.com`
  - `ops.xxx.com`
- 独立登录页与后台布局。
- 不复用 `polymarket-frontend` 的普通用户 `AuthProvider`、前台侧边栏、前台路由结构。

## 6. 与现有后端的关系

### 6.1 可直接复用的后端接口
- `GET /api/admin/auth/me`
- `POST /api/admin/auth/login`
- `POST /api/admin/auth/logout`
- `GET /api/admin/dashboard/summary`
- `GET /api/admin/trading/system-control`
- `PATCH /api/admin/trading/system-control`
- `GET /api/admin/trading/leader-risk`
- `PATCH /api/admin/trading/leader-risk/:id`
- `GET /api/admin/trading/audit-events`
- `GET /api/admin/trading/billing-ledger`
- `GET /api/admin/trading/billing-reconcile`
- `GET /api/admin/users`
- `PATCH /api/admin/users/:id/trading-restriction`
- 现有 `copy-trade`、`gas`、`users`、`dashboard` admin 接口

### 6.2 后台前端的认证方式
- 使用独立管理员会话，不使用普通用户 JWT。
- 通过 `/api/admin/auth/login` 建立 admin session cookie。
- 后台前端请求 `/api/admin/**` 时需携带 cookie。
- 后台前端不依赖当前前台站点的 `auth_token`。

## 7. MVP 功能模块

### 7.1 登录页
目标：管理员可以独立登录后台。

功能：
- 邮箱 + 密码登录
- 登录失败提示
- 已登录态自动进入后台首页
- 退出登录

验收标准：
- 未登录访问后台页面时跳转后台登录页
- 登录后可访问受保护后台页面

### 7.2 仪表盘
目标：运营快速判断系统是否异常。

展示内容：
- 当前系统模式
- 风控拦截数（24h）
- 暂停中的用户数
- 已下架 leader 数
- 跟单执行数（24h）
- 待处理套餐订单数
- 总佣金 / 账务总量概览

验收标准：
- 进入后台首页 5 秒内能看到系统运行状态

### 7.3 系统控制
目标：支持一键切换系统交易模式。

功能：
- 查看当前模式：`NORMAL / TRACK_ONLY / PAUSED`
- 查看模式来源：env / db / env+db
- 填写变更原因
- 切换模式

验收标准：
- 模式切换后接口返回成功
- 后台刷新后状态一致
- 审计中可查到变更记录

### 7.4 Leader 风控管理
目标：对 leader 做人工风控处理。

功能：
- leader 列表
- 按地址搜索
- 查看当前状态：`ACTIVE / WATCHLIST / DISABLED`
- 更新状态
- 填写 `reasonCode`、备注、有效期

验收标准：
- 停用后该 leader 不再继续派发跟单
- 恢复后可重新进入正常状态

### 7.5 用户交易限制
目标：支持人工冻结单个用户交易权限。

功能：
- 用户列表
- 按用户名 / 邮箱搜索
- 查看是否冻结
- 冻结 / 解冻
- 填写冻结原因

验收标准：
- 被冻结用户下单时返回明确 `reasonCode`
- 后台可查询冻结状态与更新时间

### 7.6 审计事件查询
目标：支持排查交易与风控动作。

功能：
- 按用户筛选
- 按 action 筛选
- 按 targetType 筛选
- 按 result 筛选
- 按 `reasonCode` 筛选
- 按时间区间筛选
- 查看事件详情 JSON

验收标准：
- 运营能独立定位“为什么被拦截 / 为什么未发单”

### 7.7 账务流水查询
目标：统一查看最小账单视图。

功能：
- 查看 `BillingLedger`
- 按 userId、entryType、sourceType、时间筛选
- 查看 sourceOrderId、amount、balanceAfter、ruleVersion、note

验收标准：
- 至少能串起 Gas、套餐、佣金相关流水

### 7.8 对账摘要
目标：提供日报级核对入口。

功能：
- 展示 Gas orders 数
- 展示 package orders 数
- 展示 billing entries 数
- 展示 commission entries 数
- 展示基础 check 结果

验收标准：
- 财务/运营能快速看到账务流水覆盖是否异常

## 8. 页面结构建议

### 8.1 路由建议
- `/login`
- `/dashboard`
- `/risk/system-control`
- `/risk/leaders`
- `/risk/users`
- `/audit/events`
- `/billing/ledger`
- `/billing/reconcile`

### 8.2 侧边导航建议
- Dashboard
- Risk
- Risk / System Control
- Risk / Leaders
- Risk / Users
- Audit
- Audit / Events
- Billing
- Billing / Ledger
- Billing / Reconcile

## 9. 权限模型建议

### 9.1 MVP 简化版
- `SUPER_ADMIN`
- `OPS`
- `RISK`
- `FINANCE`
- `READONLY`

### 9.2 MVP 最低要求
- 即使首版不做完整 RBAC，也至少要区分：
  - 只读账号
  - 可操作账号

## 10. 前后端接口约定

### 10.1 错误结构
- 后台前端统一读取后端返回的 `message`
- 对交易相关错误保留 `reasonCode`
- 前端不要依赖自由文本做业务判断

### 10.2 展示原则
- 时间统一显示本地格式 + 原始 ISO 可选
- 地址默认展示缩略，支持复制
- JSON 元数据支持折叠查看

## 11. 视觉与交互要求
- 使用后台风格 UI，不延续前台的“交易产品展示风格”
- 信息密度高于前台
- 表格优先
- 可快速筛选
- 列表支持分页
- 操作必须有成功 / 失败反馈

## 12. 非功能要求

### 12.1 安全
- 后台域名与前台域名分离
- cookie 仅用于后台域
- 登录失败要有基本限流
- 敏感操作必须审计

### 12.2 可维护性
- 后台前端独立仓库或独立 app
- 与前台共享 API 类型可以，但不共享业务壳层

### 12.3 部署
- 独立构建
- 独立环境变量
- 可单独灰度

## 13. 首版交付顺序

### Phase 1
- 后台登录
- 仪表盘
- 系统控制

### Phase 2
- Leader 风控
- 用户冻结
- 审计查询

### Phase 3
- 账务流水
- 对账摘要

## 14. 研发拆分建议

### 后端
- 继续提供稳定 admin API
- 补充必要分页、筛选、详情接口

### 后台前端
- 独立初始化项目
- 接入 admin cookie 认证
- 实现后台布局、筛选表格、操作页

### 测试
- 登录链路
- 风控操作链路
- 审计回查链路
- 账务查询链路

## 15. MVP 完成标准
- 管理员可独立登录后台
- 运营可切换系统模式
- 风控可下架 leader、冻结用户
- 客服可查询审计事件
- 财务可查看账务流水与基础对账摘要
- 后台系统与前台系统部署、导航、登录态完全解耦

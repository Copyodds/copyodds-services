# Admin 阶段三（README 中长期能力）单独立项说明

本文档对应产品 README §3.3–3.7 与 §3.8 中超出当前 MVP 的范围，用于后续排期与表结构设计，**不包含实现承诺**。

## 带单地址（§3.3）

- 标签体系、地址分组与聚类、公开展示 / 仅内部观察开关、质量评分模型与入库流程。
- 建议与现有 `CopyLeader`、`LeaderRiskState`、`ObservedTrader`、Smart Money 数据对齐，新增表前需评估与链上/同步任务的一致性。

## 策略模板（§3.4）

- 官方模板、版本、批量下发与风控参数覆盖。
- 需独立模型：模板主表、版本、用户绑定/下发记录；与 `CopySubscription` / `FollowStrategy` 的关系需产品设计。

## 推荐分佣（§3.6）

- 邀请树查询、结算批次、提现审核、KOL 面板、二级规则配置。
- 依赖财务流程与合规；与现有 `GasCommission`、`MallOrderCommission`、`inviteCode`/`referrerId` 扩展需单独 PRD。

## 财务与订阅（§3.7）

- 跟单订阅套餐、试用、发票、退款引擎、到期提醒。
- 当前以 `GasPackage`、账务流水与对账摘要为主；完整财务闭环需独立结算与审批流（参见 `independent-admin-system-requirements.md` §3.2 不包含项）。

## 其它审计（§3.8）

- 用户行为大盘、大额订单专表、节点健康、黑名单命中日志。
- 需定义事件源、采样与保留策略；与 `AuditEvent` / `RiskEvent` / 运维监控的边界需统一。

# Smart Money API 文档与筛选设计

本文档描述聪明钱榜对外接口、当前已支持能力、建议新增的筛选参数设计，以及前端接入方式。

所有接口需在请求头携带 `x-api-key`。

基础路径：`/api/polymarket`

通用响应格式：成功 `{ "code": 0, "data": <业务数据> }`，失败 `{ "code": <非零>, "data": { "message": "..." } }`。

---

## 1. 当前接口

### 1.1 路径

**GET** `/api/polymarket/smart-money/cached`

### 1.2 鉴权

请求头：

- `x-api-key: <API_KEY>`

该接口挂在 `apiKeyAuth` 后，因此前端必须带 `x-api-key`。

### 1.3 当前已支持参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---:|---|
| `limit` | integer | `100` | 返回条数，最终会被后端限制在 `SMART_MONEY_TOP_LIMIT` 内 |
| `offset` | integer | `0` | 跳过前 `offset` 条（分页）；下一页为 `offset + limit`（满页时） |
| `eligibleOnly` | boolean | `true` | 兼容旧版参数；单轨模式下始终按 CopyPool 过滤 |
| `copyPoolOnly` | boolean | 无 | 兼容参数；榜单固定只展示 CopyPool |
| `candidatePeriod` | enum | 无 | 可选 `WEEK`、`MONTH`、`ALL`：只保留 `candidatePeriods` 含该周期的地址（筛选） |
| `rankBy` | enum | 无 | 可选 `WEEK`、`MONTH`、`ALL`：按对应 `sourceRankWeek` / `Month` / `All` 升序排序（null 在后），**不**附加候选周期筛选 |
| `includeCopyability` | boolean | `false` | Phase 2+：为 `true` 时每条返回 `copyabilityScore`、`displayScore`、`copyabilityComputedAt`；Phase 3 另含 `rankScore`、`rankScoreComputedAt` |
| `sortBy` | enum | 无 | 支持 `displayScore`、`copyabilityScore`、`rankScore`、`traderScore`（TraderScore 主展示阶段）等 |
| `tier` | string | 无 | 逗号分隔档位过滤，如 `S,A` |
| `traderType` | enum | 无 | `INFORMATION` / `ARBITRAGE` / `GAMBLER` / `MARKET_MAKER` / `GENERAL` |
| `mainPushOnly` | boolean | `false` | 仅主推：`tier in (S,A)` 且排除做市型 |

**CopyPool 唯一跟单榜**：

- 过滤固定为 `inCopyPool=true` 且 `rank ≠ null`（`eligibleOnly` / `copyPoolOnly` 仅为兼容别名，不再切换另一套榜）。
- 榜内 `rank` 在 `SMART_MONEY_COPYABILITY_ENABLED=true` 时按 `displayScore` 重算；开启 `SMART_MONEY_RANK_MODEL_ENABLED` 时 `displayScore = rankScore×0.6 + copyability×0.4`。
- 入榜/出榜迟滞看 `smartMoneyScore`（**≥40 入、≤30 出**），与 `displayScore` 无关；7D PnL 仅参与软评分，不再作为出入榜硬门。
- 响应中 `eligible` / `activeCandidate` 为废弃字段，镜像 `inCopyPool`。

**排序约定**：若传 `rankBy`，按该维度的官方综合名次列排序。若未传 `rankBy` 但传了 `candidatePeriod`，则按与 `candidatePeriod` 相同维度的名次排序。若两者皆未传：按内部 `rank` 升序（CopyPool）。

### 1.4 当前返回字段

`items[]` 当前会返回以下核心字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `rank` | `number \| null` | 当前榜单名次；不在前榜内时可能为 `null` |
| `wallet` | `string` | 钱包地址 |
| `displayName` | `string \| null` | 展示名称 |
| `profileSlug` | `string \| null` | Polymarket 主页 slug |
| `joinedAtText` | `string \| null` | 加入时间文案，如 `Mar 2024` |
| `profileImage` | `string \| null` | 头像 URL；优先主页解析，缺失时回退官方榜缓存 |
| `xUsername` | `string \| null` | X 用户名；优先主页解析，缺失时回退官方榜缓存 |
| `score` | `string` | 综合得分（`smartMoneyScore` / v4 准入分），`Decimal` 序列化后为字符串 |
| `traderScore` | `string \| null` | TraderScore 0–100（预测能力分层主分；`SMART_MONEY_TRADER_SCORE_AS_PRIMARY=true` 时可作主排序） |
| `tier` | `string \| null` | `S`/`A`/`B`/`C`/`D` 产品档位 |
| `edgeScore` | `string \| null` | Entry Edge 分 |
| `edgeSampleN` | `number \| null` | Edge 样本市场数 |
| `traderType` | `string \| null` | 策略类型标签 |
| `traderCard` | `object \| null` | 原因/风险/星级/适合等完整卡片（列表轻量摘要） |
| `copyabilityScore` | `string \| null` | 仅当 `includeCopyability=true`：30d 跟单仿真分 |
| `displayScore` | `string \| null` | 仅当 `includeCopyability=true`：榜内排序分（Phase 2：copy×0.7 + smart×0.3；Phase 3 ML：rank×0.6 + copy×0.4） |
| `copyabilityComputedAt` | `string \| null` | 仅当 `includeCopyability=true`：仿真计算时间 ISO |
| `rankScore` | `string \| null` | Phase 3：跟单反馈 + v3.1 特征推理分 0–100 |
| `rankScoreComputedAt` | `string \| null` | Phase 3：rankScore 计算时间 ISO |
| `winRateSource` | `string \| null` | 主胜率来源：权威为 `MARKET_CLOSED`（近 365 天已平仓市场）；禁止 `CURVE_PROXY` 冒充 |
| `metricsSourceBadge` | `string \| null` | 外部指标来源 badge |
| `pnlQuality` | `string` | 收益质量分 |
| `activityScore` | `string` | 活跃度分 |
| `consistencyScore` | `string` | 稳定性分 |
| `officialCandidateScore` | `string` | 官方榜来源得分 |
| `externalQualityScore` | `string` | 外部榜质量得分 |
| `riskPenalty` | `string` | 风险扣分 |
| `eligible` | `boolean` | 是否满足当前上榜门槛（legacy；管道模式请用 `inCopyPool`） |
| `inCopyPool` | `boolean` | 是否在跟单榜 CopyPool |
| `activeCandidate` | `boolean` | legacy 候选池标记（管道模式将废弃） |
| `predictionCount` | `number \| null` | 预测次数 |
| `holdingsValue` | `string \| null` | 持仓价值，字符串形式返回 |
| `sourceRankWeek` | `number \| null` | 综合候选来源周榜 rank |
| `sourceRankMonth` | `number \| null` | 综合候选来源月榜 rank |
| `sourceRankAll` | `number \| null` | 综合候选来源全周期 rank |
| `officialSourceRankWeek` | `number \| null` | 官方周榜 rank |
| `officialSourceRankMonth` | `number \| null` | 官方月榜 rank |
| `officialSourceRankAll` | `number \| null` | 官方全周期 rank |
| `externalSourceRankWeek` | `number \| null` | 外部周榜 rank |
| `externalSourceRankMonth` | `number \| null` | 外部月榜 rank |
| `externalSourceRankAll` | `number \| null` | 外部全周期 rank |
| `candidatePeriods` | `string[]` | 候选来源周期，通常为 `WEEK`、`MONTH`、`ALL` 的子集 |
| `externalWinRate` | `string \| null` | 主胜率：近 365 天已平仓盈利市场占比（`winRateSource=MARKET_CLOSED`）；与 TraderScore 同口径 |
| `externalSharpeRatio` | `string \| null` | 展示夏普：本地 ALL 累计 PnL 曲线截近 365 天（不足则开户至今）的简化夏普代理；**不使用** predicting.top |
| `externalTotalReturn` | `string \| null` | 总回报（资本 ROI：区间盈亏 ÷ 占用本金）；禁止用曲线 `(末−初)/初` 充当 |
| `profitFactor` | `string \| null` | 已平仓市场盈亏比（总盈利 ÷ 总亏损）；无亏损时为 null，见 `profitFactorNoLoss`；**禁止**回退曲线 PF |
| `profitFactorNoLoss` | `boolean \| null` | 有盈利且无亏损市场；前端展示 ∞ |
| `winMarketCount` | `number \| null` | 盈利已平仓市场数（近 365 天）；列表不展示，详情「盈亏次数」用 |
| `lossMarketCount` | `number \| null` | 亏损已平仓市场数；同上 |
| `maxDrawdownPercent` | `string \| null` | 最大回撤率：ALL 曲线截近 365 天峰权益 MDD（与 `maxDrawdownUsd` 同源） |
| `maxDrawdownUsd` | `string \| null` | 同上窗口的美元峰谷回撤；禁止用 1W/1M 冒充 |
| `totalPnl` | `string \| null` | 展示用总盈利（USD） |
| `totalPnl1y` | `string \| null` | ALL 曲线截到约 365d 的总盈利；不足一年时配合 `pnlWindowDays` |
| `pnlWindowDays` | `number \| null` | 总盈利实际窗口天数 |
| `recentPnl7d` | `string \| null` | 近 7 日 PnL（来自 1W 用户 PnL 曲线） |
| `recentPnl30d` | `string \| null` | 近 30 日 PnL（ALL 曲线截窗） |
| `trades7d` | `number \| null` | 近 7 日成交笔数（Data API trades） |
| `trades30d` | `number \| null` | 近 30 日成交笔数；评分池默认至少 2 笔 |
| `totalReturn1y` | `string \| null` | 与 1Y PnL 同窗、同本金的回报率 |
| `maxDrawdown1y` | `string \| null` | 与 1Y PnL 同窗、同本金的最大回撤 |
| `backtestPnlUsd` | `string \| null` | **仿真**跟单回测盈亏（延迟+滑点假设） |
| `copyLossRate` | `string \| null` | **仿真**跟单损失率（0–1） |
| `slippageBpsEffective` | `number \| null` | **仿真**有效滑点（bps） |
| `metricsSource` | `object` | 口径标注：`{ pnl, winRate, return, copyMetrics }`；跟单三指标固定 `copyMetrics: "SIMULATION"` |
| `copyMetricsNote` | `string` | 仿真注脚文案（中文）：非本平台真实跟单用户盈亏 |
| `lastCurveEnrichAt` | `string \| null` | Deep-Enrich 最近补曲线时间（1D/1M） |
| `sparkline` | `array \| null` | 1W 曲线降采样火花图 `[{t,v}]`（Enrich E5） |
| `recentMarkets` | `array \| null` | 已平仓市场 Top（Enrich E6 Recent20） |
| `biggestWinRecent` | `string \| null` | 近窗单日最大盈利 |
| `copierFeedback` | `object \| null` | 仅 `includeCopyability=true`：真实跟单反馈快照 |
| `copierFeedbackReady` | `boolean` | 仅同上：样本充足且非洗量嫌疑时为 true；不足时勿把反馈当主数字 |
| `sampleWindowDays` | `number \| null` | 仿真/样本窗口天数 |
| `sampleTradeCount` | `number \| null` | 仿真样本成交笔数 |
| `displayProfile` | `object \| null` | 评分解释中的展示画像（兼容旧客户端；新字段优先读顶层列） |
| `externalMetricsPeriod` | `string \| null` | 上述三字段对应的逻辑周期：`ALL` / `30D` / `7D`（优先 ALL） |
| `externalMetricsSource` | `string \| null` | 指标来源：`PREDICTING_TOP` / `LOCAL_FALLBACK` / `MIXED` |
| `flags` | `string[]` | 风险标记 |
| `scoreExplain` | `object \| null` | 打分解释对象 |
| `lastScoredAt` | `string` | 最近评分时间，ISO 字符串 |
| `sourceFetchedAt` | `string \| null` | 最近抓取主页时间，ISO 字符串 |
| `syncedAt` | `string` | 最近写入榜单缓存时间，ISO 字符串 |
| `tier` | `string \| null` | 产品档位 S/A/B/C/D（榜表权威列） |
| `traderScore` | `string \| null` | TraderScore |

**档位一致性**：入榜地址的列表与详情「档位」都必须读榜表权威字段（列表 `items[].tier`，详情 `summary.tier`）。  
ScoreCache 仅用于管道与未入榜详情；禁止用 `scoreExplain.traderProfile.tier` / ScoreCache 覆盖入榜展示，否则会出现列表 S、详情 C。  
详情接口会对入榜地址把返回的 `scoreExplain.traderProfile.tier`（含 `card.tier`）覆写为榜表 `tier`，兼容旧前端。  
copyability 等派生写在更新榜表后会双写 ScoreCache 的 `scoreExplain`，避免后台读路径分叉。

**仿真注脚（前端必展示）**：`backtestPnlUsd` / `copyLossRate` / `slippageBpsEffective` 为系统按延迟与滑点假设重放历史成交的**仿真**，非本平台真实跟单用户盈亏。样本窗口见 `pnlWindowDays` / `sampleTradeCount` / `sampleWindowDays`。

**胜率口径（统一）**：
- **列表 / 详情「资金与表现」/ TraderScore / Tier**：均为近 **365 天**已平仓市场胜率（`MARKET_CLOSED`）。
- **不含未平仓浮盈亏**；`compositeMarketWinRate` 仅留在 `scoreExplain` 供诊断。
- **入榜原因**：不写胜率数字。假满分路径风险仍可降档（`PERFECT_CLOSED_WR_PATH_RISK`）；样本少前端弱化展示。
- 禁止用 `CURVE_PROXY` 冒充主胜率。

**独立 worker**：生产建议 `SMART_MONEY_CRONS_IN_API=false` + `npm run start:smart-money-worker`（pm2 `smart-money-worker`），避免 API 进程与管道批跑争抢。

身份字段来源优先级：

- `joinedAtText`: Polymarket 主页抓取
- `profileImage`: Polymarket 主页抓取 -> 官方榜缓存回退
- `xUsername`: Polymarket 主页抓取 -> 官方榜缓存回退

外部指标来源约定：

- `externalMetricsSource=PREDICTING_TOP`：展示值与质量分均来自 predicting.top
- `externalMetricsSource=LOCAL_FALLBACK`：展示值与质量分均来自本地快照 / 曲线估算
- `externalMetricsSource=MIXED`：不同周期的质量分输入由 predicting.top 与本地 fallback 混合组成

本地 fallback 说明：

- `externalWinRate` 为本地曲线的正收益区间代理，不等同于逐笔真实胜率（主胜率已平仓口径另见上表）
- `externalSharpeRatio` **始终**为本地 ALL×1Y 曲线步进收益波动算出的简化夏普代理（与 `displayProfile.metricsSource.sharpe=PORTFOLIO_PNL_ALL_1Y` 一致），与 `externalMetricsSource` 是否为 PREDICTING_TOP 无关
- `externalTotalReturn` 为本地 PnL / 曲线变化代理，不等同于第三方源站的原始 totalReturn 公式

响应顶层还包括：

| 字段 | 类型 | 说明 |
|---|---|---|
| `total` | `number` | 当前查询条件下符合的总数 |
| `limit` | `number` | 本次返回上限 |
| `eligibleOnly` | `boolean` | 本次查询是否只看合格地址 |
| `rankBy` | `WEEK \| MONTH \| ALL \| null` | 请求参数原样回显；未传时为 `null` |
| `sortByRank` | `WEEK \| MONTH \| ALL \| null` | 实际用于按名次排序的维度（`rankBy ?? candidatePeriod`，默认榜为 `null`） |
| `scoreVersion` | `string` | 当前评分版本（默认 `v2.3`） |
| `candidateSource` | `string[]` | 当前结果集中覆盖到的候选周期 |
| `syncedAt` | `string \| null` | 当前结果集最近同步时间 |

### 1.4.1 v2.4 入榜门槛（`eligible=true`）

自 `scoreVersion=v2.4` 起：

- **新进上榜**：恢复 **v2.2 严格门槛**（预测次数、持仓下限、曲线质量、数据一致性、交易频率、单点暴利等）。
- **评分排序**：继续用 v2.2 综合 `score`（六维加权 − riskPenalty×35%）。
- **已上榜粘性**：曾进入综合榜前 N（有 `rank`）的地址，短暂踩到质量线**不会立刻** `eligible=false`；仅黑名单 / 噪声 / 确认亏损会硬踢。名次仍可因 `score` 下降被挤出前 N。

**新进硬门槛（对应 `flags`）：**

| 条件 | `flags` |
|------|---------|
| 非黑名单 / 非噪声 | `BLACKLISTED` / `NOISE_TAGGED` |
| 总 PnL > 0 | `NEGATIVE_TOTAL_PNL` |
| 平均盈利率 ≥ 35%（可配 `SMART_MONEY_MIN_AVG_CLOSED_RETURN_RATE`） | `LOW_AVG_CLOSED_RETURN_RATE` |
| 预测次数 / 持仓下限 | `LOW_PREDICTION_COUNT` / `LOW_HOLDINGS` |
| 近期表现 / 曲线 | `WEAK_RECENT_PERFORMANCE` / `SPIKY_CURVE` / `INSUFFICIENT_CURVE_DATA` |
| 数据质量 | `DATA_MISMATCH` / `LOW_DATA_CONFIDENCE` |
| 交易频率 | `TRADE_FREQUENCY_UNVERIFIED`（`HIGH_TRADE_FREQUENCY` 软扣分，不硬拦） |
| 短周期盘 / 粉尘 | `SHORT_HORIZON_MARKET` / `HIGH_DUST_SHARE` 均为软扣分，不硬拦（原 L1-DUST 硬门已取消） |
| 胜率结构 | `LOW_WIN_RATE_CONCENTRATED` / `SINGLE_HIT_DEPENDENCY` |
| 开平仓暴露 | `OPEN_EXPOSURE_UNDERWATER` / `REALIZED_OPEN_WIN_RATE_GAP` |

**内部 `rank`**：`score` 降序 → `lastScoredAt` → 钱包地址。

**粘性恢复（仅已有 rank 的地址）：**

```bash
npm run restore:smart-money
```

**严格清榜（重爬 + 不达标下榜，关闭粘性）：**

```bash
npm run rescore:smart-money:strict
```

**v2.4 重爬重评 Top 2000（保留粘性）：**

```bash
npm run rescore:smart-money:top
```

仅本地重算 score（不重爬）：`npm run rescore:smart-money:top:fast`

### 1.5 当前接口示例

高质量默认榜：

```http
GET /api/polymarket/smart-money/cached
x-api-key: <API_KEY>
```

取前 50：

```http
GET /api/polymarket/smart-money/cached?limit=50
x-api-key: <API_KEY>
```

取前 500，包含未通过质量门槛的地址：

```http
GET /api/polymarket/smart-money/cached?limit=500&eligibleOnly=false
x-api-key: <API_KEY>
```

按周榜综合名次排序（不缩小候选集，适合「周榜 / 月榜 / 总榜」Tab 仅换排序）：

```http
GET /api/polymarket/smart-money/cached?rankBy=WEEK&limit=100
x-api-key: <API_KEY>
```

### 1.6 风险画像 MVP 接口

**Query 参数完整说明（含 `wallet` / `displayName` 二选一、`live`、错误码）见：[smart-money-profile-risk-params.md](./smart-money-profile-risk-params.md)。**  
**资金与表现 KPI 展示格式（盈亏比 / 盈亏次数 / 最大投入）见：[frontend-smart-money-kpi-display.md](./frontend-smart-money-kpi-display.md)。**

#### 路径

**GET** `/api/polymarket/smart-money/profile-risk`

#### 当前已支持参数（摘要）

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---:|---|
| `wallet` | string | 无 | 与 `displayName` **二选一**；`0x` + 40 位十六进制 |
| `displayName` | string | 无 | 与 `wallet` **二选一**；在聪明钱榜行上匹配展示名 |
| `period` | enum | `ALL` | 可选：`1D`、`1W`、`1M`、`ALL` |
| `live` | boolean | `false` | `true` 时合并拉取 Polymarket 官网首屏曲线与库内快照曲线 |

**CopyPool 门禁**：

- 环境变量 `SMART_MONEY_PROFILE_RISK_COPY_POOL_POLICY`：`off` | `warn` | `block`（未设时沿用 `SMART_MONEY_COPY_POOL_SUBSCRIBE_POLICY`，默认 `warn`）
- `block`：非 CopyPool 地址返回 404，`data.notInCopyPool=true`
- `warn`：仍返回画像，在 `meta.notInCopyPool=true` 与 `meta.copyPoolPolicy` 标注
- Admin 后台 `GET /admin/smart-money/traders/{wallet}/risk-profile` 不受此门禁（直读 DB）

#### 返回结构

该接口返回一个单钱包风险详情对象，主要分为 7 块：

| 字段 | 类型 | 说明 |
|---|---|---|
| `wallet` | `string` | 钱包地址 |
| `summary` | `object \| null` | 当前聪明钱榜缓存摘要，来自 `SmartMoneyLeaderboardRow` |
| `profile` | `object` | 最新主页快照画像，来自 `TraderProfileSnapshot` |
| `curve` | `object` | 所选周期曲线与基础区间变化 |
| `backtest` | `object` | 基于当前 `curve.points` 推导出的进阶回测统计 |
| `risk` | `object` | 基于所选周期曲线现算的风险代理指标 |
| `externalRisk` | `object \| null` | 对应 predicting.top 周期的外部风险指标（若存在） |
| `meta` | `object` | 快照时间、评分时间、同步时间等元信息 |

`curve` 当前字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `period` | `string` | 请求周期（与 Query 一致） |
| `resolvedPeriod` | `string` | 实际用于 `points` / `curveType` / 覆盖度计算的周期；无回退时与 `period` 相同 |
| `activePeriod` | `string`（可选） | 仅当 `resolvedPeriod !== period` 时出现，与 `resolvedPeriod` 同值 |
| `curveType` | `string` | 与当前 `points` 一致的内部曲线类型，如 `PORTFOLIO_PNL_ALL` |
| `availablePeriods` | `string[]` | 当前合并结果中至少有一个点的周期列表 |
| `points` | `Array<{ ts: string; value: number }>` | 当前周期曲线点，按时间升序 |
| `startTs` | `string \| null` | 当前曲线窗口起始时间 |
| `endTs` | `string \| null` | 当前曲线窗口结束时间 |
| `coverageDays` | `number \| null` | 当前曲线实际覆盖天数 |
| `requestedPeriodDays` | `number \| null` | 请求周期理论天数；`ALL` 为 `null` |
| `hasFullRequestedWindow` | `boolean \| null` | 是否覆盖了完整请求窗口；历史不足时可能为 `false` |
| `startValue` | `number \| null` | 区间起点值 |
| `latestValue` | `number \| null` | 区间终点值 |
| `changeValue` | `number \| null` | 区间绝对变化值 |

`backtest` 当前字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `sampledDayCount` | `number` | 当前曲线窗口内，满足“同一 UTC 日至少 2 个点”的采样日数量 |
| `positiveDayRatio` | `number \| null` | 正收益日占比；按日首点到日末点变化计算 |
| `negativeDayRatio` | `number \| null` | 负收益日占比 |
| `maxStepGainValue` | `number \| null` | 曲线相邻两点之间的最大单步上涨值 |
| `maxStepLossValue` | `number \| null` | 曲线相邻两点之间的最大单步下跌值 |
| `bestDay` | `object \| null` | 单日最佳表现；基于该 UTC 日首点到末点的变化 |
| `worstDay` | `object \| null` | 单日最差表现；可视作“单日最大亏损”代理 |
| `worstIntradayDrawdownDay` | `object \| null` | 单日盘中最大回撤对应的日桶；扫描该日运行峰值到后续低点 |
| `losingStreaks` | `object` | 连续亏损天数统计 |
| `rollingWorst7D` | `object \| null` | 当前窗口内最差 7D 滚动区间 |
| `rollingWorst30D` | `object \| null` | 当前窗口内最差 30D 滚动区间 |
| `dailyReturnDistribution` | `object` | 日收益分布统计，便于做收益画像与稳定性判断 |

`backtest.bestDay` / `backtest.worstDay` / `backtest.worstIntradayDrawdownDay` 字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `date` | `string` | UTC 自然日，例如 `2026-03-31` |
| `startTs` | `string` | 当日首个曲线点时间 |
| `endTs` | `string` | 当日最后一个曲线点时间 |
| `openValue` | `number \| null` | 当日首点值 |
| `closeValue` | `number \| null` | 当日末点值 |
| `highValue` | `number \| null` | 当日最高点值 |
| `lowValue` | `number \| null` | 当日最低点值 |
| `pointCount` | `number` | 当日参与计算的曲线点数 |
| `changeValue` | `number \| null` | 当日首点到末点的绝对变化值 |
| `changeRatio` | `number \| null` | 当日首点到末点的收益比例代理 |
| `intradayMaxDrawdownValue` | `number \| null` | 当日盘中最大回撤绝对值 |
| `intradayMaxDrawdownRatio` | `number \| null` | 当日盘中最大回撤比例 |
| `intradayPeakValue` | `number \| null` | 当日盘中最大回撤对应的峰值点数值 |
| `intradayPeakTs` | `string \| null` | 当日盘中最大回撤对应的峰值时间 |
| `intradayTroughValue` | `number \| null` | 当日盘中最大回撤对应的低点数值 |
| `intradayTroughTs` | `string \| null` | 当日盘中最大回撤对应的低点时间 |

`backtest.losingStreaks` 字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `longestLosingStreakDays` | `number` | 最长连续亏损采样日数量 |
| `longestLosingStreakStartDate` | `string \| null` | 最长连续亏损起始 UTC 日 |
| `longestLosingStreakEndDate` | `string \| null` | 最长连续亏损结束 UTC 日 |
| `currentLosingStreakDays` | `number` | 截至当前窗口尾部的连续亏损天数 |
| `currentLosingStreakStartDate` | `string \| null` | 当前连续亏损序列起始 UTC 日 |

`backtest.rollingWorst7D` / `backtest.rollingWorst30D` 字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `windowDays` | `number` | 目标滚动窗口天数，例如 `7` 或 `30` |
| `startDate` | `string` | 滚动区间起始 UTC 日 |
| `endDate` | `string` | 滚动区间结束 UTC 日 |
| `startTs` | `string` | 滚动区间首个采样点时间 |
| `endTs` | `string` | 滚动区间最后一个采样点时间 |
| `openValue` | `number \| null` | 滚动区间起点值 |
| `closeValue` | `number \| null` | 滚动区间终点值 |
| `changeValue` | `number \| null` | 滚动区间绝对变化值 |
| `changeRatio` | `number \| null` | 滚动区间收益比例代理 |
| `sampledDayCount` | `number` | 实际参与的采样日数量 |
| `calendarDaySpan` | `number` | 该区间覆盖的自然日跨度 |
| `hasFullWindow` | `boolean` | 是否拿到了完整 7D / 30D 自然日窗口 |

`backtest.dailyReturnDistribution` 字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `sampledDayCount` | `number` | 参与日收益分布统计的采样日数量 |
| `meanReturn` | `number \| null` | 日收益均值 |
| `medianReturn` | `number \| null` | 日收益中位数 |
| `buckets` | `Array<{ id: string, label: string, count: number, ratio: number \| null }>` | 日收益区间分布，目前分为 9 档：`<= -5%`、`-5% ~ -2%`、`-2% ~ -1%`、`-1% ~ 0%`、`0% ~ +1%`、`+1% ~ +2%`、`+2% ~ +5%`、`+5% ~ +10%`、`>= +10%` |

`backtest.closedMarketReturnDistribution` 字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `sampledMarketCount` | `number` | 参与统计的已平仓市场数量 |
| `meanReturn` | `number \| null` | 已平仓市场收益率均值 |
| `medianReturn` | `number \| null` | 已平仓市场收益率中位数 |
| `buckets` | `Array<{ id: string, label: string, count: number, ratio: number \| null }>` | 已平仓市场收益分布，分桶与 `dailyReturnDistribution` 保持一致 |

`risk` 当前字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `source` | `LOCAL_CURVE \| PREDICTING_TOP \| null` | 风险指标来源；优先本地曲线，曲线不足时回退第三方 |
| `riskScore` | `number \| null` | 展示型风险分数，基于风险扣分、回撤、波动等估算 |
| `riskLevel` | `LOW \| MEDIUM \| HIGH \| EXTREME \| UNKNOWN` | 风险等级 |
| `maxDrawdownPercent` | `number \| null` | 最大回撤比例 |
| `currentDrawdown` | `number \| null` | 当前回撤比例 |
| `returnRatio` | `number \| null` | 当前周期收益代理 |
| `sharpeLike` | `number \| null` | 简化夏普代理：**固定** ALL×1Y 本地计算，不随详情页曲线周期切换，不回退第三方 |
| `sortinoLike` | `number \| null` | 简化 Sortino 代理 |
| `winRateProxy` | `number \| null` | 曲线正收益步长占比代理，不等同于逐笔胜率 |
| `volatilityProxy` | `number \| null` | 基于曲线步长的波动代理 |

注意：

- 当前主图是 **PnL / 权益代理曲线**，不是严格意义上的钱包净值曲线。
- `backtest` 所有指标都严格基于当前 `curve.points` 计算，与页面主图同源，不再混用官方 `volumeSummary.pnl`。
- `closedMarketReturnDistribution` 不基于曲线，而是基于评分阶段缓存的 `closed-positions` 数据；优先读取 DB 缓存，不在详情页实时回放逐笔订单。
- Deep 采集：近 365 天时间早停 + 最多约 80 页（≈4000 行）+ 总超时；`displayProfile.closedSample.capped` 表示可能未采全。
- 展示回撤仅用 ALL×1Y；展示夏普仅用 ALL×1Y 本地代理；盈亏比仅用已平仓（无亏损 → `profitFactorNoLoss`）。
- “单日最大亏损” 当前定义为某个 UTC 日内 **首点到末点** 的最差变化；“单日盘中最大回撤” 则会额外扫描该日盘中峰值到后续低点。
- 如果某钱包历史不足，例如只抓到 5 天数据，那么 `1W`、`1M`、`ALL` 可能会返回同一段曲线；可结合 `coverageDays` 与 `hasFullRequestedWindow` 判断是否因为历史覆盖不足导致。
- `rollingWorst7D` / `rollingWorst30D` 在历史不足时也会返回当前可用样本内的最差区间，此时 `hasFullWindow` 会是 `false`。
- 该接口是“够用版本”风险画像，不包含真实交易流水、6M/1Y 长周期、预测型 growth 指标。

#### `meta.displayProfile` · 资金与表现 KPI

详情页「资金与表现」模块优先读 `meta.displayProfile`（与列表 `displayProfile` 同结构）。展示规范见 [frontend-smart-money-kpi-display.md](./frontend-smart-money-kpi-display.md)。

| 字段 | 说明 |
|------|------|
| `profitFactor` | 盈亏比；**仅显示数值**，不与赢/亏次数拼接 |
| `winMarketCount` / `lossMarketCount` | 盈亏次数：`{win} / {loss}` 独立一行 |
| `maxInvestedCostUsd` | 最大投入主值 |
| `maxInvestedRealizedPnl` | 副行「平仓盈亏 ±$…」；**勿展示** `maxInvestedTitle` |

#### 示例

```http
GET /api/polymarket/smart-money/profile-risk?wallet=0x1234567890abcdef1234567890abcdef12345678&period=ALL
x-api-key: <API_KEY>
```

示例响应（字段已省略部分非关键 summary / profile 内容）：

```json
{
  "wallet": "0x1234567890abcdef1234567890abcdef12345678",
  "summary": {
    "rank": 12,
    "wallet": "0x1234567890abcdef1234567890abcdef12345678",
    "displayName": "Galindrast",
    "score": "84.2",
    "riskPenalty": "8"
  },
  "profile": {
    "displayName": "Galindrast",
    "profileSlug": "galindrast",
    "totalPnl": "120846.45",
    "totalVolume": "6036.21"
  },
  "curve": {
    "period": "1M",
    "curveType": "PORTFOLIO_PNL_1M",
    "availablePeriods": ["1D", "1W", "1M", "ALL"],
    "points": [
      { "ts": "2026-03-25T09:00:00.000Z", "value": 2100.12 },
      { "ts": "2026-03-25T18:00:00.000Z", "value": 2450.31 }
    ],
    "startTs": "2026-03-25T09:00:00.000Z",
    "endTs": "2026-03-31T10:00:00.000Z",
    "coverageDays": 5.7,
    "requestedPeriodDays": 30,
    "hasFullRequestedWindow": false,
    "startValue": 2100.12,
    "latestValue": 118000.33,
    "changeValue": 115900.21
  },
  "backtest": {
    "sampledDayCount": 6,
    "positiveDayRatio": 0.6667,
    "negativeDayRatio": 0.3333,
    "maxStepGainValue": 9420.6,
    "maxStepLossValue": -5180.2,
    "bestDay": {
      "date": "2026-03-30",
      "startTs": "2026-03-30T00:12:00.000Z",
      "endTs": "2026-03-30T23:54:00.000Z",
      "openValue": 78210.5,
      "closeValue": 94150.9,
      "highValue": 95500.1,
      "lowValue": 77820.2,
      "pointCount": 11,
      "changeValue": 15940.4,
      "changeRatio": 0.1694,
      "intradayMaxDrawdownValue": 2120.7,
      "intradayMaxDrawdownRatio": 0.0222,
      "intradayPeakValue": 95500.1,
      "intradayPeakTs": "2026-03-30T19:05:00.000Z",
      "intradayTroughValue": 93379.4,
      "intradayTroughTs": "2026-03-30T20:41:00.000Z"
    },
    "worstDay": {
      "date": "2026-03-28",
      "startTs": "2026-03-28T02:01:00.000Z",
      "endTs": "2026-03-28T23:10:00.000Z",
      "openValue": 82430.5,
      "closeValue": 78100.2,
      "highValue": 83000.0,
      "lowValue": 77080.4,
      "pointCount": 9,
      "changeValue": -4330.3,
      "changeRatio": -0.0525,
      "intradayMaxDrawdownValue": 5919.6,
      "intradayMaxDrawdownRatio": 0.0713,
      "intradayPeakValue": 83000.0,
      "intradayPeakTs": "2026-03-28T04:20:00.000Z",
      "intradayTroughValue": 77080.4,
      "intradayTroughTs": "2026-03-28T18:42:00.000Z"
    },
    "worstIntradayDrawdownDay": {
      "date": "2026-03-28",
      "startTs": "2026-03-28T02:01:00.000Z",
      "endTs": "2026-03-28T23:10:00.000Z",
      "openValue": 82430.5,
      "closeValue": 78100.2,
      "highValue": 83000.0,
      "lowValue": 77080.4,
      "pointCount": 9,
      "changeValue": -4330.3,
      "changeRatio": -0.0525,
      "intradayMaxDrawdownValue": 5919.6,
      "intradayMaxDrawdownRatio": 0.0713,
      "intradayPeakValue": 83000.0,
      "intradayPeakTs": "2026-03-28T04:20:00.000Z",
      "intradayTroughValue": 77080.4,
      "intradayTroughTs": "2026-03-28T18:42:00.000Z"
    },
    "losingStreaks": {
      "longestLosingStreakDays": 2,
      "longestLosingStreakStartDate": "2026-03-27",
      "longestLosingStreakEndDate": "2026-03-28",
      "currentLosingStreakDays": 0,
      "currentLosingStreakStartDate": null
    },
    "rollingWorst7D": {
      "windowDays": 7,
      "startDate": "2026-03-25",
      "endDate": "2026-03-31",
      "startTs": "2026-03-25T09:00:00.000Z",
      "endTs": "2026-03-31T10:00:00.000Z",
      "openValue": 2100.12,
      "closeValue": 118000.33,
      "changeValue": 115900.21,
      "changeRatio": 0.9822,
      "sampledDayCount": 6,
      "calendarDaySpan": 7,
      "hasFullWindow": true
    },
    "rollingWorst30D": {
      "windowDays": 30,
      "startDate": "2026-03-25",
      "endDate": "2026-03-31",
      "startTs": "2026-03-25T09:00:00.000Z",
      "endTs": "2026-03-31T10:00:00.000Z",
      "openValue": 2100.12,
      "closeValue": 118000.33,
      "changeValue": 115900.21,
      "changeRatio": 0.9822,
      "sampledDayCount": 6,
      "calendarDaySpan": 7,
      "hasFullWindow": false
    },
    "dailyReturnDistribution": {
      "sampledDayCount": 6,
      "meanReturn": 0.0312,
      "medianReturn": 0.0186,
      "buckets": [
        { "id": "leMinus5", "label": "<= -5%", "count": 0, "ratio": 0 },
        { "id": "minus5ToMinus2", "label": "-5% to -2%", "count": 1, "ratio": 0.1667 },
        { "id": "minus2ToMinus1", "label": "-2% to -1%", "count": 0, "ratio": 0 },
        { "id": "minus1ToZero", "label": "-1% to 0%", "count": 0, "ratio": 0 },
        { "id": "zeroToPlus1", "label": "0% to +1%", "count": 1, "ratio": 0.1667 },
        { "id": "plus1ToPlus2", "label": "+1% to +2%", "count": 1, "ratio": 0.1667 },
        { "id": "plus2ToPlus5", "label": "+2% to +5%", "count": 1, "ratio": 0.1667 },
        { "id": "plus5ToPlus10", "label": "+5% to +10%", "count": 1, "ratio": 0.1667 },
        { "id": "gePlus10", "label": ">= +10%", "count": 1, "ratio": 0.1667 }
      ]
    }
  },
  "risk": {
    "source": "LOCAL_CURVE",
    "riskScore": 19.2,
    "riskLevel": "LOW",
    "maxDrawdownPercent": 0.094,
    "currentDrawdown": 0.0,
    "returnRatio": 0.9822,
    "sharpeLike": 3.1,
    "sortinoLike": 8.0,
    "winRateProxy": 0.87,
    "volatilityProxy": 0.13
  },
  "externalRisk": null,
  "meta": {
    "snapshotAt": "2026-03-31T10:05:00.000Z",
    "syncedAt": "2026-03-31T10:06:00.000Z",
    "externalMetricsSource": "MIXED"
  }
}
```

---

## 2. 当前已支持 vs 建议新增

### 2.1 当前后端已支持

- `limit`
- `eligibleOnly`

### 2.2 可以快速扩展支持

以下字段都已经在 `SmartMoneyLeaderboardRow` 中落表，后端可以较低成本加到 query schema 中：

- `score`
- `eligible`
- `flags`
- `predictionCount`
- `holdingsValue`
- `sourceRankWeek`
- `sourceRankMonth`
- `sourceRankAll`
- `officialSourceRankWeek`
- `officialSourceRankMonth`
- `officialSourceRankAll`
- `externalSourceRankWeek`
- `externalSourceRankMonth`
- `externalSourceRankAll`
- `candidatePeriods`

### 2.3 当前不建议直接暴露为原始字段的能力

虽然上面字段都能筛选，但不建议把数据库列名原样全部开放给前端。更推荐抽象成业务参数，如：

- `minScore`
- `minPredictionCount`
- `minHoldingsValue`
- `candidatePeriod`
- `maxOfficialRankWeek`
- `maxExternalRankMonth`
- `hasFlag`
- `excludeFlag`

这样前端更容易理解，也更方便后端后续改内部实现。

---

## 3. 建议新增的筛选参数设计

以下为**建议新增**，不是当前已上线能力。

### 3.1 基础控制

| 参数 | 类型 | 默认值 | 多值 | 建议语义 |
|---|---|---:|---|---|
| `limit` | integer | `100` | 否 | 返回条数，最终仍受 `SMART_MONEY_TOP_LIMIT` 限制 |
| `eligibleOnly` | boolean | `true` | 否 | 只看合格地址 |

### 3.2 质量筛选

| 参数 | 类型 | 默认值 | 多值 | 建议语义 |
|---|---|---:|---|---|
| `minScore` | number | 无 | 否 | `score >= minScore` |
| `maxScore` | number | 无 | 否 | `score <= maxScore` |
| `minPredictionCount` | integer | 无 | 否 | `predictionCount >= minPredictionCount` |
| `minHoldingsValue` | number | 无 | 否 | `holdingsValue >= minHoldingsValue` |

### 3.3 来源周期筛选

| 参数 | 类型 | 默认值 | 多值 | 建议语义 |
|---|---|---:|---|---|
| `candidatePeriod` | enum | 无 | 否 | 只看候选来源包含指定周期的地址；枚举 `WEEK`、`MONTH`、`ALL` |
| `candidatePeriods` | string | 无 | 是 | 命中任一周期即可；例如 `WEEK,MONTH` |

推荐二选一即可。若只留一个，优先保留 `candidatePeriod`。

### 3.4 排名筛选

| 参数 | 类型 | 默认值 | 多值 | 建议语义 |
|---|---|---:|---|---|
| `maxSourceRankWeek` | integer | 无 | 否 | `sourceRankWeek <= value` |
| `maxSourceRankMonth` | integer | 无 | 否 | `sourceRankMonth <= value` |
| `maxSourceRankAll` | integer | 无 | 否 | `sourceRankAll <= value` |
| `maxOfficialRankWeek` | integer | 无 | 否 | `officialSourceRankWeek <= value` |
| `maxOfficialRankMonth` | integer | 无 | 否 | `officialSourceRankMonth <= value` |
| `maxOfficialRankAll` | integer | 无 | 否 | `officialSourceRankAll <= value` |
| `maxExternalRankWeek` | integer | 无 | 否 | `externalSourceRankWeek <= value` |
| `maxExternalRankMonth` | integer | 无 | 否 | `externalSourceRankMonth <= value` |
| `maxExternalRankAll` | integer | 无 | 否 | `externalSourceRankAll <= value` |

### 3.5 风险筛选

| 参数 | 类型 | 默认值 | 多值 | 建议语义 |
|---|---|---:|---|---|
| `hasFlag` | string | 无 | 否 | 必须包含某个 flag |
| `hasAnyFlags` | string | 无 | 是 | 命中任意一个 flag 即可 |
| `excludeFlag` | string | 无 | 否 | 不包含某个 flag |
| `excludeFlags` | string | 无 | 是 | 不包含任意一个输入 flag |

推荐最小集合优先做：

- `hasFlag`
- `excludeFlag`

---

## 4. 后端 where 映射建议

以下为建议新增参数的 Prisma `where` 映射思路。

### 4.1 基础 where

继续保留当前基础条件：

```ts
const where = {
  ...(eligibleOnly ? { eligible: true } : {}),
  sourceFetchedAt: { gte: freshSince },
  wallet: { in: activeWallets.length > 0 ? activeWallets : ['__no_wallet__'] },
}
```

### 4.2 质量筛选映射

```ts
if (minScore != null) where.score = { ...(where.score ?? {}), gte: new Prisma.Decimal(minScore) }
if (maxScore != null) where.score = { ...(where.score ?? {}), lte: new Prisma.Decimal(maxScore) }
if (minPredictionCount != null) where.predictionCount = { gte: minPredictionCount }
if (minHoldingsValue != null) where.holdingsValue = { gte: new Prisma.Decimal(minHoldingsValue) }
```

### 4.3 周期筛选映射

```ts
if (candidatePeriod) where.candidatePeriods = { has: candidatePeriod }
if (candidatePeriods?.length) where.candidatePeriods = { hasSome: candidatePeriods }
```

### 4.4 排名筛选映射

建议约定：

- 传入某个 rank 筛选时，`null` 视为“不命中”
- 即只筛 `<= value` 的有效 rank，不把 `null` 包进来

示例：

```ts
if (maxOfficialRankWeek != null) {
  where.officialSourceRankWeek = { lte: maxOfficialRankWeek }
}
```

同理扩展到：

- `sourceRankWeek/Month/All`
- `officialSourceRankWeek/Month/All`
- `externalSourceRankWeek/Month/All`

### 4.5 flags 筛选映射

```ts
if (hasFlag) where.riskFlags = { has: hasFlag }
if (hasAnyFlags?.length) where.riskFlags = { hasSome: hasAnyFlags }
if (excludeFlag) where.NOT = [...(where.NOT ?? []), { riskFlags: { has: excludeFlag } }]
if (excludeFlags?.length) {
  for (const flag of excludeFlags) {
    where.NOT = [...(where.NOT ?? []), { riskFlags: { has: flag } }]
  }
}
```

---

## 5. 数据类型与边界约定

### 5.1 Decimal 字段

以下字段在数据库中是 `Decimal`，建议 query 参数允许前端传数字字符串：

- `score`
- `holdingsValue`

后端统一转成 `Prisma.Decimal` 参与查询。

### 5.2 可空 rank 字段

以下 rank 字段均可能为 `null`：

- `sourceRankWeek/Month/All`
- `officialSourceRankWeek/Month/All`
- `externalSourceRankWeek/Month/All`
- `rank`

建议语义：

- 不传 rank 过滤时：允许 `null`
- 传 rank 过滤时：自动排除 `null`

### 5.3 数组字段

数组字段包括：

- `flags`
- `candidatePeriods`

建议约定：

- 单值筛选用 `has`
- 多值任一命中用 `hasSome`
- 多值全命中如未来需要，再扩展 `hasEvery`

---

## 6. 前端接入文档

### 6.1 Fetch 示例

```ts
const res = await fetch('/api/polymarket/smart-money/cached?limit=100&eligibleOnly=true', {
  headers: {
    'x-api-key': apiKey,
  },
});

const json = await res.json();
const data = json.data;
```

### 6.2 Axios 示例

```ts
import axios from 'axios';

const { data } = await axios.get('/api/polymarket/smart-money/cached', {
  params: {
    limit: 100,
    eligibleOnly: true,
  },
  headers: {
    'x-api-key': apiKey,
  },
});
```

### 6.3 建议新增参数接入示例

以下 URL 为**设计稿示例**，不是当前已上线能力。

高质量榜：

```http
GET /api/polymarket/smart-money/cached?limit=100&eligibleOnly=true&minScore=70&excludeFlag=SPIKY_CURVE
```

周榜倾向榜：

```http
GET /api/polymarket/smart-money/cached?limit=100&candidatePeriod=WEEK&maxOfficialRankWeek=100
```

月榜高质量带单榜：

```http
GET /api/polymarket/smart-money/cached?limit=100&candidatePeriod=MONTH&minPredictionCount=30&minHoldingsValue=500
```

更保守带单榜：

```http
GET /api/polymarket/smart-money/cached?limit=100&eligibleOnly=true&excludeFlag=WEAK_RECENT_PERFORMANCE&excludeFlag=NOISE_TAGGED
```

### 6.4 前端字段使用建议

建议前端按以下方式消费数据：

- `rank`: 若为 `null`，表示当前不在榜单前列，不建议展示成数值名次
- `score`: 作为展示分数时先转 `Number(score)`
- `holdingsValue`: 同样建议转数值后再格式化
- `flags`: 可做标签展示，如 `SPIKY_CURVE`、`LOW_HOLDINGS`；`[]` 表示**未触发异常标签**，不要展示为「无风险」
- `riskPenalty`: 风险扣分（0–100 字符串），由 `flags` 加权汇总并已计入 `score`（约 −35% 权重）。列表接口无 `riskLevel` 时，可用 `riskPenalty` 作辅助展示：
  - `0`：轻微软风险（未触发 `flags` 扣分项，但预测市场/跟单仍有固有波动）
  - `1–20`：低风险（有轻微软风险标记，如 `CURRENT_DRAWDOWN`、`LOW_PROFIT_FACTOR`）
  - `21–40`：中等风险
  - `41+`：扣分较高，对外推荐应更保守
- `candidatePeriods`: 可用来标记该地址命中了 `WEEK` / `MONTH` / `ALL` 哪些来源周期
- `externalMetricsSource`: 建议作为 tooltip 或 badge 展示，避免把本地估算误读成 predicting.top 原始值

Poly / 机器人 JSON 输出建议同时带上 `flags` 与 `riskPenalty`；`flags` 为空时写「未触发异常标签」，`riskPenalty` 为 `0` 时对应「轻微软风险」，并仍附免责声明。

### 6.5 TypeScript 响应类型建议

```ts
type SmartMoneyItem = {
  rank: number | null;
  wallet: string;
  displayName: string | null;
  profileSlug: string | null;
  joinedAtText: string | null;
  profileImage: string | null;
  xUsername: string | null;
  score: string;
  pnlQuality: string;
  activityScore: string;
  consistencyScore: string;
  officialCandidateScore: string;
  externalQualityScore: string;
  riskPenalty: string;
  eligible: boolean;
  predictionCount: number | null;
  holdingsValue: string | null;
  sourceRankWeek: number | null;
  sourceRankMonth: number | null;
  sourceRankAll: number | null;
  officialSourceRankWeek: number | null;
  officialSourceRankMonth: number | null;
  officialSourceRankAll: number | null;
  externalSourceRankWeek: number | null;
  externalSourceRankMonth: number | null;
  externalSourceRankAll: number | null;
  candidatePeriods: string[];
  externalWinRate: string | null;
  externalSharpeRatio: string | null;
  externalTotalReturn: string | null;
  externalMetricsPeriod: string | null;
  externalMetricsSource: string | null;
  flags: string[];
  scoreExplain: Record<string, unknown> | null;
  lastScoredAt: string;
  sourceFetchedAt: string | null;
  syncedAt: string;
};

type SmartMoneyResponse = {
  items: SmartMoneyItem[];
  total: number;
  limit: number;
  eligibleOnly: boolean;
  scoreVersion: string;
  candidateSource: string[];
  syncedAt: string | null;
};
```

---

## 6.5 Internal / Admin API（运维）

鉴权：`X-Internal-Secret: <COPY_INTERNAL_SECRET>`（Internal）；Admin 走 session + 代理 backend。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/internal/smart-money/ingest` | 批量写入 RawAddress |
| POST | `/api/internal/smart-money/analyze/light/:wallet` | 单地址 Light Analyze（Tier1L） |
| POST | `/api/internal/smart-money/analyze/full/:wallet` | 单地址 Deep Analyze（全链路评分） |
| POST | `/api/internal/smart-money/score/:wallet` | 同 Deep，额外返回 `scoreCache`；body 可选 `{ recomputeRanks, skipIngest }` |
| POST | `/api/internal/smart-money/refresh-profile` | Admin 统一评分入口 |
| GET | `/api/internal/smart-money/pipeline/stats` | 漏斗各 stage 计数 |
| GET | `/admin/smart-money/pipeline` | Admin 代理上述 stats |

---

## 7. 推荐前端筛选组合

### 7.1 当前已上线可直接用

- 默认高质量榜：`limit=100&eligibleOnly=true`
- 大盘观察榜：`limit=500&eligibleOnly=false`

### 7.2 建议新增后优先支持

最值得优先上线的 6 个参数：

- `minScore`
- `eligibleOnly`
- `candidatePeriod`
- `maxOfficialRankWeek`
- `minPredictionCount`
- `excludeFlag`

这组参数已经足够覆盖以下常见需求：

- 高质量聪明钱榜
- 周榜偏好榜
- 更保守的带单榜
- 排除高风险地址榜

---

## 8. 结论

- 当前聪明钱接口已经具备稳定的读取能力，但筛选参数还很少。
- 大部分前端想要的筛选能力，后端都可以基于现有落表字段低成本扩展。
- 文档中所有“建议新增参数”均为设计稿，不代表当前已上线；前端接入时应优先按“当前已支持”部分实现，避免误用。 

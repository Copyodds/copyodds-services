# Smart Money KPI 展示规范（资金与表现 / 排行榜列表）

本文档约定前端对盈亏比、盈亏次数、最大投入、总/平均盈利率等字段的**展示格式**与**参数说明**文案。  
后端 API 返回数值字段，**不在服务端拼接** `2.66 (500 / 0)` 这类复合字符串。

## 口径总原则

| 层级 | 含义 | 对用户文案 |
|------|------|------------|
| **产品窗口** | 近 365 天；开户不足一年则「开户至今」 | 「近一年已平仓 / 近一年账户曲线」 |
| **工程上限** | closed 最多约 80 页（≈4000 行）+ 总超时 | **不写进文案**；仅 `closedSample.capped` 时提示「样本可能未采全」 |
| **实际样本** | `min(一年内全部, 硬顶)` | 可选副文案 `样本 N=…` |

模块顶注保持：

> 数据以近一年已平仓交易分析计算（适用指标）

**不要**写成「根据 4000 行数据分析」。

---

## 数据来源分桶

### A. 近一年已平仓样本（适用指标）

来源：Data API `closed-positions`（评分 Deep 写入 `displayProfile` / `closedPositions`）。

| 字段 | 说明 |
|------|------|
| 总盈利率 / 平均盈利率 | `totalReturnRatio` / `avgClosedReturnRate` |
| 已平仓盈亏（原「近一年盈利」） | `totalPnl1y` / `closedRealizedPnl1y` = 样本 ΣrealizedPnl |
| 胜率、盈亏比、盈亏次数 | `winRate` / `profitFactor` (+`profitFactorNoLoss`) / `winMarketCount`·`lossMarketCount` |
| 最大投入 | `maxInvestedCostUsd` 等 |

### B. 账户曲线（不适用 closed 行）

| 字段 | 说明 |
|------|------|
| **总盈亏** | 主页/ALL 曲线净值（保持现状） |
| **最大回撤金额 / 回撤率** | **仅** `PORTFOLIO_PNL_ALL` 截近 365 天；`maxDrawdownUsd` 与 `maxDrawdownPercent` 同源 |
| 近 7/30 日盈亏 | 短窗辅指标 |

### C. 其它

| 字段 | 来源 |
|------|------|
| 未实现盈亏 | 当前持仓 |
| 总成交量 | 主页 volume |

---

## 接口字段

| 场景 | 接口 | 字段 |
|------|------|------|
| 排行榜列表 | `GET /api/polymarket/smart-money/cached` | 顶层 `profitFactor`；`winMarketCount` / `lossMarketCount`（或 `displayProfile.*`）；总盈利率见 `externalTotalReturn` / 列 `totalReturn1y` |
| 地址详情 · 资金与表现 | `GET /api/polymarket/smart-money/profile-risk` | `meta.displayProfile` |

`displayProfile` 主要字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `profitFactor` | `number \| null` | 已平仓市场盈亏比；**禁止**回退曲线/外部 PF |
| `profitFactorNoLoss` | `boolean` | 有盈利且无亏损市场；展示 `∞` 或「无亏损」，勿用占位 99 |
| `winMarketCount` / `lossMarketCount` | `number \| null` | 盈利/亏损已平仓市场数（近 365 天样本） |
| `maxInvestedCostUsd` 等 | — | 最大投入 |
| `totalReturnRatio` | `number \| null` | 总盈利率：`Σpnl/Σcost` |
| `avgClosedReturnRate` | `number \| null` | 平均盈利率：等权 |
| `totalPnl1y` / `closedRealizedPnl1y` | `number \| null` | **已平仓盈亏**（样本加总）；勿与账户总盈亏混淆 |
| `maxDrawdownPercent` / `maxDrawdownUsd` | `number \| null` | ALL×1Y 同源；不可测时比率可为 null |
| `mddWindowDays` | `number \| null` | 回撤实际覆盖天数（标签用） |
| `mddUnmeasurable` | `boolean` | 回撤比率不可测 |
| `closedSample` | `object \| null` | `{ rowCount, pageCount, capped, timedOut, windowDays, fetchOk }` |
| `returnPrincipalSource` | `string \| null` | 有值时为 `CLOSED_COST` |

列表接口会补齐旧榜行缺失的 `winMarketCount` / `lossMarketCount`（从 `scoreExplain.closedPositions` 回填）。

---

## 0. 总盈利率 / 平均盈利率（近 365 天已平仓）

样本：`closed-positions`，先按市场/事件（`conditionId`）汇总成本与盈亏，再计算。

### 总盈利率

- **详情页「资金与表现」：不展示**（只保留平均盈利率）
- 后端仍可能计算 `totalReturnRatio` / 列表 `externalTotalReturn`（排序/筛选用）；详情 KPI 网格不再渲染该行
- **公式**（若列表仍用）：`Σ 事件已实现盈亏 ÷ Σ 事件投入成本`
- **禁止**：不可用时静默改为 ÷成交量

### 平均盈利率

- **公式**：各事件 `盈亏/成本` 的简单平均（每事件一票，不论投入大小）
- **主值**：百分比；样本不足或无法计算时 `—`
- **入榜**：近窗样本足够且 `meanReturn < 35%`（可配 `SMART_MONEY_MIN_AVG_CLOSED_RETURN_RATE`）时打 `LOW_AVG_CLOSED_RETURN_RATE`，硬拦 CopyPool
- **参数说明**：
  > 近 365 天已平仓各市场收益率的简单平均（不论投入大小）。用于观察典型单笔水平。

---

## 1. 地址详情 · 资金与表现

### 已平仓盈亏（标签；字段 `totalPnl1y`）

- **主值**：格式化美元，如 `$295.9K`
- **参数说明**：
  > 近 365 天已平仓样本的已实现盈亏合计；不是账户总盈亏。若提示样本可能未采全，数值可能偏低。
- **与总盈亏**：总盈亏继续用账户曲线/主页；二者允许不相等。

### 已实现盈亏

- **优先**：closed 样本 `totalRealizedPnl` / `totalPnl1y`
- **回退**：主页 volumeSummary（仅无样本时）

### 盈亏比

- **主值**：有限数显示 `profitFactor`，如 `2.66`（保留 2 位小数）
- **`profitFactorNoLoss === true`**：显示 `∞`（此时 `profitFactor` 为 `null`）
- **两者皆空**：`—`
- **禁止**：回退曲线步进盈亏比；禁止 `2.66 (500 / 0)` 括号内嵌赢/亏次数
- **筛选**：`PF ≥ X OR 无亏损`；排序时无亏损优于任意有限 PF

### 盈亏次数（独立参数行）

- **标签**：盈亏次数
- **主值**：`{winMarketCount} / {lossMarketCount}`，如 `500 / 0`
- **参数说明**：
  > 近 365 天内已平仓市场中，盈利市场数 / 亏损市场数。与盈亏比分母分子对应的市场计数，不含未平仓仓位。

### 最大投入

- **主值**：格式化 `maxInvestedCostUsd`，如 `$226.8K`
- **副文案（换行）**：仅显示平仓盈亏，如 `(平仓盈亏 +$156.5K)`
  - 正数：`+$` + 缩写金额；负数：`-$` + 缩写金额
  - **禁止**在副文案后追加 ` · {maxInvestedTitle}` 或市场名称
- **参数说明**：
  > 近 365 天已平仓市场中，按投入成本（cost basis）取最高的一笔；副行仅为该笔市场的已实现盈亏，不含市场名称。

### 最大回撤 / 回撤率

- **主值**：`maxDrawdownUsd` / `maxDrawdownPercent`（同源 ALL×1Y）
- **副标**：`近1年` 或 `开户至今 · {mddWindowDays}天`
- **不可测**：比率 `—`（`mddUnmeasurable`）；勿用当前图表周期本地重算冒充
- **参数说明**：
  > 近 365 天账户权益曲线（ALL）上的最大峰谷回撤；与近 7 日盈亏无关。

### 收益稳定性（夏普）

- **主值**：`risk.sharpeLike` / `summary.externalSharpeRatio`（同源）
- **口径**：本地 ALL 累计 PnL 曲线截近 365 天（不足则开户至今）的简化夏普代理
- **禁止**：predicting.top / 第三方夏普；禁止用当前详情页 1W/1M 周期曲线冒充
- **参数说明**：
  > 近一年账户 PnL 曲线上的类夏普（步进收益均值 ÷ 波动 × 缩放）；越高通常表示单位波动下回报更好。

### 样本截断提示（可选）

当 `closedSample.capped === true`：

> 样本可能未覆盖完整一年

附在模块副标题后。

---

## 2. 排行榜列表 · 盈亏比列

- **单元格**：仅显示 `profitFactor`，如 `2.66`；无亏损显示 `∞`
- **禁止**：在列表列中显示赢/亏次数 `(500 / 0)`
- **列头说明（tooltip）**：
  > 已平仓市场盈亏比：盈利市场 PnL 总和 ÷ 亏损市场 PnL 绝对值之和（近 365 天）。列表不展示赢/亏市场次数，详见地址详情「盈亏次数」。

---

## 4. 列表 vs 详情档位（S / C）不一致

| 界面 | 正确字段 |
|------|----------|
| 排行榜列表 | `items[].tier` / `items[].traderScore`（**只信榜表**） |
| 地址详情（已入榜） | `summary.tier` / `summary.traderScore`（**只信榜表**）；Trader Score 卡与之对齐 |
| 地址详情（未入榜） | 才用 ScoreCache 合成 summary |

禁止只读 `scoreExplain.traderProfile.card.tier` 而不看 `summary.tier`。  
评分写入走 `upsertSmartMoneyScoreCache`（写 Cache，有榜行则 patch 榜表）；copyability 等派生写榜后会 `syncSmartMoneyScoreCacheDisplayFromLeaderboard` 双写。

列表「更新时间」应对齐 API 字段 **`lastScoredAt`**（榜表评分写入时间；未入榜详情才用 ScoreCache）。

勿与以下字段混淆：

| 字段 | 含义 |
|------|------|
| `syncedAt` | 榜行任意字段写入缓存的时间（含 rank 重排） |
| `sourceFetchedAt` | 主页/Profile 最近抓取时间 |
| `rankScoreComputedAt` | ML 排序分刷新时间 |

若 `lastScoredAt` 长期不变（如停在数日前），见运维诊断：`scripts/diagnose-top100-rescore.sql`（常见原因：CopyPool 冷却误配导致未复评）。

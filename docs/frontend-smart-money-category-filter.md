# Smart Money 排行榜分类筛选前端接入

本文档说明前端如何给「聪明钱 / 跟单排行榜」增加按概率事件类型分类的过滤器。

## 1. 接口变更

接口：

```http
GET /api/polymarket/smart-money/cached
```

新增 query 参数：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `category` | enum | 否 | 按官方 Polymarket 事件分类榜来源筛选聪明钱地址；不传表示全部 |

可选值：

```ts
type SmartMoneyCategory =
  | 'OVERALL'
  | 'POLITICS'
  | 'SPORTS'
  | 'ESPORTS'
  | 'CRYPTO'
  | 'CULTURE'
  | 'MENTIONS'
  | 'WEATHER'
  | 'ECONOMICS'
  | 'TECH'
  | 'FINANCE';
```

示例：

```http
GET /api/polymarket/smart-money/cached?limit=50&category=CRYPTO
```

仍可与现有参数组合：

```http
GET /api/polymarket/smart-money/cached?limit=50&rankBy=WEEK&category=SPORTS
```

## 2. 响应变更

顶层响应新增回显：

```ts
{
  category: SmartMoneyCategory | null
}
```

`items[]` 新增：

```ts
{
  candidateCategories: SmartMoneyCategory[]
}
```

含义：该 trader 出现在这些官方分类榜来源中。一个地址可能同时属于多个分类。

## 3. 推荐 UI

在排行榜时间筛选「全部时间 / 周榜 / 月榜」附近增加一个横向分类筛选。

推荐展示：

| value | 中文 |
|---|---|
| `undefined` | 全部 |
| `POLITICS` | 政治 |
| `SPORTS` | 体育 |
| `ESPORTS` | 电竞 |
| `CRYPTO` | 加密 |
| `CULTURE` | 文化 |
| `WEATHER` | 天气 |
| `ECONOMICS` | 经济 |
| `TECH` | 科技 |
| `FINANCE` | 金融 |
| `MENTIONS` | 热议 |

建议默认选「全部」，不要默认传 `OVERALL`。  
原因：不传 `category` 表示不限制分类；传 `OVERALL` 只看综合榜来源。

## 4. 前端状态建议

```ts
type SmartMoneyCategoryFilter =
  | undefined
  | 'POLITICS'
  | 'SPORTS'
  | 'ESPORTS'
  | 'CRYPTO'
  | 'CULTURE'
  | 'MENTIONS'
  | 'WEATHER'
  | 'ECONOMICS'
  | 'TECH'
  | 'FINANCE';

const [category, setCategory] = useState<SmartMoneyCategoryFilter>(undefined);
```

切换分类时建议：

- 清空当前列表
- `offset` 重置为 `0`
- 重新请求第一页
- 保留当前时间维度，例如 `rankBy=WEEK`

## 5. 请求拼接示例

```ts
const params = new URLSearchParams();

params.set('limit', String(limit));
params.set('offset', String(offset));

if (rankBy) {
  params.set('rankBy', rankBy);
}

if (category) {
  params.set('category', category);
}

const res = await fetch(`/api/polymarket/smart-money/cached?${params.toString()}`, {
  headers: {
    'x-api-key': apiKey,
  },
});
```

## 6. 空状态

分类筛选可能短时间返回空列表，常见原因：

- 后端刚上线迁移，分类字段还没被 smart-money candidate pipeline 回填
- 官方分类榜同步还没跑完
- 某些分类本身 trader 数量较少

建议空状态文案：

```text
暂无该分类的聪明钱
```

不要把空状态当作错误提示。

## 7. 注意事项

- `category` 是筛选条件，不影响原有评分公式。
- 分类来源基于官方分类榜，不是 trader 历史所有交易的市场分类统计。
- 一个 trader 可能属于多个分类，前端可以选择展示主筛选结果，不必在卡片上强制显示所有分类。
- 若用户切换分类后仍点击「跟单」，跟单逻辑不需要额外传分类参数。


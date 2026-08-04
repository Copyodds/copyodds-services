# EOA 充值归集 — 运营 Runbook

用户从交易所（币安等）提现 USDC 到 **custodial EOA**（前端展示的充值地址）。Node 检测到入账后自动归集：

| EOA 到账代币 | 自动归集目标 | 后续 |
|-------------|-------------|------|
| **USDC.e** | Polymarket **deposit wallet** | 自动 Onramp wrap → **pUSD** |
| **原生 USDC** | Polymarket **Bridge evm 地址** | 官方桥接 → **pUSD** 进 deposit |
| **USDT**（Wormhole） | Polymarket **Bridge evm 地址** | 官方桥接 → **pUSD** 进 deposit |
| **USDT0**（PoS） | Polymarket **Bridge evm 地址** | 官方桥接 → **pUSD** 进 deposit |

用户只需记住 **一个充值地址（EOA）**；不要引导用户直充 deposit 或手动操作 Bridge。

## 流程概览

1. 用户向 custodial EOA 转入 Polygon USDC.e / 原生 USDC / USDT / USDT0
2. Go `chain_monitor` 回调 Node → 写入 `CHAIN_DEPOSIT` 流水
3. `AUTO_FORWARD_EOA_DEPOSIT=true` 时自动执行 EOA 归集（默认 permit+relayer 代付 POL）
4. USDC.e 路径：funder 到账后自动 wrap；原生 USDC / USDT / USDT0 路径：Bridge 处理

## 相关 API

- `GET /api/custody/eoa-deposit-status` — EOA 余额与归集任务状态
- `GET /api/custody/polymarket-bridge/deposit-status` — Bridge 入金进度（原生 USDC 归集后查询）
- `GET /api/custody/polymarket-deposit-usdc-balance` — deposit 上 pUSD / USDC.e 余额

## Gas / 失败处理

默认路径：平台 **relayer** 代付 POL（`EOA_FORWARD_RELAYER_PRIVATE_KEY`），用户 EOA **无需 MATIC**。

USDT0（PoS）与 USDC.e 一样走 **Polygon legacy EIP-712**（`salt=chainId`、`version=1`）；若出现 `USDT0: INVALID-PERMIT`，确认 backend 已包含该 domain 修复后再重试 forward。

若未配 relayer 且 EOA 自付 gas 失败：

- `CustodyEoaForwardJob.status` = `PENDING_GAS` 或 `FAILED`
- **无 Node 轮询重试**；需运营修复后手动触发 pipeline，或依赖 Go 再次回调同一入账

### 运营操作

1. 查库：`SELECT * FROM "CustodyEoaForwardJob" WHERE status IN ('PENDING_GAS','FAILED') ORDER BY "updatedAt" DESC;`
2. 或 API：`GET /api/custody/eoa-deposit-status`（用户 JWT）查看 `forwardStatus` / `forwardError`
3. 确认 relayer 有 POL、私钥配置正确；必要时在服务器执行 `runCustodialEoaDepositPipeline(userId)` 手动重试
4. 原生 USDC 已归集到 Bridge 但 pUSD 未到账：查 `GET /api/custody/polymarket-bridge/deposit-status`
5. USDC.e 路径确认 funder 余额：`GET /api/custody/polymarket-deposit-usdc-balance`

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `AUTO_FORWARD_EOA_DEPOSIT` | true | 入账后自动 EOA 归集 |
| `POLYMARKET_BRIDGE_DEPOSIT_ENABLED` | true | 启用 Bridge API |
| `POLYMARKET_BRIDGE_EOA_NATIVE_FORWARD` | true | EOA 原生 USDC → Bridge evm |
| `GO_EOA_DEPOSIT_CALLBACK_ENABLED` | 开 | Go 实时回调（唯一入账检测路径） |
| `EOA_FORWARD_RELAYER_PRIVATE_KEY` | — | 配则 relayer 代付 gas |

## 告警建议

- `PENDING_GAS` 行数 > 0 持续超过 15 分钟
- `CustodyEoaForwardJob` status=`FAILED` 且 `lastError` 非 gas 相关
- Bridge `deposit-status` 长时间 `FAILED` 或 `PROCESSING`

## 向后兼容

老用户仍可向 **funder 合约地址**直充 USDC.e（不推荐展示）；原生 USDC 请充 **EOA** 或走 Bridge，直充 deposit 不会自动处理。

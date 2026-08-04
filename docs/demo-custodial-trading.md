# Demo：托管执行钱包（去私钥导入）

## 资金线（必读）— 单一 Deposit Wallet

| 资金 | 用途 | 如何增加 |
|------|------|----------|
| **USDC.e（Polygon）在 Polymarket deposit 地址** | CLOB 买单/卖单抵押与保证金（POLY_1271 funder） | 用户向 **Wallets 页展示的 deposit 地址** 转链上 USDC.e；**不要**把交易保证金误充到内部操作地址 |
| **链上 USDC（内部操作地址）** | 可选：链上提现起点、历史兼容；**不是**默认交易保证金 | 一般无需充值；提现自 deposit 经 relayer 划回后会出现在此地址 |

内部 **owner / 操作地址**（Go 远程签名）仅用于服务端签名与 relayer 批次，**不在 UI 作为主充值目标**。

**GET /api/custody/wallet-ledger**（无 `cursor`）仍可按需同步内部操作地址的 USDC 转入；定时扫块可写 `CustodyChainDeposit`。

## 环境变量

- `TRADING_EXECUTION_MODE`（默认 `demo_custodial`）：显式标记当前仅使用服务端 **CUSTODIAL**（GO_REMOTE）作为 CLOB / 链上执行 owner。
- `GO_WALLET_SERVICE_URL` / `GO_WALLET_APP_KEY` / `GO_WALLET_APP_TOKEN`（**必填**）：托管钱包仅支持 **GO_REMOTE**。未配置则无法 `POST /api/custody/open`。见 [go-wallet-thin.md](./go-wallet-thin.md)。
- `CUSTODY_TREASURY_ADDRESS`：**国库链上仅收款**（与 `PRIVATE_KEY` 地址必须不同）。`PRIVATE_KEY`：**运营热钱包**，仅用于向托管地址 **补给 MATIC** 等；**不在** Node 配置国库私钥。见 [go-wallet-thin.md](./go-wallet-thin.md) 末节。
- `POLYMARKET_RELAYER_URL` + `POLYMARKET_BUILDER_API_KEY` / `SECRET` / `PASSPHRASE`（**推荐同配**）：开通托管并绑定 Polymarket 成功后，服务端会 **deployDepositWallet** 并在 deposit 上执行 **USDC approve + CTF setApprovalForAll** 批次（链上幂等）；缺省时仅完成地址推导与 CLOB 凭证，用户仍可充值 deposit，但 relayer 批次与「划回内部地址」不可用。
- `AUTO_FUND_POLYMARKET_DEPOSIT`（默认 **`false`**）：为 `true` 时买单前可按缺口从内部操作地址自动划 USDC.e 至 deposit；单一入金模式下降为 **false**，用户应 **直接向 deposit 充值**。
- `POLY_DEPOSIT_AUTO_FUND_BUFFER_RAW`：自动补款时的缓冲（仅当 `AUTO_FUND_POLYMARKET_DEPOSIT=true` 时相关）。
- `CUSTODY_WALLET_LEDGER_SYNC_*`、`CUSTODY_PAYMENT_WEBHOOK_SECRET`：见下文 API 说明。EOA/funder 入账检测由 Go `chain_monitor` 回调负责。
- **`CUSTODY_TREASURY_ADDRESS`**（不由 Go 助记词派生）：Gas 商城 **Polymarket deposit 购套餐**在单笔 relayer 批次内把 USDC.e 从买家 **deposit** 划给 **已配置 Polymarket 入金地址的上级** 与 **国库**；上级若未配置 `polymarketFunderAddress`，该级分佣金额**并入国库**同一笔链上收款，且**不**创建对应 `MallOrderCommission` / 上级链上佣金流水。已配置上级的链上佣金在履约时写入 `MallOrderCommission.claimedAt` 与 `UserWalletLedger`。**托管钱包整笔付国库**（`purchase-with-custody`）仍为「进国库后待领取」旧语义。

## 破坏性变更

- **LOCAL_DB** 托管已移除；仅 **GO_REMOTE**。
- 已移除用户 **私钥** 导入接口（部分返回 **410 Gone**）。
- `GET /api/auth/wallets` 仅返回 **`CUSTODIAL`**（需先 `POST /api/custody/open`）。
- **自动化会话 / SMART_WALLET**：`/api/auth/wallets/session/*` 路由已删除；执行钱包统一为 custodial + deposit（POLY_1271）。
- 仅存在历史 `USER_EOA`、从未开通 `CUSTODIAL` 的用户需 **`POST /api/custody/open`** 后才能下单。

## API 摘要（充值相关）

- `POST /api/custody/open`：创建/确认托管钱包、绑定 Polymarket CLOB、写入 `polymarketFunderAddress`；若配置了 Builder+Relayer，则尝试 **relayer 部署 + 预授权**（失败时返回体中可有 `relayerProvisionError`，可重试开通或下单时再次触发授权逻辑）。
- `GET /api/custody/polymarket-deposit-usdc-balance`：deposit 上 USDC.e 余额。
- `GET /api/custody/withdraw-polymarket-deposit-preview`：Polymarket deposit 提现预览（链上余额、CLOB 抵押、**最大可提 min(链上,CLOB 有效侧)**、`blockers`：未配置 relayer、**任意未成交单**、托管/deposit 地址在 Data API 上**非零持仓**、本系统 **PENDING / RELAYER_SUBMITTED** 提现等）。若 CLOB 上报抵押为 0 但链上 deposit 有余额、且无挂单/无持仓，则 **CLOB 侧按链上余额回退**参与 min（`checks.clobCollateralFallbackToChain`），避免入金尚未同步到 L2 时误显示可提 0。
- `POST /api/custody/withdraw-polymarket-deposit-v2`：body `{ "to": "0x…", "amount"?: "可选小数", "idempotencyKey"?: "…" }`；`to` 为 Polygon 收款地址（**禁止**等于 deposit、`0x0`）；`amount` 省略则在通过风控后以可提上限**提满**；幂等键与 `UserWalletLedger` 去重；成功记账类别 `POLYMARKET_DEPOSIT_EXTERNAL`。
- `GET /api/custody/on-chain-balance`：内部操作地址链上 USDC（非默认交易保证金）。
- `GET /api/custody/deposits`：检测到的转入内部操作地址的 USDC（扫块）。
- `GET /api/custody/wallet-ledger`：统一流水；无 `cursor` 时可按需 RPC 同步。
- `POST /api/custody/withdraw-polymarket-deposit`：relayer 将 deposit 内 USDC.e **划回内部操作地址**（历史路径；需 Builder+Relayer）。

## 前端

- **Wallets** 页：`CustodyWalletPanel` 以 **deposit 地址 + QR** 为主；内部操作地址余额为次要信息。

## 验收步骤

1. 配置 Go wallet-api 与 `POST /api/custody/open`（或注册后异步开通），确认 `polymarket.polymarketFunderAddress` 非空。
2. （推荐）配置 `POLYMARKET_BUILDER_*` + `POLYMARKET_RELAYER_URL`，确认开通无 `relayerProvisionError`，或下单路径可完成授权。
3. 向 **deposit 地址** 在 Polygon 充值 **USDC.e**；面板「Deposit wallet USDC」与 `GET /api/custody/polymarket-deposit-usdc-balance` 一致。
4. `POST /api/trade/user/orders` 使用 POLY_1271，保证金以 deposit 为准。

## Go wallet 薄服务（可选自检）

- HMAC：`npm run verify:go-wallet-hmac`
- `SMOKE_GO_WALLET=1 npm run smoke:go-wallet`（Windows：`$env:SMOKE_GO_WALLET='1'; npm run smoke:go-wallet`）

# Go wallet 薄服务 + Node 全业务

## 职责划分

| 组件 | 职责 |
|------|------|
| **wallet-api** (`wallet/cmd/wallet`) | `POST /createWallet`；`POST /sign/*`；`POST /treasury/payout-usdce`。若 **`[signer] embedded=true`**（推荐本地）：进程内签名，**无需**单独起 wallet-signer。若 `embedded=false`：将 `/sign/*` 与国库打款 HTTP 转发到 wallet-signer。 |
| **wallet-signer** (`wallet/cmd/wallet-signer`) | 可选独立进程；仅在 `embedded=false` 时使用，负责 ECDSA 签名与国库 USDC.e 打款。 |
| **polymarket-backend** | 充值扫块/Webhook、托管提现、Gas/档位购买（全额打国库）、佣金领取（调国库打款）、CLOB；`GO_REMOTE` 时通过 `goWalletClient` 调 wallet-api |

## HTTP 契约（Node → wallet-api）

- **Base URL**：`GO_WALLET_SERVICE_URL`（无尾部 `/`）
- **鉴权**：请求头 `x-key` = Go 配置 `general.appkey`（或 `appKey`，代码已兼容）
- **HMAC**（当 Go `security.hmac_enabled=true`）：与 [`goWalletHmac.ts`](../src/services/walletApi/goWalletHmac.ts) 一致  
  `X-Timestamp`（秒）、`X-Nonce`（UUID）、`X-Sign` = `HMAC-SHA256(appToken, "METHOD\npath\n{ts}\n{nonce}\n{sha256hex(body)}")`  
  校验脚本：`npx tsx scripts/verify-go-wallet-hmac.ts`

### 路由与 Body

| 方法 | 路径 | Body（JSON） |
|------|------|----------------|
| POST | `/createWallet` | `{ "refer_code": string, "wallet_password": string }`；响应可含 `derivation_credential`（Node 忽略，不落库） |
| POST | `/sign/message` | `{ "refer_code": string, "walletIndex": number, "wallet_password": string, "message": string }` |
| POST | `/sign/typed-data` | `{ "refer_code": string, "walletIndex": number, "wallet_password": string, "typedData": object, "withdrawalAuthorization"?: { "token": string, "idempotencyKey": string } }`。无 withdrawalAuthorization 时，Batch 内 USDC.e transfer 收款地址必须在 Go `security.platform_usdce_transfer_recipients`（通常仅国库）。 |
| POST | `/treasury/payout-usdce` | `{ "to": "0x...", "amount": "<USDC.e base units>" }`；从 `mnemonicWithdraw` 热钱包转 Polygon USDC.e。派生地址须等于 Go `security.treasury_address`（= Node `CUSTODY_TREASURY_ADDRESS`）。 |
| POST | `/withdrawal-authorizations/status` | `{ "refer_code": string, "walletIndex": number }`；当前 Go 返回 `totpEnabled` |
| POST | `/withdrawal-authorizations/setup` | 身份字段 + `{ "accountLabel": string, "issuer": string }`；当前 Go 返回 `manualEntryKey`、`otpauthUrl`、`expiresIn` |
| POST | `/withdrawal-authorizations/confirm`、`/disable` | 身份字段 + `{ "code": string }` |
| POST | `/withdrawal-authorizations/verify` | 身份字段 + exact intent；返回 opaque `token` |

成功时 signer 返回 JSON；`sign/message` 与 `sign/typed-data` 在错误时可能带 `code`/`msg`（与 ethers 侧一致）。

用户 TOTP 种子只由 wallet-api 保存；Node 不保存/解密种子，也不为 TOTP 签发 step-up JWT。提现
authorization 必须绑定上述完整意图，并且只能传给该次 `RelayClient` 的 signer。wallet-api 不可用、
TOTP 未启用、authorization 缺失/过期/与 typed-data 不匹配时均拒绝提现。

Node 在开户时生成 `wallet_password`，**明文**写入 `WalletDerivationCredential.cipher`（按 `referCode`/邀请码主键）。
每次 `/sign/*` 回传 `wallet_password`；Go 用 `DeriveBIP39Passphrase(referCode, wallet_password, GenPassword)` 临时派生私钥。
`NODE_WALLET_DERIVATION_ENCRYPTION_KEY` 仅用于 Node 侧确定性 bootstrap 密码（`generateWalletPassword`），不再做 AEAD。

已有 `aes-256-gcm.*` 旧行需跑：`npm run migrate:wallet-derivation-credentials`（用 legacy/bootstrap 密码回写明文）。

**EOA→funder 代付 POL（permit relayer）**：仍由 Node 配置 `EOA_FORWARD_RELAYER_PRIVATE_KEY` 本地签名，不走 Go wallet。

**EOA 原始交易直签已禁用**：wallet-api 不注册 `/sign/transaction`，wallet-signer 不注册 `/v1/sign-transaction`。需要链上提交的 DepositWallet 操作统一使用 typed-data + Builder Relayer；EOA 转发必须使用 permit relayer。

## HTTP 契约（Go chain_monitor → Node）

Go 监测 Polymarket **funder（deposit）地址** USDC 入账后回调 Node；Node 写流水并调度 **native USDC → USDC.e → pUSD wrap**（逻辑在 Node，Go 不做 relayer 批次）。

另：**custodial EOA**（用户交易所提现目标）入账后回调 Node，写 `CHAIN_DEPOSIT` 并调度 **EOA → funder 自动划转**（`AUTO_FORWARD_EOA_DEPOSIT`），再由 Node wrap。

- **鉴权**：`X-Internal-Secret` = Node `COPY_INTERNAL_SECRET`
- **开关**：Node `GO_FUNDER_DEPOSIT_CALLBACK_ENABLED`（默认 true）、`GO_EOA_DEPOSIT_CALLBACK_ENABLED`（默认 true）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/internal/custody/funder-watch-list` | 拉取需监测的 funder 列表（含 `userId`、`funderAddress`、`custodialAddress`、`walletIndex`） |
| POST | `/api/internal/custody/funder-deposit-detected` | funder 入账通知；Body 见 [`custodyFunderMonitor.ts`](../src/routes/internal/custodyFunderMonitor.ts) |
| GET | `/api/internal/custody/eoa-watch-list` | 拉取需监测的 custodial EOA 列表（字段同 funder 列表） |
| POST | `/api/internal/custody/eoa-deposit-detected` | EOA 入账通知；Body 与 funder 相同，`custodialAddress` 为 Transfer 的 `to` |

`POST funder-deposit-detected` 示例：

```json
{
  "userId": 123,
  "funderAddress": "0x...",
  "custodialAddress": "0x...",
  "txHash": "0x...",
  "logIndex": 42,
  "blockNumber": 61234567,
  "fromAddress": "0x...",
  "amountRaw": "1000000",
  "tokenAddress": "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  "usdcVariant": "usdce",
  "source": "go_chain_monitor"
}
```

- `tokenAddress`：USDC.e `0x2791…`、native USDC `0x3c499c…`，或 EOA 路径下的 USDT `0x9417669…` / USDT0 `0xc2132D05…`
- `usdcVariant`：`usdce` | `native` | `usdt` | `usdt0`（可选；须与 `tokenAddress` 一致）
- `source`：固定 `go_chain_monitor`（可选）

### 行为

- 成功：`201` 新建流水 / `200` 幂等或 skipped
- funder 入账：Go `chain_monitor` 回调 `funder-deposit-detected` → Node 写流水并调度 wrap（仅 USDC.e / native USDC）
- EOA 入账：Go 监测 `Transfer(to=custodialAddress)` → 回调 `eoa-deposit-detected` → Node 自动归集（USDC.e→deposit→wrap；原生 USDC/USDT/USDT0→Bridge→pUSD；默认 relayer 代付 POL，见 [`eoa-deposit-ops-runbook.md`](./eoa-deposit-ops-runbook.md)）

Go 侧建议配置（`cfg.wallet.toml` 扩展示例）：

```toml
[chain_monitor]
enabled = true
watch_list_url = "http://127.0.0.1:3000/api/internal/custody/funder-watch-list"
node_callback_url = "http://127.0.0.1:3000/api/internal/custody/funder-deposit-detected"
eoa_watch_list_url = "http://127.0.0.1:3000/api/internal/custody/eoa-watch-list"
eoa_node_callback_url = "http://127.0.0.1:3000/api/internal/custody/eoa-deposit-detected"
watch_list_poll_interval_sec = 60
```

Go `chain_monitor` 需同时 poll funder 与 EOA 列表：funder 扫 USDC.e / native USDC；EOA 另扫 USDT / USDT0；分别回调对应 URL（实现见 wallet 仓库 `chain_monitor` 包）。

## 薄部署配置（`wallet/config/cfg.wallet.toml`）

- `general.enable_chain_monitor=false`：不启动 Polygon/Arb/BSC 扫块与自动归集
- `general.enable_legacy_routes=false`：不注册 `/polygon/withdraws`、`/collect` 等旧业务路由
- **`[signer] embedded=true`**：单进程；`signer.url` 可留空
- `embedded=false` 时：`[signer].url` 必须指向 wallet-signer（如 `http://127.0.0.1:9643`）
- `general.appkey` / `general.apptoken`：与 Node 侧一致；**生产**由 systemd credential 注入（`/etc/polymarket/credentials/go_wallet_app_key`、`/etc/polymarket/credentials/go_wallet_app_token`），见 [`deploy/systemd/README.md`](../deploy/systemd/README.md)，勿写入 backend `.env`

## 本地启动提示（Windows）

**单进程（`embedded=true`）**：只需 wallet-api；**必须**设置 `GEN_PASSWORD`、`WALLET_PASSWORD_USER`（与加密 `mnemonicUser` 时一致）。未设置时旧版仅在 `/sign` 上报 `invalid mnemonic`（解密失败得到空串）；现已在启动时做解密自检并 `Fatal` 给出明确原因。**`WALLET_PASSWORD_GAS` 可不设**（只做 Polymarket 签名时足够；若仍配置 `mnemonicGas` 且要做归集补 gas，再提供该口令）。

```powershell
cd wallet
$env:GEN_PASSWORD='...'; $env:WALLET_PASSWORD_USER='...'
go run .\cmd\wallet\main.go -conf .\config\cfg.wallet.toml
```

**双进程（`embedded=false`）**：先起 wallet-signer，再起 wallet-api；避免多个 signer 抢占 `127.0.0.1:9643`。

## 可选联调

```bash
SMOKE_GO_WALLET=1 npx tsx scripts/smoke-go-wallet-e2e.ts
```

需已配置 `.env` 中 `GO_WALLET_*` 且两端服务已启动。

## 存量 LOCAL_DB → GO_REMOTE

见 [`scripts/migrate-custodial-to-go.ts`](../scripts/migrate-custodial-to-go.ts) 头部说明；迁移后用户需重新 `POST /api/custody/authorize-polymarket`。

## 国库 USDC.e / POL

- Node `CUSTODY_TREASURY_ADDRESS` **必须**等于 Go `security.treasury_address`，且等于 `mnemonicWithdraw` + `WALLET_PASSWORD_WITHDRAW` 派生地址。
- Gas/档位购买：用户 DepositWallet 全额 USDC.e 打入国库（Go 白名单 `platform_usdce_transfer_recipients`）；分佣只写 `MallOrderCommission`（`claimedAt=null`）。
- 佣金领取：Node `POST /api/.../gas/claim-commissions` → Go `POST /treasury/payout-usdce`，从国库打到用户 Polymarket DepositWallet。
- 国库需保留有限 USDC.e + POL 作 gas；运营定期 sweep。私钥只在 Go wallet（`mnemonicWithdraw`），**不在** Node。
- 托管地址 MATIC 不足时，Node 仍可用运营热钱包 `PRIVATE_KEY`（地址须**不等于**国库）经 `sendNative` 补给用户，与佣金打款路径无关。

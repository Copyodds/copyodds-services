// 变量由 `src/server.ts` 顶部的 dotenv、或 `node --env-file=.env`、或部署环境注入。

import { SsrfBlockedError, validateOutboundServiceUrl } from '../utils/ssrfGuard';
const REQUIRED_VARS = ['RPC_URL'];

for (const key of REQUIRED_VARS) {
  if (!process.env[key]) {
    console.warn(`[env] Warning: ${key} is not set in .env`);
  }
}

if (!process.env.JWT_SECRET) {
  console.warn('[env] Warning: JWT_SECRET is not set in .env (required for auth)');
}

function getEmailProvider(): 'resend' | 'gmail_smtp' {
  const raw = (process.env.EMAIL_PROVIDER ?? 'resend').trim().toLowerCase();
  if (raw === 'gmail_smtp' || raw === 'smtp' || raw === 'gmail') {
    return 'gmail_smtp';
  }
  return 'resend';
}

const _emailProviderEarly = getEmailProvider();
if (_emailProviderEarly === 'resend' && !process.env.RESEND_API_KEY) {
  console.warn('[env] Warning: RESEND_API_KEY is not set (EMAIL_PROVIDER=resend)');
}
if (_emailProviderEarly === 'gmail_smtp' && (!process.env.SMTP_USER || !process.env.SMTP_PASS)) {
  console.warn('[env] Warning: SMTP_USER / SMTP_PASS required for EMAIL_PROVIDER=gmail_smtp');
}

if (!process.env.CUSTODY_ENCRYPT_KEY || process.env.CUSTODY_ENCRYPT_KEY.length < 32) {
  console.warn('[env] Warning: CUSTODY_ENCRYPT_KEY is not set or too short (required for secure custody)');
}

function isProd() {
  return (process.env.NODE_ENV ?? '').toLowerCase() === 'production';
}

if (isProd()) {
  const prodRequired = ['DATABASE_URL', 'JWT_SECRET', 'API_KEY', 'CUSTODY_ENCRYPT_KEY'] as const;
  for (const key of prodRequired) {
    const v = process.env[key];
    if (!v || (key === 'CUSTODY_ENCRYPT_KEY' && v.length < 32)) {
      console.error(`[env] Missing required env var in production: ${key}`);
      process.exit(1);
    }
  }
}

/** Polymarket CLOB signature type: 0=EOA, 1=POLY_PROXY, 2=GNOSIS_SAFE, 3=POLY_1271 (deposit wallet, 新 API 用户推荐) */
export const POLY_SIGNATURE_TYPES = { EOA: 0, POLY_PROXY: 1, GNOSIS_SAFE: 2, POLY_1271: 3 } as const;

function getCopyFailStreakMode(): 'off' | 'soft' | 'hard' {
  const raw = (process.env.COPY_FAIL_STREAK_MODE ?? 'soft').trim().toLowerCase();
  if (raw === 'off' || raw === 'hard') {
    return raw;
  }
  return 'soft';
}

function getCopyBuyMinNotionalBufferRatio(): number {
  const raw = Number(process.env.COPY_BUY_MIN_NOTIONAL_BUFFER_RATIO ?? 0.01);
  if (!Number.isFinite(raw)) {
    return 0.01;
  }
  return Math.max(0, Math.min(0.2, raw));
}

function getCopyBuyMaxAmountToleranceRatio(): number {
  const raw = Number(process.env.COPY_BUY_MAX_AMOUNT_TOLERANCE_RATIO ?? 0.05);
  if (!Number.isFinite(raw)) {
    return 0.05;
  }
  return Math.max(0, Math.min(0.5, raw));
}

function getCopyDefaultSlippage(): number {
  const raw = Number(process.env.COPY_DEFAULT_SLIPPAGE ?? 0.05);
  if (!Number.isFinite(raw)) {
    return 0.05;
  }
  // Hard cap: avoid nonsensical 100% "slippage" configs.
  return Math.max(0.0001, Math.min(0.5, raw));
}

function getTradingSystemMode(): 'NORMAL' | 'TRACK_ONLY' | 'PAUSED' {
  const raw = (process.env.TRADING_SYSTEM_MODE ?? 'NORMAL').trim().toUpperCase();
  if (raw === 'TRACK_ONLY' || raw === 'PAUSED') {
    return raw;
  }
  return 'NORMAL';
}

/** demo 阶段固定为服务端 CUSTODIAL；便于部署时显式区分旧版 USER_EOA 导入逻辑 */
function getTradingExecutionMode(): string {
  return (process.env.TRADING_EXECUTION_MODE ?? 'demo_custodial').trim().toLowerCase();
}

/** 聪明钱榜单上榜人数上限（可通过 SMART_MONEY_TOP_LIMIT 覆盖，默认 2500，最大 10000） */
const SMART_MONEY_TOP_LIMIT_MAX = 10_000;

function getSmartMoneyTopLimit(): number {
  const raw = Number(process.env.SMART_MONEY_TOP_LIMIT ?? 2500);
  return Math.max(1, Math.min(SMART_MONEY_TOP_LIMIT_MAX, raw));
}

const smartMoneyTopLimit = getSmartMoneyTopLimit();
export const SMART_MONEY_TOP_LIMIT = smartMoneyTopLimit;

function getSmartMoneyBootstrapTargetCount(): number {
  const raw = Number(process.env.SMART_MONEY_BOOTSTRAP_TARGET_COUNT ?? smartMoneyTopLimit);
  return Math.max(1, Math.min(smartMoneyTopLimit, raw));
}

function getSmartMoneyBootstrapFetchBatchSize(): number {
  const fallback = Math.max(100, Number(process.env.SMART_MONEY_FETCH_BATCH_SIZE ?? 100));
  const raw = Number(process.env.SMART_MONEY_BOOTSTRAP_FETCH_BATCH_SIZE ?? fallback);
  return Math.max(1, raw);
}

function getSmartMoneyBootstrapFetchConcurrency(): number {
  const fallback = Math.max(10, Number(process.env.SMART_MONEY_FETCH_CONCURRENCY ?? 12));
  const raw = Number(process.env.SMART_MONEY_BOOTSTRAP_FETCH_CONCURRENCY ?? fallback);
  return Math.max(1, raw);
}

function getSmartMoneyBootstrapBatchesPerRun(): number {
  const raw = Number(process.env.SMART_MONEY_BOOTSTRAP_BATCHES_PER_RUN ?? 1);
  return Math.max(1, Math.min(8, raw));
}

function getSmartMoneyBootstrapRefillPressureThreshold(): number {
  const raw = Number(process.env.SMART_MONEY_BOOTSTRAP_REFILL_PRESSURE_THRESHOLD ?? 200);
  return Math.max(0, raw);
}

function getSmartMoneyBlockScanFetchPrioritySlots(): number {
  const raw = Number(process.env.SMART_MONEY_BLOCK_SCAN_FETCH_PRIORITY_SLOTS ?? 5);
  return Math.max(0, raw);
}

function getSmartMoneyFollowUpFetchBatchSize(): number {
  const fallback = Math.max(10, Math.min(30, Number(process.env.SMART_MONEY_FETCH_BATCH_SIZE ?? 100)));
  const raw = Number(process.env.SMART_MONEY_FOLLOW_UP_FETCH_BATCH_SIZE ?? fallback);
  return Math.max(1, raw);
}

/** 官方榜同步完成后顺带抓取的聪明钱主页数量：写入 portfolio-pnl 盈亏曲线，默认与「每批抓取上限」一致 */
function getSmartMoneyLeaderboardSyncFetchLimit(): number {
  const batchDefault = Math.max(1, Number(process.env.SMART_MONEY_FETCH_BATCH_SIZE ?? 50));
  const raw = Number(process.env.SMART_MONEY_LEADERBOARD_SYNC_FETCH_LIMIT ?? batchDefault);
  return Math.max(1, raw);
}

function getSmartMoneyTopStaleMs(): number {
  const raw = Number(process.env.SMART_MONEY_TOP_STALE_MS ?? 6 * 60 * 60 * 1000);
  return Math.max(60_000, raw);
}

const DEFAULT_LEADERBOARD_SYNC_PRESETS: ReadonlyArray<{
  category: string;
  timePeriod: string;
  orderBy: string;
}> = [
  'OVERALL',
  'POLITICS',
  'SPORTS',
  'ESPORTS',
  'CRYPTO',
  'CULTURE',
  'MENTIONS',
  'WEATHER',
  'ECONOMICS',
  'TECH',
  'FINANCE',
].flatMap((category) => [
  { category, timePeriod: 'WEEK', orderBy: 'PNL' },
  { category, timePeriod: 'MONTH', orderBy: 'PNL' },
  { category, timePeriod: 'ALL', orderBy: 'PNL' },
]);

function parseLeaderboardSyncPresets(): { category: string; timePeriod: string; orderBy: string }[] {
  const raw = (process.env.LEADERBOARD_SYNC_PRESETS ?? '').trim();
  if (!raw) {
    return [...DEFAULT_LEADERBOARD_SYNC_PRESETS];
  }
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) {
      console.warn('[env] LEADERBOARD_SYNC_PRESETS must be a JSON array, using defaults');
      return [...DEFAULT_LEADERBOARD_SYNC_PRESETS];
    }
    const out: { category: string; timePeriod: string; orderBy: string }[] = [];
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      const category = typeof o.category === 'string' ? o.category : '';
      const timePeriod = typeof o.timePeriod === 'string' ? o.timePeriod : '';
      const orderBy = typeof o.orderBy === 'string' ? o.orderBy : '';
      if (category && timePeriod && orderBy) {
        out.push({ category, timePeriod, orderBy });
      }
    }
    if (out.length === 0) {
      console.warn('[env] LEADERBOARD_SYNC_PRESETS empty after parse, using defaults');
      return [...DEFAULT_LEADERBOARD_SYNC_PRESETS];
    }
    const legacyCategories = [
      'OVERALL',
      'POLITICS',
      'SPORTS',
      'CRYPTO',
      'CULTURE',
      'MENTIONS',
      'WEATHER',
      'ECONOMICS',
      'TECH',
      'FINANCE',
    ];
    const periods = ['WEEK', 'MONTH', 'ALL'];
    const hasPreset = (category: string, timePeriod: string) =>
      out.some(
        (preset) =>
          preset.category === category &&
          preset.timePeriod === timePeriod &&
          preset.orderBy === 'PNL'
      );
    const hasLegacyFullSet = legacyCategories.every((category) =>
      periods.every((period) => hasPreset(category, period))
    );
    const hasEsports = periods.every((period) => hasPreset('ESPORTS', period));
    if (hasLegacyFullSet && !hasEsports) {
      console.warn(
        '[env] LEADERBOARD_SYNC_PRESETS is the legacy full category set; appending ESPORTS presets'
      );
      out.push(
        ...periods
          .filter((timePeriod) => !hasPreset('ESPORTS', timePeriod))
          .map((timePeriod) => ({
            category: 'ESPORTS',
            timePeriod,
            orderBy: 'PNL',
          }))
      );
    } else if (!hasEsports) {
      console.warn(
        '[env] LEADERBOARD_SYNC_PRESETS does not include ESPORTS for WEEK/MONTH/ALL; esports leaderboard data will not sync'
      );
    }
    return out;
  } catch {
    console.warn('[env] LEADERBOARD_SYNC_PRESETS JSON parse failed, using defaults');
    return [...DEFAULT_LEADERBOARD_SYNC_PRESETS];
  }
}

function getSmartMoneyMinCurvePointCount(): number {
  const raw = Number(process.env.SMART_MONEY_MIN_CURVE_POINT_COUNT ?? 20);
  return Math.max(2, raw);
}

function getStringListEnv(key: string): string[] {
  return (process.env[key] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function getWalletListEnv(key: string): string[] {
  return getStringListEnv(key)
    .map((s) => s.toLowerCase())
    .filter((s) => /^0x[a-f0-9]{40}$/.test(s));
}

function getBooleanEnv(key: string, defaultValue: boolean): boolean {
  const raw = process.env[key];
  if (raw == null) {
    return defaultValue;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return defaultValue;
}

/** user-pnl-api `fidelity`，与官网默认 1h 对齐 */
function getPolymarketUserPnlFidelity(): '1h' | '3h' | '12h' | '1d' {
  const raw = (process.env.POLYMARKET_USER_PNL_FIDELITY ?? '1h').trim().toLowerCase();
  if (raw === '3h' || raw === '12h' || raw === '1d') {
    return raw;
  }
  return '1h';
}

function getTrustProxyEnv(): boolean | number | string {
  const raw = process.env.TRUST_PROXY?.trim();
  if (!raw) {
    return isProd();
  }
  const normalized = raw.toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  if (/^\d+$/.test(raw)) {
    return Number(raw);
  }
  return raw;
}

/** 平台钱包下单时从该 User 的 gasBalance 扣费；未配置则拒绝 POST /api/trade/orders */
function getPlatformGasUserId(): number | null {
  const raw = process.env.PLATFORM_GAS_USER_ID?.trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

export type PolymarketBuilderBackupCredentialConfig = {
  label?: string;
  key: string;
  secret: string;
  passphrase: string;
};

function parsePolymarketBuilderBackupCredentials(raw: string | undefined): PolymarketBuilderBackupCredentialConfig[] {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      console.warn('[env] POLYMARKET_BUILDER_BACKUP_CREDENTIALS must be a JSON array');
      return [];
    }
    const out: PolymarketBuilderBackupCredentialConfig[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const row = parsed[i];
      if (!row || typeof row !== 'object') continue;
      const key = String((row as { key?: unknown }).key ?? '').trim();
      const secret = String((row as { secret?: unknown }).secret ?? '').trim();
      const passphrase = String((row as { passphrase?: unknown }).passphrase ?? '').trim();
      if (!key || !secret || !passphrase) {
        console.warn('[env] POLYMARKET_BUILDER_BACKUP_CREDENTIALS entry missing key/secret/passphrase', { index: i });
        continue;
      }
      const labelRaw = (row as { label?: unknown }).label;
      out.push({
        label: typeof labelRaw === 'string' ? labelRaw.trim() : undefined,
        key,
        secret,
        passphrase,
      });
    }
    return out;
  } catch (e) {
    console.warn('[env] POLYMARKET_BUILDER_BACKUP_CREDENTIALS invalid JSON', e);
    return [];
  }
}

export const CONFIG = {
  port: Number(process.env.PORT ?? 3000),
  rpcUrl: process.env.RPC_URL ?? '',
  /** viem `http()` 单次请求超时（毫秒）；过小易导致 Alchemy 等节点偶发 “request took too long” */
  rpcHttpTimeoutMs: Math.max(5_000, Number(process.env.RPC_HTTP_TIMEOUT_MS ?? 60_000)),
  /** 逗号分隔的备用 Polygon HTTP RPC；与 RPC_URL 组合为 viem `fallback`，主节点超时或失败时依次尝试 */
  rpcFallbackUrls: (
    process.env.RPC_FALLBACK_URLS?.trim()
      ? process.env.RPC_FALLBACK_URLS
      : 'https://polygon-rpc.com'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /**
   * 为 true（默认）时在 RPC_URL / RPC_FALLBACK_URLS 之后追加一组公共 Polygon HTTP 节点。
   * 公共节点如 polygon-rpc.com 常出现 503；多节点 fallback 可显著提高读链成功率。
   * 若须严格只用自有/付费节点，设 RPC_BUILTIN_PUBLIC_FALLBACKS=false。
   */
  rpcBuiltinPublicFallbacks: process.env.RPC_BUILTIN_PUBLIC_FALLBACKS !== 'false',
  chainId: 137,
  jwtSecret: process.env.JWT_SECRET ?? '',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  // Polymarket CLOB (optional: omit POLY_* to derive at runtime and cache)
  clobHost: 'https://clob.polymarket.com',
  /** CTF Exchange（标准市场 USDC 支出方）；须与 Polymarket 文档一致：https://docs.polymarket.com/resources/contract-addresses */
  clobSpender: process.env.CLOB_SPENDER ?? '0xE111180000d2663C0091e4f400237545B87B996B',
  /** Neg Risk CTF Exchange（neg-risk 市场抵押支出方） */
  clobSpenderNegRisk: process.env.CLOB_SPENDER_NEG_RISK ?? '0xe2222d279d744050d28e00520010520000310F59',
  negRiskAdapterAddress:
    process.env.NEG_RISK_ADAPTER_ADDRESS ?? '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
  /** 标准市场 pUSD split/merge/redeem 适配器（V2 deposit wallet 勿直连 CTF） */
  ctfCollateralAdapterAddress:
    process.env.CTF_COLLATERAL_ADAPTER_ADDRESS ?? '0xAdA100Db00Ca00073811820692005400218FcE1f',
  /** Neg Risk pUSD 赎回适配器（redeem 应调此合约，非直连 CTF） */
  negRiskCtfCollateralAdapterAddress:
    process.env.NEG_RISK_CTF_COLLATERAL_ADAPTER_ADDRESS ??
    '0xadA2005600Dec949baf300f4C6120000bDB6eAab',
  polySignatureType: (() => {
    const raw = Number(process.env.POLY_SIGNATURE_TYPE ?? 0);
    const t = Number.isFinite(raw) ? Math.min(3, Math.max(0, Math.floor(raw))) : 0;
    return t as 0 | 1 | 2 | 3;
  })(),
  /** 平台 CLOB 单：POLY_SIGNATURE_TYPE=3 时必填，为 Polymarket deposit 合约地址 */
  polyPlatformFunderAddress: (process.env.POLY_PLATFORM_FUNDER_ADDRESS ?? '').trim(),
  polyApiKey: process.env.POLY_API_KEY ?? '',
  polySecret: process.env.POLY_SECRET ?? '',
  polyPassphrase: process.env.POLY_PASSPHRASE ?? '',
  /**
   * 为 true 时打印 `[clob-user-trace]`：托管 CLOB 授权与下单链路的分步字段（缓存键、funder、链上 USDC、CLOB 读数等）。
   * 排查：`POLY_CLOB_DEBUG_USER_TRACE=true` 或 `CLOB_DEBUG_USER_TRACE=true`；完成后务必关掉。
   */
  clobDebugUserTrace:
    getBooleanEnv('POLY_CLOB_DEBUG_USER_TRACE', false) || getBooleanEnv('CLOB_DEBUG_USER_TRACE', false),
  /** Polymarket relayer（deposit WALLET batch）；默认主网 v2 */
  polymarketRelayerUrl: (process.env.POLYMARKET_RELAYER_URL?.trim() || 'https://relayer-v2.polymarket.com').replace(
    /\/+$/,
    ''
  ),
  /** Builder API（与 relayer HMAC 一致）；与 POLYMARKET_RELAYER_URL 同时配置才启用「deposit → 托管」划回 */
  polymarketBuilderApiKey: (process.env.POLYMARKET_BUILDER_API_KEY ?? '').trim(),
  polymarketBuilderSecret: (process.env.POLYMARKET_BUILDER_SECRET ?? '').trim(),
  polymarketBuilderPassphrase: (process.env.POLYMARKET_BUILDER_PASSPHRASE ?? '').trim(),
  /** 备选 Builder 凭证 JSON 数组（方案 A）；主 key 配额用尽时 failover */
  polymarketBuilderBackupCredentials: parsePolymarketBuilderBackupCredentials(
    process.env.POLYMARKET_BUILDER_BACKUP_CREDENTIALS
  ),
  /** 用于 POST /api/auth/admin/affiliate/tier 等需预共享密钥的内部接口 */
  adminKey: process.env.ADMIN_KEY ?? '',
  /** Admin 会话 Cookie 名（与 polymarket-admin-api 一致，供 /api/admin/dashboard 鉴权） */
  adminSessionCookieName: (process.env.ADMIN_SESSION_COOKIE_NAME ?? 'admin_session').trim(),
  /** 后台 Dashboard 定时统计 */
  adminDashboardCronEnabled: getBooleanEnv('ADMIN_DASHBOARD_CRON_ENABLED', true),
  adminDashboardRuntimeIntervalMs: Math.max(
    30_000,
    Number(process.env.ADMIN_DASHBOARD_RUNTIME_INTERVAL_MS ?? 60_000)
  ),
  adminDashboardStatsIntervalMs: Math.max(
    60_000,
    Number(process.env.ADMIN_DASHBOARD_STATS_INTERVAL_MS ?? 300_000)
  ),
  /** 部署版本号（Dashboard sync.version） */
  backendVersion: (process.env.BACKEND_VERSION ?? process.env.npm_package_version ?? 'dev').trim(),
  trustProxy: getTrustProxyEnv(),
  corsAllowedOrigins: getStringListEnv('CORS_ALLOWED_ORIGINS'),
  custodyEncryptKey: process.env.CUSTODY_ENCRYPT_KEY ?? '',
  /** Go wallet-api 基址（如 http://127.0.0.1:9528）；与 GO_WALLET_APP_KEY / GO_WALLET_APP_TOKEN 同时配置则新开托管走 Go 派生地址+远程签名 */
  goWalletServiceUrl: (process.env.GO_WALLET_SERVICE_URL ?? '').trim().replace(/\/+$/, ''),
  /** 对应 Go 配置 general.appKey，请求头 x-key */
  goWalletAppKey: (process.env.GO_WALLET_APP_KEY ?? '').trim(),
  /** 对应 Go 配置 general.appToken，用于 HMAC（与 security.hmac_enabled 配合） */
  goWalletAppToken: (process.env.GO_WALLET_APP_TOKEN ?? '').trim(),
  /** Node 独立保存 Go derivation_credential 的 AES-256-GCM 密钥（32-byte hex/base64） */
  nodeWalletDerivationEncryptionKey: (
    process.env.NODE_WALLET_DERIVATION_ENCRYPTION_KEY ?? ''
  ).trim(),
  /**
   * 将 WalletDerivationCredential 同步到腾讯云 COS（与表字段一致的 JSON，异步、无日志）。
   * 需同时配置 COS_*；CAM 建议仅 PutObject。
   */
  walletPasswordCosBackupEnabled: getBooleanEnv('WALLET_PASSWORD_COS_BACKUP_ENABLED', false),
  cosSecretId: (process.env.COS_SECRET_ID ?? '').trim(),
  cosSecretKey: (process.env.COS_SECRET_KEY ?? '').trim(),
  cosBucket: (process.env.COS_BUCKET ?? '').trim(),
  cosRegion: (process.env.COS_REGION ?? '').trim(),
  cosWalletPasswordPrefix: (process.env.COS_WALLET_PASSWORD_PREFIX ?? 'wallet-password').trim(),
  /** 托管钱包 / Gas 商城收款国库 Polygon 地址。国库仅收款，Node 不配置国库或运营私钥。 */
  custodyTreasuryAddress: (process.env.CUSTODY_TREASURY_ADDRESS ?? '').trim(),
  /** Go wallet chain_monitor 回调：custodial EOA 入账通知 Node 写流水并调度 EOA→funder；默认开启 */
  goEoaDepositCallbackEnabled: process.env.GO_EOA_DEPOSIT_CALLBACK_ENABLED !== 'false',
  /**
   * EOA 入账后自动将 USDC 划转到 Polymarket funder 并触发 wrap。
   * 默认用 permit+relayer（EOA 无需 POL）；未配 relayer 时回退为 EOA 自付 gas（PENDING_GAS，需运营手动处理）。
   */
  autoForwardEoaDeposit: getBooleanEnv('AUTO_FORWARD_EOA_DEPOSIT', true),
  /** 自动归集：平台 relayer 代付 POL（EIP-2612 permit）；配 EOA_FORWARD_RELAYER_PRIVATE_KEY 即启用 */
  eoaForwardRelayerPrivateKey: (process.env.EOA_FORWARD_RELAYER_PRIVATE_KEY ?? '').trim(),
  /** 解密 v2: 私钥；未设时回退 WALLET_PASSWORD_GAS */
  eoaForwardRelayerPassword: (
    process.env.EOA_FORWARD_RELAYER_PASSWORD ??
    process.env.WALLET_PASSWORD_GAS ??
    ''
  ).trim(),
  /** Go wallet chain_monitor 回调：funder 入账通知 Node 写流水并调度 wrap；默认开启 */
  goFunderDepositCallbackEnabled: process.env.GO_FUNDER_DEPOSIT_CALLBACK_ENABLED !== 'false',
  /** GET /wallet-ledger 首页按需 RPC 同步：向前追溯区块数（单用户单地址） */
  custodyWalletLedgerSyncLookbackBlocks: Math.max(
    500,
    Number(process.env.CUSTODY_WALLET_LEDGER_SYNC_LOOKBACK_BLOCKS ?? 4000),
  ),
  /** 同一用户两次按需同步最小间隔（毫秒） */
  custodyWalletLedgerSyncMinIntervalMs: Math.max(
    5_000,
    Number(process.env.CUSTODY_WALLET_LEDGER_SYNC_MIN_INTERVAL_MS ?? 20_000),
  ),
  /** GET /api/custody/on-chain-balance 短 TTL 缓存，降低重复 RPC 读链 */
  custodyOnChainBalanceCacheTtlMs: Math.max(
    0,
    Number(process.env.CUSTODY_ONCHAIN_BALANCE_CACHE_TTL_MS ?? 15_000),
  ),
  /** POST /api/webhooks/custody-ledger-topup 校验 */
  custodyPaymentWebhookSecret: (process.env.CUSTODY_PAYMENT_WEBHOOK_SECRET ?? '').trim(),
  sessionKeyDefaultDurationHours: Math.max(1, Number(process.env.SESSION_KEY_DEFAULT_DURATION_HOURS ?? 24 * 30)),
  sessionKeyDefaultMaxOrderUsd: Math.max(1, Number(process.env.SESSION_KEY_DEFAULT_MAX_ORDER_USD ?? 100)),
  sessionKeyDefaultDailyCapUsd: Math.max(1, Number(process.env.SESSION_KEY_DEFAULT_DAILY_CAP_USD ?? 500)),
  /** 是否启用已结束仓位自动 CTF redeem 定时任务（GET /positions 不再同步赎回） */
  redeemCronEnabled: getBooleanEnv('REDEEM_CRON_ENABLED', true),
  /** 自动 redeem 扫描间隔（毫秒），默认 15 分钟 */
  redeemIntervalMs: Number(process.env.REDEEM_INTERVAL_MS ?? 900000),
  /** 每轮最多 claim 的 due 用户数 */
  redeemSweepBatchSize: Math.max(
    1,
    Math.min(500, Number(process.env.REDEEM_SWEEP_BATCH_SIZE ?? 100))
  ),
  /** 自动赎回用户级并发（拉仓 / redeem / 对账），默认 5 */
  redeemSweepUserConcurrency: Math.max(
    1,
    Math.min(20, Number(process.env.REDEEM_SWEEP_USER_CONCURRENCY ?? 5))
  ),
  /** redeem 链上对账（从 GET 接口移出后的后台批次） */
  redeemReconcileIntervalMs: Number(process.env.REDEEM_RECONCILE_INTERVAL_MS ?? 600_000),

  /** 排行榜定时同步：官方 Data API + predicting.top + Polymarket Analytics */
  leaderboardCronEnabled: getBooleanEnv('LEADERBOARD_CRON_ENABLED', true),
  /** 同步周期间隔（毫秒），默认 1 小时（管道优化：降频减上游压力） */
  leaderboardIntervalMs: Math.max(60_000, Number(process.env.LEADERBOARD_INTERVAL_MS ?? 3_600_000)),
  /** 每次请求前最小间隔（毫秒），降低突发 QPS */
  leaderboardRequestGapMs: Math.max(0, Number(process.env.LEADERBOARD_REQUEST_GAP_MS ?? 200)),
  /** 官方榜同步预设（分类 × 周期 × PNL） */
  leaderboardSyncPresets: parseLeaderboardSyncPresets(),
  /**
   * 官方榜 1k 滑动窗口拉取（默认开启）：每轮 cron 每个 preset 只拉一个窗口并 merge 入库。
   * 设为 false 回退到「每轮尽量全量 + 整批替换」旧路径（应急回滚开关）。
   */
  leaderboardWindowFetchEnabled: getBooleanEnv('LEADERBOARD_WINDOW_FETCH', true),
  /** 每轮每个 preset 拉取的窗口大小（行数），默认 1000 */
  leaderboardWindowSize: Math.max(100, Number(process.env.LEADERBOARD_WINDOW_SIZE ?? 1000)),
  /** 官方榜 offset 硬顶（实测 API 约 10050 之后拉不到数据），可配以适应 API 变化 */
  leaderboardHardMaxOffset: Math.max(
    1000,
    Number(process.env.LEADERBOARD_HARD_MAX_OFFSET ?? 10_050)
  ),
  /** merge 写入后僵尸行保留时长：超过该时长未被任何窗口刷新的 rank 行被清理（默认 6 小时） */
  leaderboardStaleRowRetentionMs: Math.max(
    30 * 60_000,
    Number(process.env.LEADERBOARD_STALE_ROW_RETENTION_MS ?? 6 * 60 * 60 * 1000)
  ),
  /** 官方榜同步成功后触发 smart-money candidate follow-up 的最小间隔（窗口化后每 5min 都会成功，需限频；默认 1 小时） */
  leaderboardCandidateFollowUpMinIntervalMs: Math.max(
    0,
    Number(process.env.LEADERBOARD_CANDIDATE_FOLLOWUP_MIN_INTERVAL_MS ?? 60 * 60 * 1000)
  ),
  /** Polymarket Analytics / Falcon API Key（https://api.polymarketanalytics.com） */
  polymarketAnalyticsApiKey: (process.env.POLYMARKET_ANALYTICS_API_KEY ?? '').trim(),

  /** 聪明钱：候选同步 + 主页抓取 + 单用户评分 */
  smartMoneyCronEnabled: getBooleanEnv('SMART_MONEY_CRON_ENABLED', true),
  /**
   * API 进程是否注册 smart-money cron。
   * 独立 smart-money-worker 部署时，API 设 SMART_MONEY_CRONS_IN_API=false，避免双跑。
   */
  smartMoneyCronsInApi: getBooleanEnv('SMART_MONEY_CRONS_IN_API', true),
  /** 候选池同步间隔（毫秒），默认 6 小时 */
  smartMoneyCandidateIntervalMs: Math.max(
    300_000,
    Number(process.env.SMART_MONEY_CANDIDATE_INTERVAL_MS ?? 21_600_000)
  ),
  /**
   * 启动后首次候选同步延迟（毫秒）。
   * 禁止在 listen 瞬间跑全量 sync：会与 Light/Deep 抢 DB/事件循环，并在 15min timeout 后残留孤儿任务。
   */
  smartMoneyCandidateFirstDelayMs: Math.max(
    60_000,
    Number(process.env.SMART_MONEY_CANDIDATE_FIRST_DELAY_MS ?? 300_000)
  ),
  /** 是否在 listen 后立即再踢一次 candidate-sync（默认 false；首次改走 firstDelay） */
  smartMoneyCandidateSyncOnStart: getBooleanEnv('SMART_MONEY_CANDIDATE_SYNC_ON_START', false),
  /** 单次 candidate-sync 超时（毫秒）；超时后 AbortSignal 取消批处理，避免孤儿占库 */
  smartMoneyCandidateSyncTimeoutMs: Math.max(
    60_000,
    Number(process.env.SMART_MONEY_CANDIDATE_SYNC_TIMEOUT_MS ?? 10 * 60_000)
  ),
  /**
   * 发现进货：每轮最多向 RAW 写入的新地址数（水位模型线 A）。
   * 默认 1000；与 RAW 空位取 min。
   */
  smartMoneyDiscoveryIngestPerRun: Math.max(
    0,
    Number(process.env.SMART_MONEY_DISCOVERY_INGEST_PER_RUN ?? 1000)
  ),
  /**
   * 发现进货水位（0–1）：activeRaw >= floor(RAW_MAX * watermark) 时本轮不进货。
   * 默认 0.9 → 5 万上限下 targetCap=4.5 万，留出缓冲给消化环。
   */
  smartMoneyDiscoveryRawWatermark: Math.min(
    1,
    Math.max(0, Number(process.env.SMART_MONEY_DISCOVERY_RAW_WATERMARK ?? 0.9))
  ),
  /**
   * 元数据刷新：每轮最多 upsert 的「已在管道/已上榜」钱包数（线 B）。
   * 默认 1500；单条短写，禁止全量镜像。
   */
  smartMoneyCandidateMetadataRefreshMax: Math.max(
    0,
    Number(process.env.SMART_MONEY_CANDIDATE_METADATA_REFRESH_MAX ?? 1500)
  ),
  /**
   * 遗留开关：true 时回退「全量 ObservedTrader upsert」（2C2G 不推荐）。
   * 默认 false，走水位进货 + 活跃元数据刷新。
   */
  smartMoneyCandidateFullUpsert: getBooleanEnv('SMART_MONEY_CANDIDATE_FULL_UPSERT', false),
  /** 主页抓取与评分批任务间隔（毫秒），默认 3 分钟 */
  smartMoneyFetchIntervalMs: Math.max(
    60_000,
    Number(process.env.SMART_MONEY_FETCH_INTERVAL_MS ?? 180_000)
  ),
  /** 每批最多抓取多少个候选地址 */
  smartMoneyFetchBatchSize: Math.max(1, Number(process.env.SMART_MONEY_FETCH_BATCH_SIZE ?? 100)),
  /** 抓取并发上限 */
  smartMoneyFetchConcurrency: Math.max(1, Number(process.env.SMART_MONEY_FETCH_CONCURRENCY ?? 12)),
  /** Gate/Deep 等 heavy 车道请求间隔（毫秒） */
  smartMoneyRequestGapMs: Math.max(0, Number(process.env.SMART_MONEY_REQUEST_GAP_MS ?? 600)),
  /**
   * Light Profile 快筛独立间隔（毫秒）；与 heavy 分车道，互不排队。
   * 默认 300；设 0 关闭 Light 侧 gap（仅建议短时压测）。
   */
  smartMoneyLightRequestGapMs: Math.max(
    0,
    Number(process.env.SMART_MONEY_LIGHT_REQUEST_GAP_MS ?? 300)
  ),
  /** 单次主页抓取超时（毫秒） */
  smartMoneyProfileTimeoutMs: Math.max(1_000, Number(process.env.SMART_MONEY_PROFILE_TIMEOUT_MS ?? 15_000)),
  /** 单个主页抓取的重试次数 */
  smartMoneyProfileRetryMax: Math.max(1, Number(process.env.SMART_MONEY_PROFILE_RETRY_MAX ?? 3)),
  /** 单个主页抓取的基础退避间隔（毫秒） */
  smartMoneyProfileRetryBaseDelayMs: Math.max(
    250,
    Number(process.env.SMART_MONEY_PROFILE_RETRY_BASE_DELAY_MS ?? 1_500)
  ),
  /**
   * 主页 HTML 常只脱水单周期 portfolio-pnl；对缺失的 1D/1W/1M/ALL 调用官网同源 user-pnl-api 补点。
   * 关闭可避免对 user-pnl-api.polymarket.com 的额外请求。
   */
  polymarketUserPnlApiEnabled: getBooleanEnv('POLYMARKET_USER_PNL_API_ENABLED', true),
  polymarketUserPnlFidelity: getPolymarketUserPnlFidelity(),
  /** 抓取失败后的基础冷却时间（毫秒），会按失败次数指数退避 */
  smartMoneyFetchFailureBaseCooldownMs: Math.max(
    60_000,
    Number(process.env.SMART_MONEY_FETCH_FAILURE_BASE_COOLDOWN_MS ?? 300_000)
  ),
  /**
   * @deprecated 发现层已取消 TopN；请用 smartMoneyDiscoveryMaxRowsPerPreset。
   * 保留字段仅为兼容旧脚本读 CONFIG。
   */
  smartMoneyCandidateLimit: Math.max(1, Number(process.env.SMART_MONEY_CANDIDATE_LIMIT ?? 100_000)),
  /** 最终榜只保留最近仍然新鲜的评分结果 */
  smartMoneyScoreFreshnessMs: Math.max(
    60_000,
    Number(process.env.SMART_MONEY_SCORE_FRESHNESS_MS ?? 7 * 24 * 60 * 60 * 1000)
  ),
  /** 每个钱包保留最近多少次主页快照 */
  smartMoneySnapshotRetentionPerWallet: Math.max(
    1,
    Number(process.env.SMART_MONEY_SNAPSHOT_RETENTION_PER_WALLET ?? 10)
  ),
  /** 外部榜每个周期保留最近多少个同步版本 */
  smartMoneyExternalRetentionVersions: Math.max(
    1,
    Number(process.env.SMART_MONEY_EXTERNAL_RETENTION_VERSIONS ?? 5)
  ),
  /** 是否保存外部榜完整原始 JSON，关闭可显著减少存储体积 */
  smartMoneyExternalStoreRawPayload: getBooleanEnv('SMART_MONEY_EXTERNAL_STORE_RAW_PAYLOAD', false),
  /** 最终榜单最多输出多少行（默认 2000，最大 10000） */
  smartMoneyTopLimit: smartMoneyTopLimit,
  /** bootstrap 模式下希望尽快补齐多少个可展示地址 */
  smartMoneyBootstrapTargetCount: getSmartMoneyBootstrapTargetCount(),
  /** bootstrap 模式下每批最多抓取多少个地址 */
  smartMoneyBootstrapFetchBatchSize: getSmartMoneyBootstrapFetchBatchSize(),
  /** bootstrap 模式下并发上限 */
  smartMoneyBootstrapFetchConcurrency: getSmartMoneyBootstrapFetchConcurrency(),
  /** bootstrap / 补榜压力下每轮 cron 连跑批次数（默认 3） */
  smartMoneyBootstrapBatchesPerRun: getSmartMoneyBootstrapBatchesPerRun(),
  /** 距目标展示人数还差超过该值时，稳态模式也启用补榜优先队列与多批连跑 */
  smartMoneyBootstrapRefillPressureThreshold: getSmartMoneyBootstrapRefillPressureThreshold(),
  /** 每批抓取队列预留给扫块发现地址的槽位数（补榜期建议压低） */
  smartMoneyBlockScanFetchPrioritySlots: getSmartMoneyBlockScanFetchPrioritySlots(),
  /** 扫块晋级门槛：窗口内成交笔数（默认 5；放宽发现面可降到 1–2，需配合 RAW_POOL_MAX_ACTIVE） */
  smartMoneyBlockScanMinFills: Math.max(
    1,
    Number(process.env.SMART_MONEY_BLOCK_SCAN_MIN_FILLS ?? 5)
  ),
  /** 扫块晋级门槛：单笔名义金额 USD（默认 500；放宽发现面可降到 100） */
  smartMoneyBlockScanMinNotionalUsd: Math.max(
    0,
    Number(process.env.SMART_MONEY_BLOCK_SCAN_MIN_NOTIONAL_USD ?? 500)
  ),
  /** 扫块单轮入库地址上限：超出按名义金额排序取 TopN，不拒收 */
  smartMoneyBlockScanIngestMax: Math.max(
    1,
    Number(process.env.SMART_MONEY_BLOCK_SCAN_INGEST_MAX ?? 500)
  ),
  /** 官方榜 follow-up 触发时只补抓高优先级地址 */
  smartMoneyFollowUpFetchBatchSize: getSmartMoneyFollowUpFetchBatchSize(),
  /** LEADERBOARD 同步完成后，聪明钱 pipeline 中「补抓主页/盈亏曲线」的条数上限（默认等于每批抓取上限） */
  smartMoneyLeaderboardSyncFetchLimit: getSmartMoneyLeaderboardSyncFetchLimit(),
  /** 前榜单地址若超过该时间未刷新，则在常规模式下优先补抓 */
  smartMoneyTopStaleMs: getSmartMoneyTopStaleMs(),
  /** 评分版本号，用于调参后区分新旧分数 */
  smartMoneyScoreVersion: process.env.SMART_MONEY_SCORE_VERSION?.trim() || 'v4.1',
  /** Phase 0：activity 内不再使用官方榜排名加分 */
  smartMoneyRemoveOfficialCandidateBoost: getBooleanEnv('SMART_MONEY_REMOVE_OFFICIAL_CANDIDATE_BOOST', true),
  /** Phase 0：v2.3 流动性/已平市场等旗标参与 eligible */
  smartMoneyEnforceV23Gates: getBooleanEnv('SMART_MONEY_ENFORCE_V23_GATES', true),
  /** 超过该时长未抓取的候选地址进入 starvation 保底队列（默认 72h） */
  smartMoneyStarvationMs: Math.max(
    3_600_000,
    Number(process.env.SMART_MONEY_STARVATION_MS ?? 72 * 60 * 60 * 1000)
  ),
  /** starvation 每批预留比例（0–1） */
  smartMoneyStarvationBatchShare: Math.max(
    0,
    Math.min(1, Number(process.env.SMART_MONEY_STARVATION_BATCH_SHARE ?? 0.2))
  ),
  /**
   * 官方榜每个 preset 入库上限（发现层全量分页；默认 100000，不再用 candidateLimit 截断）。
   * @deprecated SMART_MONEY_CANDIDATE_LIMIT 仅作本字段回退
   */
  smartMoneyDiscoveryMaxRowsPerPreset: Math.max(
    1_000,
    Number(
      process.env.SMART_MONEY_DISCOVERY_MAX_ROWS_PER_PRESET ??
        process.env.SMART_MONEY_CANDIDATE_LIMIT ??
        100_000
    )
  ),
  /** 原始池活跃上限；默认 1000（拉式补池）。设 0 表示不限制（不推荐） */
  smartMoneyRawPoolMaxActive: Math.max(
    0,
    Number(process.env.SMART_MONEY_RAW_POOL_MAX_ACTIVE ?? 1_000)
  ),
  /** 拉式补池：activeRaw 低于该值时触发补到 target */
  smartMoneyRawRefillLow: Math.max(
    0,
    Number(process.env.SMART_MONEY_RAW_REFILL_LOW ?? 250)
  ),
  /** 拉式补池目标活跃数（通常等于 RAW_POOL_MAX_ACTIVE） */
  smartMoneyRawRefillTarget: Math.max(
    0,
    Number(process.env.SMART_MONEY_RAW_REFILL_TARGET ?? 1_000)
  ),
  /** 补池中榜源占比（其余给 BlockScan）；0–1 */
  smartMoneyRawRefillBoardShare: Math.max(
    0,
    Math.min(1, Number(process.env.SMART_MONEY_RAW_REFILL_BOARD_SHARE ?? 0.7))
  ),
  /** 同一地址进 RAW 的冷却天数（去重） */
  smartMoneyRawIngestCooldownDays: Math.max(
    0,
    Number(process.env.SMART_MONEY_RAW_INGEST_COOLDOWN_DAYS ?? 3)
  ),
  /** 官方/强源唤醒：新进 Top N 可打破冷却/淘汰 */
  smartMoneyDiscoveryReviveTopN: Math.max(
    1,
    Number(process.env.SMART_MONEY_DISCOVERY_REVIVE_TOP_N ?? 50)
  ),
  /** 强唤醒：名次上升 ≥ K（官方榜） */
  smartMoneyDiscoveryRankJumpMin: Math.max(
    1,
    Number(process.env.SMART_MONEY_DISCOVERY_RANK_JUMP_MIN ?? 20)
  ),
  /** 连续 shortfall 达到该次数后加大游标步长 */
  smartMoneyRawRefillShortfallBoostAfter: Math.max(
    1,
    Number(process.env.SMART_MONEY_RAW_REFILL_SHORTFALL_BOOST_AFTER ?? 3)
  ),
  /** shortfall 加大后的游标步长倍数（相对默认 step） */
  smartMoneyRawRefillShortfallStepMul: Math.max(
    1,
    Number(process.env.SMART_MONEY_RAW_REFILL_SHORTFALL_STEP_MUL ?? 2)
  ),
  /** 补池读缓存：榜缓存超过该时长视为 stale，可触发一次官方 sync */
  smartMoneyRawRefillCacheStaleMs: Math.max(
    60_000,
    Number(process.env.SMART_MONEY_RAW_REFILL_CACHE_STALE_MS ?? 3_600_000)
  ),
  /** 拉式补池调度间隔（毫秒），默认 2 分钟 */
  smartMoneyRawRefillIntervalMs: Math.max(
    30_000,
    Number(process.env.SMART_MONEY_RAW_REFILL_INTERVAL_MS ?? 120_000)
  ),
  smartMoneyRawRefillCronEnabled: getBooleanEnv('SMART_MONEY_RAW_REFILL_CRON_ENABLED', true),
  smartMoneyDeepAnalyzeQueueMax: Math.max(
    100,
    Number(process.env.SMART_MONEY_DEEP_ANALYZE_QUEUE_MAX ?? 5_000)
  ),
  /** Deep 常态复评份额；batch=12、默认 0.17 → 2 个 CopyPool 槽 */
  smartMoneyCopyPoolRefreshBatchShare: Math.max(
    0,
    Math.min(0.5, Number(process.env.SMART_MONEY_COPY_POOL_REFRESH_BATCH_SHARE ?? 0.17))
  ),
  /** Deep QUALIFIED 地板；batch=12、默认 0.58 → TopN 欠债时仍保留 7 个槽 */
  smartMoneyDeepMinQualifiedBatchShare: Math.max(
    0.5,
    Math.min(1, Number(process.env.SMART_MONEY_DEEP_MIN_QUALIFIED_BATCH_SHARE ?? 0.58))
  ),
  /** 到期 SCORED 每批保底槽；默认 1，避免 QUALIFIED 长期充足时饿死 */
  smartMoneyScoredBatchReservedSlots: Math.max(
    0,
    Number(process.env.SMART_MONEY_SCORED_BATCH_RESERVED_SLOTS ?? 1)
  ),
  /** Phase F：Light 仅 HTML、先判后写（Deep 首次 live 补全曲线） */
  smartMoneyLightHtmlOnly: getBooleanEnv('SMART_MONEY_LIGHT_HTML_ONLY', true),
  /** HTML 曲线点数落在 [minCurve-borderlineGap, minCurve) 时再调 pnl-api 防误杀 */
  smartMoneyLightBorderlineCurveGap: Math.max(
    1,
    Number(process.env.SMART_MONEY_LIGHT_BORDERLINE_CURVE_GAP ?? 5)
  ),
  /** 强信号源 Light 插队槽位/批 */
  smartMoneyLightPriorityBatchSlots: Math.max(
    0,
    Number(process.env.SMART_MONEY_LIGHT_PRIORITY_BATCH_SLOTS ?? 4)
  ),
  /** QUALIFIED 首次 Deep 强制 live 抓 Profile（Phase H 默认 false，复用 Light 快照） */
  smartMoneyDeepForceLiveOnFirstQualified: getBooleanEnv(
    'SMART_MONEY_DEEP_FORCE_LIVE_ON_FIRST_QUALIFIED',
    false
  ),
  /** QUALIFIED 活跃硬顶；0=不限制（F4 默认关闭硬顶，禁止 FULL_HOLD 回 RAW） */
  smartMoneyQualifiedMaxActive: Math.max(
    0,
    Number(process.env.SMART_MONEY_QUALIFIED_MAX_ACTIVE ?? 0)
  ),
  /** QUALIFIED 满时 HOLD 回 RAW 冷却（已废弃回 RAW；保留 env 兼容） */
  smartMoneyQualifiedFullHoldMs: Math.max(
    60_000,
    Number(process.env.SMART_MONEY_QUALIFIED_FULL_HOLD_MS ?? 6 * 60 * 60 * 1000)
  ),
  /**
   * Light 通过后是否落 Profile 快照。
   * 默认 false：减 Light 写库压力；Deep 无快照时 live 拉取并落库。
   */
  smartMoneyLightPersistSnapshot: getBooleanEnv('SMART_MONEY_LIGHT_PERSIST_SNAPSHOT', false),
  /** Phase H Bootstrap：前期优先清扫榜存量 */
  smartMoneyDiscoveryBootstrapBoard: getBooleanEnv('SMART_MONEY_DISCOVERY_BOOTSTRAP_BOARD', true),
  /** 榜源每轮保留 ingest 槽（watermark 暂停时仍可用） */
  smartMoneyLeaderboardIngestReservedSlots: Math.max(
    0,
    Number(process.env.SMART_MONEY_LEADERBOARD_INGEST_RESERVED_SLOTS ?? 300)
  ),
  /** 榜 backlog 每轮 bump Light 上限 */
  smartMoneyBoardBacklogBumpMax: Math.max(
    0,
    Number(process.env.SMART_MONEY_BOARD_BACKLOG_BUMP_MAX ?? 1000)
  ),
  /** RAW 分源活跃上限：榜源（0=不限制） */
  smartMoneyRawBoardActiveCap: Math.max(
    0,
    Number(process.env.SMART_MONEY_RAW_BOARD_ACTIVE_CAP ?? 15_000)
  ),
  /** RAW 分源活跃上限：扫块（0=不限制） */
  smartMoneyRawBlockscanActiveCap: Math.max(
    0,
    Number(process.env.SMART_MONEY_RAW_BLOCKSCAN_ACTIVE_CAP ?? 5_000)
  ),
  /** L0-DB 零 HTTP 预筛 */
  smartMoneyL0DbEnabled: getBooleanEnv('SMART_MONEY_L0_DB_ENABLED', true),
  /** 稳态下 L0-DB 掉榜淘汰（DB-3） */
  smartMoneyL0DbDroppedBoardEnabled: getBooleanEnv('SMART_MONEY_L0_DB_DROPPED_BOARD_ENABLED', true),
  /** L0-DB 背压延后天数（DB-4） */
  smartMoneyL0DbBackpressureDelayDays: Math.max(
    1,
    Number(process.env.SMART_MONEY_L0_DB_BACKPRESSURE_DELAY_DAYS ?? 7)
  ),
  /** 弱信号 RAW 永久 dormant 天数（H-R1，无榜源） */
  smartMoneyRawWeakDormantDays: Math.max(
    0,
    Number(process.env.SMART_MONEY_RAW_WEAK_DORMANT_DAYS ?? 30)
  ),
  /** Bootstrap 快车道榜源占比（0–1） */
  smartMoneyLightBootstrapBoardShare: Math.max(
    0,
    Math.min(1, Number(process.env.SMART_MONEY_LIGHT_BOOTSTRAP_BOARD_SHARE ?? 0.8))
  ),
  /** 扫块窗口累计成交额门槛 USD（0=仅笔数 OR 单笔） */
  smartMoneyBlockScanMinWindowNotionalUsd: Math.max(
    0,
    Number(process.env.SMART_MONEY_BLOCK_SCAN_MIN_WINDOW_NOTIONAL_USD ?? 0)
  ),
  /**
   * QUALIFIED 超顶动作：dormant | eliminated（Phase G 默认 eliminated）
   */
  smartMoneyQualifiedOverCapAction: (
    process.env.SMART_MONEY_QUALIFIED_OVER_CAP_ACTION ?? 'eliminated'
  ).trim().toLowerCase() as 'dormant' | 'eliminated',
  /** SCORED 非展示活跃硬顶；评分门槛调整默认 1200（榜前 Copy 积压配套） */
  smartMoneyScoredMaxActive: Math.max(
    0,
    Number(process.env.SMART_MONEY_SCORED_MAX_ACTIVE ?? 1200)
  ),
  /** SCORED 最多再 Deep 未入榜次数；达到则 ELIMINATED（Phase G 默认 1） */
  smartMoneyScoredMaxMiss: Math.max(
    0,
    Number(process.env.SMART_MONEY_SCORED_MAX_MISS ?? 1)
  ),
  /** Light 便宜加严：低持仓 + 低预测数（0=关闭该条） */
  smartMoneyLightMinHoldingsForSparse: Math.max(
    0,
    Number(process.env.SMART_MONEY_LIGHT_MIN_HOLDINGS_FOR_SPARSE ?? 50)
  ),
  smartMoneyLightMaxPredictionForSparse: Math.max(
    0,
    Number(process.env.SMART_MONEY_LIGHT_MAX_PREDICTION_FOR_SPARSE ?? 30)
  ),
  /** Light：加入天数下限内 + 预测密度过高 → 淘汰（0=关闭密度门） */
  smartMoneyLightMaxAccountAgeDaysForDensity: Math.max(
    0,
    Number(process.env.SMART_MONEY_LIGHT_MAX_ACCOUNT_AGE_DAYS_FOR_DENSITY ?? 14)
  ),
  smartMoneyLightMaxPredictionsPerDay: Math.max(
    0,
    Number(process.env.SMART_MONEY_LIGHT_MAX_PREDICTIONS_PER_DAY ?? 80)
  ),
  /** RAW 从未 Light 且 lastSeen 超过该天数 → dormant */
  smartMoneyRawStaleDormantDays: Math.max(
    1,
    Number(process.env.SMART_MONEY_RAW_STALE_DORMANT_DAYS ?? 14)
  ),
  /** qualifiedDeepReady 超过该值时 Deep 批略向新人倾斜 */
  smartMoneyQualifiedDeepReadyPressure: Math.max(
    100,
    Number(process.env.SMART_MONEY_QUALIFIED_DEEP_READY_PRESSURE ?? 2_000)
  ),
  /** Light 每批默认 20（Phase F 2C2G 稳态） */
  smartMoneyLightFetchBatchSize: Math.max(
    1,
    Number(process.env.SMART_MONEY_LIGHT_FETCH_BATCH_SIZE ?? 20)
  ),
  smartMoneyLightFetchIntervalMs: Math.max(
    60_000,
    Number(process.env.SMART_MONEY_LIGHT_FETCH_INTERVAL_MS ?? 120_000)
  ),
  /** Deep-Gate 每批默认 12：常态 9 QUALIFIED + 1 SCORED + 2 复评；TopN 为 7 + 1 + 4 */
  smartMoneyDeepFetchBatchSize: Math.max(
    1,
    Number(process.env.SMART_MONEY_DEEP_FETCH_BATCH_SIZE ?? 12)
  ),
  smartMoneyDeepFetchIntervalMs: Math.max(
    60_000,
    Number(process.env.SMART_MONEY_DEEP_FETCH_INTERVAL_MS ?? 180_000)
  ),
  /** 全榜排名重排 flush 间隔：Deep/Gamma/Rank 只标脏，由该 cron 合并执行 */
  smartMoneyRankRecomputeIntervalMs: Math.max(
    30_000,
    Number(process.env.SMART_MONEY_RANK_RECOMPUTE_INTERVAL_MS ?? 60_000)
  ),
  /** 单个钱包 Light 硬超时（毫秒） */
  smartMoneyLightWalletTimeoutMs: Math.max(
    15_000,
    Number(process.env.SMART_MONEY_LIGHT_WALLET_TIMEOUT_MS ?? 45_000)
  ),
  /** 单个钱包 Deep 硬超时（full/enrich 路径） */
  smartMoneyDeepWalletTimeoutMs: Math.max(
    30_000,
    Number(process.env.SMART_MONEY_DEEP_WALLET_TIMEOUT_MS ?? 180_000)
  ),
  /**
   * Deep-Gate 单钱包硬超时。
   * Closed Prefetch 落地后 Gate 不再同步翻 closed，默认 45s 即可覆盖 trades+算分。
   */
  smartMoneyDeepGateWalletTimeoutMs: Math.max(
    15_000,
    Number(process.env.SMART_MONEY_DEEP_GATE_WALLET_TIMEOUT_MS ?? 45_000)
  ),
  /** 用户按需地址分析：短队列，避免挤压排行榜管道。 */
  smartMoneyOnDemandFreshnessMs: Math.max(
    60_000,
    Number(process.env.SMART_MONEY_ON_DEMAND_FRESHNESS_MS ?? 24 * 60 * 60 * 1000)
  ),
  smartMoneyOnDemandQueueMax: Math.max(
    1,
    Math.min(5, Number(process.env.SMART_MONEY_ON_DEMAND_QUEUE_MAX ?? 5))
  ),
  smartMoneyOnDemandJobTimeoutMs: Math.max(
    30_000,
    Number(process.env.SMART_MONEY_ON_DEMAND_JOB_TIMEOUT_MS ?? 5 * 60_000)
  ),
  smartMoneyOnDemandPendingTimeoutMs: Math.max(
    60_000,
    Number(process.env.SMART_MONEY_ON_DEMAND_PENDING_TIMEOUT_MS ?? 10 * 60_000)
  ),
  smartMoneyOnDemandUserDailyLimit: Math.max(
    1,
    Number(process.env.SMART_MONEY_ON_DEMAND_USER_DAILY_LIMIT ?? 10)
  ),
  smartMoneyOnDemandWalletCooldownMs: Math.max(
    0,
    Number(process.env.SMART_MONEY_ON_DEMAND_WALLET_COOLDOWN_MS ?? 60_000)
  ),
  /** Closed Prefetch：与 Deep 解耦预热 closed-positions */
  smartMoneyClosedPrefetchEnabled: getBooleanEnv('SMART_MONEY_CLOSED_PREFETCH_ENABLED', true),
  smartMoneyClosedPrefetchConcurrency: Math.max(
    1,
    Number(process.env.SMART_MONEY_CLOSED_PREFETCH_CONCURRENCY ?? 3)
  ),
  smartMoneyClosedPrefetchBatchSize: Math.max(
    1,
    Number(process.env.SMART_MONEY_CLOSED_PREFETCH_BATCH_SIZE ?? 12)
  ),
  smartMoneyClosedPrefetchIntervalMs: Math.max(
    30_000,
    Number(process.env.SMART_MONEY_CLOSED_PREFETCH_INTERVAL_MS ?? 60_000)
  ),
  /**
   * RAW 活跃数 ≥ 该值，且确有到期 Light 待处理时，跳过本轮 Closed Prefetch（给 Light 让路）。
   * 0=关闭。切勿设成 ≤ RAW 稳态水位（如 max=1000 却设 800），否则 Gate 会长期停摆。
   * 仅建议短时积压：设高于日常水位，或依赖下方「有 Light due」条件。
   */
  smartMoneyClosedPrefetchYieldRawActive: Math.max(
    0,
    Number(process.env.SMART_MONEY_CLOSED_PREFETCH_YIELD_RAW_ACTIVE ?? 0)
  ),
  /** 单钱包每 tick 最多续拉页数（断点） */
  smartMoneyClosedPrefetchPagesPerTick: Math.max(
    1,
    Number(process.env.SMART_MONEY_CLOSED_PREFETCH_PAGES_PER_TICK ?? 10)
  ),
  /** 单钱包每 tick 总预算 */
  smartMoneyClosedPrefetchTickBudgetMs: Math.max(
    10_000,
    Number(process.env.SMART_MONEY_CLOSED_PREFETCH_TICK_BUDGET_MS ?? 60_000)
  ),
  /**
   * Gate Prefetch：超过该年龄仍停在 FETCHING 的快照，下一批开始时打回 PENDING 续拉。
   * 防止「第一段写完后 cron 停摆」留下僵尸半成品。0=关闭。
   */
  smartMoneyClosedPrefetchStaleFetchingMs: Math.max(
    0,
    Number(process.env.SMART_MONEY_CLOSED_PREFETCH_STALE_FETCHING_MS ?? 180_000)
  ),
  /**
   * Gate Prefetch 整批墙钟上限；超时后结束本轮让 cron 能排下一轮。
   * 默认按「批次数/并发 × 单钱包预算 + 30s」估算，可用环境变量覆盖。
   */
  smartMoneyClosedPrefetchBatchBudgetMs: Math.max(
    30_000,
    Number(
      process.env.SMART_MONEY_CLOSED_PREFETCH_BATCH_BUDGET_MS ??
        Math.ceil(
          Math.max(1, Number(process.env.SMART_MONEY_CLOSED_PREFETCH_BATCH_SIZE ?? 12)) /
            Math.max(1, Number(process.env.SMART_MONEY_CLOSED_PREFETCH_CONCURRENCY ?? 3))
        ) *
          Math.max(10_000, Number(process.env.SMART_MONEY_CLOSED_PREFETCH_TICK_BUDGET_MS ?? 60_000)) +
          30_000
    )
  ),
  /**
   * Gate 最多页（上限，非下限；扫尽可更早 READY）。
   * 默认 30 ≈ 最近 1500 行 closed（假定新→旧）；可配 20～40，硬顶 80。
   */
  smartMoneyClosedGateMaxPages: Math.max(
    1,
    Math.min(80, Number(process.env.SMART_MONEY_CLOSED_GATE_MAX_PAGES ?? 30))
  ),
  /** Gate TTL：增量落地后作「软过期」窗口；全量重建见 fullRebuildMs */
  smartMoneyClosedGateTtlMs: Math.max(
    60_000,
    Number(process.env.SMART_MONEY_CLOSED_GATE_TTL_MS ?? 24 * 60 * 60 * 1000)
  ),
  /** Full 最多页（入池后补全） */
  smartMoneyClosedFullMaxPages: Math.max(
    1,
    Math.min(80, Number(process.env.SMART_MONEY_CLOSED_FULL_MAX_PAGES ?? 80))
  ),
  smartMoneyClosedFullTtlMs: Math.max(
    60_000,
    Number(process.env.SMART_MONEY_CLOSED_FULL_TTL_MS ?? 24 * 60 * 60 * 1000)
  ),
  /** 超过该年龄强制全量重建 Gate（即使仍有 rows）；默认 72h */
  smartMoneyClosedFullRebuildMs: Math.max(
    3_600_000,
    Number(process.env.SMART_MONEY_CLOSED_FULL_REBUILD_MS ?? 72 * 60 * 60 * 1000)
  ),
  /** 单次增量最多翻页（从 offset=0 追新） */
  smartMoneyClosedIncrementalMaxPages: Math.max(
    1,
    Math.min(30, Number(process.env.SMART_MONEY_CLOSED_INCREMENTAL_MAX_PAGES ?? 10))
  ),
  /** 距上次 fetchedAt 不足该间隔则跳过增量（防同批抖动） */
  smartMoneyClosedIncrementalMinAgeMs: Math.max(
    60_000,
    Number(process.env.SMART_MONEY_CLOSED_INCREMENTAL_MIN_AGE_MS ?? 30 * 60 * 1000)
  ),
  /** 启用 closed 真增量合并（复评 / 过期 Gate 优先于全量重置） */
  smartMoneyClosedIncrementalEnabled: getBooleanEnv(
    'SMART_MONEY_CLOSED_INCREMENTAL_ENABLED',
    true
  ),
  /** Deep-Gate 必须读到 READY Gate 快照才算分（缺则短冷却，不现场拉 closed） */
  smartMoneyDeepRequireClosedSnapshot: getBooleanEnv(
    'SMART_MONEY_DEEP_REQUIRE_CLOSED_SNAPSHOT',
    true
  ),
  /** 入池后 Full closed 补全 + 展示刷新 */
  smartMoneyClosedFullEnrichEnabled: getBooleanEnv(
    'SMART_MONEY_CLOSED_FULL_ENRICH_ENABLED',
    true
  ),
  smartMoneyClosedFullEnrichBatchSize: Math.max(
    1,
    Number(process.env.SMART_MONEY_CLOSED_FULL_ENRICH_BATCH_SIZE ?? 4)
  ),
  smartMoneyClosedFullEnrichIntervalMs: Math.max(
    60_000,
    Number(process.env.SMART_MONEY_CLOSED_FULL_ENRICH_INTERVAL_MS ?? 180_000)
  ),
  /**
   * CopyPool 复评模式：
   * - dual_channel：TopN 日更硬保障 + 非 TopN cursor 连续轮转（推荐）
   * - legacy_tiered：旧 1d/3d/7d 分层冷却
   */
  smartMoneyCopyPoolRescoreMode: (
    String(process.env.SMART_MONEY_COPY_POOL_RESCORE_MODE ?? 'dual_channel')
      .trim()
      .toLowerCase() === 'legacy_tiered'
      ? 'legacy_tiered'
      : 'dual_channel'
  ) as 'dual_channel' | 'legacy_tiered',
  /** 每日强制复评的 rank 上限（1–500）；dual_channel 下生效 */
  smartMoneyCopyPoolDailyTopN: Math.max(
    1,
    Math.min(500, Number(process.env.SMART_MONEY_COPY_POOL_DAILY_TOP_N ?? 100))
  ),
  /** 自然日边界时区（Intl）；默认 UTC */
  smartMoneyCopyPoolDailyTz: String(process.env.SMART_MONEY_COPY_POOL_DAILY_TZ ?? 'UTC').trim() || 'UTC',
  /** TopN 有日欠债时临时抬高复评份额；batch=12、默认 0.34 → 4 个槽 */
  smartMoneyCopyPoolPriorityRefreshShare: Math.max(
    0.1,
    Math.min(0.5, Number(process.env.SMART_MONEY_COPY_POOL_PRIORITY_REFRESH_SHARE ?? 0.34))
  ),
  /** 入池后同步写近似 rank（正式 flush 覆盖）；缩短刚入榜空窗 */
  smartMoneyCopyPoolApproxRankEnabled: getBooleanEnv(
    'SMART_MONEY_COPY_POOL_APPROX_RANK_ENABLED',
    true
  ),
  /** TopN 日终 SLA 检查 cron */
  smartMoneyCopyPoolSlaCronEnabled: getBooleanEnv(
    'SMART_MONEY_COPY_POOL_SLA_CRON_ENABLED',
    true
  ),
  smartMoneyCopyPoolSlaIntervalMs: Math.max(
    60_000,
    Number(process.env.SMART_MONEY_COPY_POOL_SLA_INTERVAL_MS ?? 5 * 60 * 1000)
  ),
  /** CopyPool 分层复评（legacy_tiered）：Top100 / ≤500 / 其余（毫秒） */
  smartMoneyCopyPoolRescoreTopMs: Math.max(
    3_600_000,
    Number(process.env.SMART_MONEY_COPY_POOL_RESCORE_TOP_MS ?? 24 * 60 * 60 * 1000)
  ),
  smartMoneyCopyPoolRescoreMidMs: Math.max(
    3_600_000,
    Number(process.env.SMART_MONEY_COPY_POOL_RESCORE_MID_MS ?? 3 * 24 * 60 * 60 * 1000)
  ),
  smartMoneyCopyPoolRescoreTailMs: Math.max(
    3_600_000,
    Number(process.env.SMART_MONEY_COPY_POOL_RESCORE_TAIL_MS ?? 7 * 24 * 60 * 60 * 1000)
  ),
  smartMoneyCopyPoolRescoreTopRank: Math.max(
    1,
    Number(process.env.SMART_MONEY_COPY_POOL_RESCORE_TOP_RANK ?? 100)
  ),
  smartMoneyCopyPoolRescoreMidRank: Math.max(
    1,
    Number(process.env.SMART_MONEY_COPY_POOL_RESCORE_MID_RANK ?? 500)
  ),
  /** 淘汰池慢检 */
  smartMoneyEliminatedCronEnabled: getBooleanEnv('SMART_MONEY_ELIMINATED_CRON_ENABLED', true),
  smartMoneyEliminatedIntervalMs: Math.max(
    60_000,
    Number(process.env.SMART_MONEY_ELIMINATED_INTERVAL_MS ?? 3_600_000)
  ),
  smartMoneyEliminatedBatchSize: Math.max(
    1,
    Number(process.env.SMART_MONEY_ELIMINATED_BATCH_SIZE ?? 8)
  ),
  smartMoneyEliminatedRecheckMs: Math.max(
    3_600_000,
    Number(process.env.SMART_MONEY_ELIMINATED_RECHECK_MS ?? 7 * 24 * 60 * 60 * 1000)
  ),
  smartMoneyEliminatedMaxFails: Math.max(
    1,
    Number(process.env.SMART_MONEY_ELIMINATED_MAX_FAILS ?? 3)
  ),
  smartMoneyEliminatedFreezeMs: Math.max(
    3_600_000,
    Number(process.env.SMART_MONEY_ELIMINATED_FREEZE_MS ?? 30 * 24 * 60 * 60 * 1000)
  ),
  /**
   * 强信号（扫块/榜源）复活冷却：距上次写入淘汰态未满该时长则拒绝回 RAW。
   * 默认 3d（Light 类淘汰）。ADMIN/MANUAL 不受限。
   */
  smartMoneyStrongReviveCooldownMs: Math.max(
    0,
    Number(process.env.SMART_MONEY_STRONG_REVIVE_COOLDOWN_MS ?? 3 * 24 * 60 * 60 * 1000)
  ),
  /**
   * Deep-L1 / COPY_HARD / SCORE_BELOW 等需 Deep 重审类：更长冷却（结构指标短期难变）。
   * 默认 7d；须 ≥ smartMoneyStrongReviveCooldownMs。
   */
  smartMoneyStrongReviveDeepCooldownMs: Math.max(
    0,
    Number(process.env.SMART_MONEY_STRONG_REVIVE_DEEP_COOLDOWN_MS ?? 7 * 24 * 60 * 60 * 1000)
  ),
  /** 淘汰池：连续无成交超过该天数 → PURGED（删除管道行） */
  smartMoneyElimPurgeNoTradeDays: Math.max(
    1,
    Number(process.env.SMART_MONEY_ELIM_PURGE_NO_TRADE_DAYS ?? 30)
  ),
  /** Light 双短窗亏损延后天数 */
  smartMoneyLightDualShortDeferDays: Math.max(
    1,
    Number(process.env.SMART_MONEY_LIGHT_DUAL_SHORT_DEFER_DAYS ?? 5)
  ),
  /** Light：1Y 净盈 ≤ 该值则 L-PNL1Y（默认 0） */
  smartMoneyLightMinPnl1y: Number(process.env.SMART_MONEY_LIGHT_MIN_PNL_1Y ?? 0),
  /** 入榜后异步补全窗 trades / copyability 仿真 */
  smartMoneyCopyabilityEnrichEnabled: getBooleanEnv(
    'SMART_MONEY_COPYABILITY_ENRICH_ENABLED',
    true
  ),
  smartMoneyCopyabilityEnrichBatchSize: Math.max(
    1,
    Number(process.env.SMART_MONEY_COPYABILITY_ENRICH_BATCH_SIZE ?? 5)
  ),
  smartMoneyCopyabilityEnrichIntervalMs: Math.max(
    60_000,
    Number(process.env.SMART_MONEY_COPYABILITY_ENRICH_INTERVAL_MS ?? 300_000)
  ),
  /** Copyability 单钱包硬超时：防止一个地址永久堵死串行补全车道 */
  smartMoneyCopyabilityEnrichWalletTimeoutMs: Math.max(
    15_000,
    Number(process.env.SMART_MONEY_COPYABILITY_ENRICH_WALLET_TIMEOUT_MS ?? 90_000)
  ),
  /** Copyability 单批预算：到点停止领取下一钱包，确保 cron 可返回并继续调度 */
  smartMoneyCopyabilityEnrichBatchBudgetMs: Math.max(
    60_000,
    Number(process.env.SMART_MONEY_COPYABILITY_ENRICH_BATCH_BUDGET_MS ?? 300_000)
  ),
  /** 失败地址进程内冷却，避免同一批坏地址每轮占据队首 */
  smartMoneyCopyabilityEnrichFailureCooldownMs: Math.max(
    60_000,
    Number(process.env.SMART_MONEY_COPYABILITY_ENRICH_FAILURE_COOLDOWN_MS ?? 900_000)
  ),
  smartMoneyGammaEnrichmentEnabled: getBooleanEnv('SMART_MONEY_GAMMA_ENRICHMENT_ENABLED', true),
  smartMoneyGammaEnrichmentBatchSize: Math.max(
    1,
    Number(process.env.SMART_MONEY_GAMMA_ENRICHMENT_BATCH_SIZE ?? 20)
  ),
  smartMoneyGammaEnrichmentIntervalMs: Math.max(
    300_000,
    Number(process.env.SMART_MONEY_GAMMA_ENRICHMENT_INTERVAL_MS ?? 3_600_000)
  ),
  smartMoneyGammaEnrichmentMinRetryMs: Math.max(
    3_600_000,
    Number(process.env.SMART_MONEY_GAMMA_ENRICHMENT_MIN_RETRY_MS ?? 6 * 60 * 60 * 1000)
  ),
  /** Deep-Enrich：入榜后异步补 1D/1M 曲线（设计 §4.5） */
  smartMoneyCurveEnrichEnabled: getBooleanEnv('SMART_MONEY_CURVE_ENRICH_ENABLED', true),
  smartMoneyCurveEnrichBatchSize: Math.max(
    1,
    Number(process.env.SMART_MONEY_CURVE_ENRICH_BATCH_SIZE ?? 25)
  ),
  smartMoneyCurveEnrichIntervalMs: Math.max(
    60_000,
    Number(process.env.SMART_MONEY_CURVE_ENRICH_INTERVAL_MS ?? 180_000)
  ),
  /** 已补过的地址多久后可再补（默认 24h） */
  smartMoneyCurveEnrichMinRetryMs: Math.max(
    3_600_000,
    Number(process.env.SMART_MONEY_CURVE_ENRICH_MIN_RETRY_MS ?? 24 * 60 * 60 * 1000)
  ),
  /** L0/L1 失败冷却：默认 2 天（原 7 天过重） */
  smartMoneyTier1RetryMs: Math.max(
    3_600_000,
    Number(process.env.SMART_MONEY_TIER1_RETRY_MS ?? 2 * 24 * 60 * 60 * 1000)
  ),
  /** SCORED 未入榜后再 Deep 冷却（F5：与 TIER1_RETRY 分离，默认 6h） */
  smartMoneyScoredRecheckMs: Math.max(
    60_000,
    Number(process.env.SMART_MONEY_SCORED_RECHECK_MS ?? 6 * 60 * 60 * 1000)
  ),
  /** dual_channel background 复评成功冷却（F5：默认 12h；禁止 nextDeep=now） */
  smartMoneyCopyPoolBgRescoreMs: Math.max(
    60_000,
    Number(process.env.SMART_MONEY_COPY_POOL_BG_RESCORE_MS ?? 12 * 60 * 60 * 1000)
  ),
  /** dual_channel TopN 日更成功冷却（默认 1h，仍短于 background） */
  smartMoneyCopyPoolPriorityRescoreMs: Math.max(
    60_000,
    Number(process.env.SMART_MONEY_COPY_POOL_PRIORITY_RESCORE_MS ?? 60 * 60 * 1000)
  ),
  smartMoneyTier1fMinTrades30d: Math.max(0, Number(process.env.SMART_MONEY_TIER1F_MIN_TRADES_30D ?? 1)),
  smartMoneyTier1fMinDataConfidence: Math.max(
    0,
    Number(process.env.SMART_MONEY_TIER1F_MIN_DATA_CONFIDENCE ?? 60)
  ),
  smartMoneyTier2MinTotalReturn: Number(process.env.SMART_MONEY_TIER2_MIN_TOTAL_RETURN ?? 0.01),
  smartMoneyTier2MaxDrawdown: Number(process.env.SMART_MONEY_TIER2_MAX_DRAWDOWN ?? 0.35),
  /** L1 相对回撤动态护栏：同窗 return / MDD 最低值 */
  smartMoneyTier2MinCalmar: Number(process.env.SMART_MONEY_TIER2_MIN_CALMAR ?? 2),
  /**
   * 生涯 Volume（展示/排序加权用）。已不再作为 L1 硬门（L1-VOL 已取消）。
   */
  smartMoneyTier2MinVolume: Math.max(0, Number(process.env.SMART_MONEY_TIER2_MIN_VOLUME ?? 1_000_000)),
  /** 评分池 C1：近 1Y 总盈利美元下限（管道优化：默认 $1000，减少无效 Deep） */
  smartMoneyScorePoolMinPnl1y: Math.max(0, Number(process.env.SMART_MONEY_SCORE_POOL_MIN_PNL_1Y ?? 1000)),
  /** L1 粉尘：中位成交名义低于该值 → L1-DUST；默认 0=关闭中位硬门（高质量小单可进池） */
  smartMoneyL1MinMedianNotionalUsd: Math.max(
    0,
    Number(process.env.SMART_MONEY_L1_MIN_MEDIAN_NOTIONAL_USD ?? 0)
  ),
  /**
   * 粉尘占比软扣分阈值（原 L1-DUST 硬门）：名义 &lt; dustNotional 的笔数占比 ≥ 该值
   * → 打 HIGH_DUST_SHARE 软旗，不挡 L1 / CopyPool。
   */
  smartMoneyL1MaxDustShare: Math.max(
    0,
    Math.min(1, Number(process.env.SMART_MONEY_L1_MAX_DUST_SHARE ?? 0.4))
  ),
  /** L1 粉尘硬门最小交易样本；Gate 早停样本不足时跳过，避免用 1~2 笔误判分布 */
  smartMoneyL1DustMinSampleCount: Math.max(
    1,
    Number(process.env.SMART_MONEY_L1_DUST_MIN_SAMPLE_COUNT ?? 20)
  ),
  smartMoneyDustNotionalUsd: Math.max(0, Number(process.env.SMART_MONEY_DUST_NOTIONAL_USD ?? 5)),
  /**
   * CopyPool：可测 MDD% ≥ 该值时 L1-MDD-PCT 硬淘汰。
   * 默认 0=关闭硬门（高回撤改走 TraderScore 大幅减分，仍允许进池）。
   */
  smartMoneyCopyPoolMaxMddPct: Math.max(
    0,
    Math.min(1, Number(process.env.SMART_MONEY_COPY_POOL_MAX_MDD_PCT ?? 0))
  ),
  /** TraderScore：MDD% ≥ 该阈值开始大幅减分（默认 70%） */
  smartMoneyScoreHighMddPct: Math.max(
    0,
    Math.min(1, Number(process.env.SMART_MONEY_SCORE_HIGH_MDD_PCT ?? 0.7))
  ),
  /** 刚达高回撤阈值时的减分 */
  smartMoneyScoreHighMddPenalty: Math.max(
    0,
    Number(process.env.SMART_MONEY_SCORE_HIGH_MDD_PENALTY ?? 18)
  ),
  /** 回撤从阈值升到 100% 时额外再减的分（合计约 18→28） */
  smartMoneyScoreHighMddPenaltyExtra: Math.max(
    0,
    Number(process.env.SMART_MONEY_SCORE_HIGH_MDD_PENALTY_EXTRA ?? 10)
  ),
  /** S/A：可测 MDD% 必须 &lt; 该值 */
  smartMoneyTierSaMaxMddPct: Math.max(
    0,
    Math.min(1, Number(process.env.SMART_MONEY_TIER_SA_MAX_MDD_PCT ?? 0.4))
  ),
  /** S/A：中位成交名义下限 */
  smartMoneyTierSaMinMedianNotionalUsd: Math.max(
    0,
    Number(process.env.SMART_MONEY_TIER_SA_MIN_MEDIAN_NOTIONAL_USD ?? 20)
  ),
  /** TraderScore 软修正：30D&lt;0 罚分 */
  smartMoneyScorePnl30dPenalty: Math.max(
    0,
    Number(process.env.SMART_MONEY_SCORE_PNL30D_PENALTY ?? 15)
  ),
  /** TraderScore 软修正：7D 加减分绝对值上限 */
  smartMoneyScorePnl7dAbsCap: Math.max(0, Number(process.env.SMART_MONEY_SCORE_PNL7D_ABS_CAP ?? 8)),
  /** TraderScore：大额中位成交加分 */
  smartMoneyScoreLargeTradeBonus: Math.max(
    0,
    Number(process.env.SMART_MONEY_SCORE_LARGE_TRADE_BONUS ?? 4)
  ),
  smartMoneyLargeTradeMedianUsd: Math.max(
    0,
    Number(process.env.SMART_MONEY_LARGE_TRADE_MEDIAN_USD ?? 200)
  ),
  /** Gate 是否拉 open /positions；默认 false（Enrich 再拉） */
  smartMoneyGateFetchOpenPositions: getBooleanEnv('SMART_MONEY_GATE_FETCH_OPEN_POSITIONS', false),
  /** 假 MDD 加严：比例阈值 */
  smartMoneyMddImplausibleRatio: Math.max(
    0,
    Math.min(1, Number(process.env.SMART_MONEY_MDD_IMPLAUSIBLE_RATIO ?? 0.85))
  ),
  smartMoneyMddImplausibleMinPeakUsd: Math.max(
    0,
    Number(process.env.SMART_MONEY_MDD_IMPLAUSIBLE_MIN_PEAK_USD ?? 500)
  ),
  smartMoneyMddImplausibleMinDdUsd: Math.max(
    0,
    Number(process.env.SMART_MONEY_MDD_IMPLAUSIBLE_MIN_DD_USD ?? 200)
  ),
  /** 详情曲线 TTL */
  smartMoneyCurve1dTtlMs: Math.max(60_000, Number(process.env.SMART_MONEY_CURVE_1D_TTL_MS ?? 900_000)),
  smartMoneyCurve1wTtlMs: Math.max(
    60_000,
    Number(process.env.SMART_MONEY_CURVE_1W_TTL_MS ?? 3_600_000)
  ),
  smartMoneyCurve1mTtlMs: Math.max(
    60_000,
    Number(process.env.SMART_MONEY_CURVE_1M_TTL_MS ?? 21_600_000)
  ),
  smartMoneyCurveAllTtlMs: Math.max(
    60_000,
    Number(process.env.SMART_MONEY_CURVE_ALL_TTL_MS ?? 43_200_000)
  ),
  /** predicting.top / Analytics 与官方错峰：最小同步间隔（毫秒），默认 2h；0=每轮都跟官方 */
  leaderboardExternalMinIntervalMs: Math.max(
    0,
    Number(process.env.LEADERBOARD_EXTERNAL_MIN_INTERVAL_MS ?? 2 * 60 * 60 * 1000)
  ),
  /** 评分池成熟度门：生涯累计成交额（§15：不再作 L1 硬杀，仅保留配置供观测/旧脚本） */
  smartMoneyScorePoolMinLifetimeVolume: Math.max(
    0,
    Number(process.env.SMART_MONEY_SCORE_POOL_MIN_LIFETIME_VOLUME ?? 10_000)
  ),
  /** 评分池 C4：按市场胜率下限（§15：L1 不再硬拦胜率；配置保留） */
  smartMoneyScorePoolMinWinRate: Math.max(
    0,
    Math.min(1, Number(process.env.SMART_MONEY_SCORE_POOL_MIN_WIN_RATE ?? 0.1))
  ),
  /** 评分池 C5：按市场盈亏比下限（§15 默认 1.0） */
  smartMoneyScorePoolMinProfitFactor: Math.max(
    0,
    Number(process.env.SMART_MONEY_SCORE_POOL_MIN_PROFIT_FACTOR ?? 1.0)
  ),
  /** 评分池 C6：近 7 日成交笔数下限 */
  smartMoneyScorePoolMinTrades7d: Math.max(
    0,
    Number(process.env.SMART_MONEY_SCORE_POOL_MIN_TRADES_7D ?? 1)
  ),
  /** 评分池 C6：近 30 日至少 2 笔；替代近 7 日硬门 */
  smartMoneyScorePoolMinTrades30d: Math.max(
    0,
    Number(process.env.SMART_MONEY_SCORE_POOL_MIN_TRADES_30D ?? 2)
  ),
  /** 评分池 C8：已平仓市场样本下限（评分门槛调整默认 3；S/A 档仍用更高样本） */
  smartMoneyScorePoolMinClosedMarkets: Math.max(
    1,
    Number(process.env.SMART_MONEY_SCORE_POOL_MIN_CLOSED_MARKETS ?? 3)
  ),
  /**
   * CopyPool 入榜线（§15 单轨 = TraderScore）。
   * 默认 50：略宽于「优秀」，库存靠档位分层。
   */
  smartMoneyCopyPoolEnterScore: Number(process.env.SMART_MONEY_COPY_POOL_ENTER_SCORE ?? 50),
  /** CopyPool 出榜线（§15 单轨 = TraderScore），默认 40 */
  smartMoneyCopyPoolExitScore: Number(process.env.SMART_MONEY_COPY_POOL_EXIT_SCORE ?? 40),
  /**
   * 历史：Deep 对 ≤EXIT 的 miss 迟滞次数。E1 后 ≤EXIT 立即出池（与 flush 同权威），
   * 此配置保留兼容，sync 路径不再读取。
   */
  smartMoneyCopyPoolExitMissCount: Math.max(
    1,
    Number(process.env.SMART_MONEY_COPY_POOL_EXIT_MISS_COUNT ?? 2)
  ),
  /**
 * 空仓 + 无成交超过该天数 → 强制出 CopyPool（世界杯型停摆）。
 * 0 = 关闭。默认 7。
 * 出池后进 ELIMINATED(INACTIVE_FLAT_EXIT)；Deep 不得再覆盖为 SCORE_BELOW。
 */
  smartMoneyCopyPoolInactiveExitDays: Math.max(
    0,
    Number(process.env.SMART_MONEY_COPY_POOL_INACTIVE_EXIT_DAYS ?? 7)
  ),
  /** 判定「空仓」的持仓名义上限（USD）；默认 $1 */
  smartMoneyCopyPoolInactiveMaxHoldingsUsd: Math.max(
    0,
    Number(process.env.SMART_MONEY_COPY_POOL_INACTIVE_MAX_HOLDINGS_USD ?? 1)
  ),
  /**
   * §15 单轨：displayScore / rank / CopyPool 入出均以 TraderScore 为主。
   * 默认 true；仅排障时可设 false 回落 v4 score。
   */
  smartMoneyTraderScoreAsPrimary: getBooleanEnv('SMART_MONEY_TRADER_SCORE_AS_PRIMARY', true),
  /** 入榜是否强制 Tier2E（流动性/平仓分布）；§15 保持 false */
  smartMoneyCopyPoolRequireTier2e: getBooleanEnv('SMART_MONEY_COPY_POOL_REQUIRE_TIER2E', false),
  /**
   * §15：L1 是否要求 maxDrawdown ≤ totalReturn（比例尺，尺子不可靠）。
   * 默认 false；生产改用同窗美元门 SMART_MONEY_L1_MAX_DD_USD_LT_PNL。
   */
  smartMoneyL1MaxDdLeReturn: getBooleanEnv('SMART_MONEY_L1_MAX_DD_LE_RETURN', false),
  /**
   * L1 / Light：同窗最大回撤金额 < 同窗总盈亏（美元）。
   * 默认 true；任一指标不可测则跳过，不误杀。
   */
  /** 同窗 MDD$≥PnL$ 硬门；评分门槛调整默认关闭，改由 TraderScore 回撤健康约束 */
  smartMoneyL1MaxDdUsdLtPnl: getBooleanEnv('SMART_MONEY_L1_MAX_DD_USD_LT_PNL', false),
  /**
   * §15：L1 是否硬拦生涯成交额。默认 false（小额改档位 ≤C，不硬杀）。
   */
  smartMoneyL1RequireLifetimeVolume: getBooleanEnv('SMART_MONEY_L1_REQUIRE_LIFETIME_VOLUME', false),
  /**
   * §15：L1 是否硬拦胜率。默认 false。
   */
  smartMoneyL1RequireWinRate: getBooleanEnv('SMART_MONEY_L1_REQUIRE_WIN_RATE', false),
  /**
   * §15：L1 是否硬拦「回报率≥阈值」。默认 false（净盈 $ 门槛已覆盖方向）。
   */
  smartMoneyL1RequireTotalReturn: getBooleanEnv('SMART_MONEY_L1_REQUIRE_TOTAL_RETURN', false),
  /** L0-B：发现源 lastSeen 仅提权，不单独视为活跃通过 */
  smartMoneyL0ActiveLastSeenDays: Math.max(
    1,
    Number(process.env.SMART_MONEY_L0_ACTIVE_LAST_SEEN_DAYS ?? 30)
  ),
  /** L0 是否对全量 Raw 强打 30d trades；默认 false（§2.1a） */
  smartMoneyL0RequireTradesApi: getBooleanEnv('SMART_MONEY_L0_REQUIRE_TRADES_API', false),
  /** Light/Deep 批内并发（2C2G 稳态默认 2） */
  smartMoneyAnalyzeConcurrency: Math.max(
    1,
    Number(process.env.SMART_MONEY_ANALYZE_CONCURRENCY ?? 2)
  ),
  /**
   * 前台榜列表进程内缓存 TTL（毫秒）。不降管道吞吐；命中则不再打忙库。
   * 0 = 关闭。默认 45s。
   */
  smartMoneyListCacheTtlMs: Math.max(
    0,
    Number(process.env.SMART_MONEY_LIST_CACHE_TTL_MS ?? 45_000)
  ),
  smartMoneyListCacheMaxEntries: Math.max(
    1,
    Number(process.env.SMART_MONEY_LIST_CACHE_MAX_ENTRIES ?? 256)
  ),
  /**
   * profile-risk 进程内缓存 TTL（毫秒）。live=true/false 分 key；HTTP 对 live 仍 no-store。
   * 0 = 关闭。默认 30s。
   */
  smartMoneyProfileRiskCacheTtlMs: Math.max(
    0,
    Number(process.env.SMART_MONEY_PROFILE_RISK_CACHE_TTL_MS ?? 90_000)
  ),
  smartMoneyProfileRiskCacheMaxEntries: Math.max(
    1,
    Number(process.env.SMART_MONEY_PROFILE_RISK_CACHE_MAX_ENTRIES ?? 512)
  ),
  /**
   * Light→Deep 共享 Profile 快照硬 TTL（毫秒）。
   * 过期一律重抓；默认 45min（文档 30–60min）。
   */
  smartMoneyProfileSnapshotTtlMs: Math.max(
    60_000,
    Number(process.env.SMART_MONEY_PROFILE_SNAPSHOT_TTL_MS ?? 2 * 60 * 60 * 1000)
  ),
  /** ANALYZING 超时自愈（毫秒） */
  smartMoneyAnalyzingStaleMs: Math.max(
    60_000,
    Number(process.env.SMART_MONEY_ANALYZING_STALE_MS ?? 15 * 60_000)
  ),
  smartMoneyShrinkPopulationMedian: Number(process.env.SMART_MONEY_SHRINK_POPULATION_MEDIAN ?? 50),
  /** Phase 2：启用 copyability 仿真与 displayScore 榜内排序 */
  smartMoneyCopyabilityEnabled:
    (process.env.SMART_MONEY_COPYABILITY_ENABLED ?? 'true').toLowerCase() === 'true',
  smartMoneyCopyNotionalUsd: Math.max(1, Number(process.env.SMART_MONEY_COPY_NOTIONAL_USD ?? 100)),
  smartMoneyCopyDelaySec: Math.max(0, Number(process.env.SMART_MONEY_COPY_DELAY_SEC ?? 45)),
  smartMoneyCopySlippageBps: Math.max(0, Number(process.env.SMART_MONEY_COPY_SLIPPAGE_BPS ?? 50)),
  smartMoneyCopyLookbackDays: Math.max(1, Number(process.env.SMART_MONEY_COPY_LOOKBACK_DAYS ?? 30)),
  smartMoneyCopyExcludeHedged:
    (process.env.SMART_MONEY_COPY_EXCLUDE_HEDGED ?? 'true').toLowerCase() !== 'false',
  smartMoneyCopyMinReplicableShare: Math.max(
    0,
    Math.min(1, Number(process.env.SMART_MONEY_COPY_MIN_REPLICABLE_SHARE ?? 0.3))
  ),
  smartMoneyDisplayScoreCopyWeight: Math.max(
    0,
    Math.min(1, Number(process.env.SMART_MONEY_DISPLAY_SCORE_COPY_WEIGHT ?? 0.7))
  ),
  smartMoneyDisplayScoreSmartWeight: Math.max(
    0,
    Math.min(1, Number(process.env.SMART_MONEY_DISPLAY_SCORE_SMART_WEIGHT ?? 0.3))
  ),
  /** Phase 3：启用跟单反馈 rankScore + ML displayScore 融合 */
  smartMoneyRankModelEnabled:
    (process.env.SMART_MONEY_RANK_MODEL_ENABLED ?? 'false').toLowerCase() === 'true',
  smartMoneyCopierFeedbackLookbackDays: Math.max(
    1,
    Number(process.env.SMART_MONEY_COPIER_FEEDBACK_LOOKBACK_DAYS ?? 30)
  ),
  smartMoneyRankMinCopierCloses: Math.max(
    1,
    Number(process.env.SMART_MONEY_RANK_MIN_COPIER_CLOSES ?? 5)
  ),
  smartMoneyRankMinCopierSubscribers: Math.max(
    1,
    Number(process.env.SMART_MONEY_RANK_MIN_COPIER_SUBSCRIBERS ?? 2)
  ),
  /** Phase 3 displayScore = rankScore×w + copyability×w（rank 模型开启时） */
  smartMoneyDisplayScoreRankWeight: Math.max(
    0,
    Math.min(1, Number(process.env.SMART_MONEY_DISPLAY_SCORE_RANK_WEIGHT ?? 0.6))
  ),
  smartMoneyDisplayScoreCopyWeightMl: Math.max(
    0,
    Math.min(1, Number(process.env.SMART_MONEY_DISPLAY_SCORE_COPY_WEIGHT_ML ?? 0.4))
  ),
  smartMoneyRankRefreshBatchSize: Math.max(
    1,
    Number(process.env.SMART_MONEY_RANK_REFRESH_BATCH_SIZE ?? 30)
  ),
  smartMoneyRankRefreshIntervalMs: Math.max(
    60_000,
    Number(process.env.SMART_MONEY_RANK_REFRESH_INTERVAL_MS ?? 3_600_000)
  ),
  /** 非 CopyPool 地址订阅：off | warn | block */
  smartMoneyCopyPoolSubscribePolicy: (
    process.env.SMART_MONEY_COPY_POOL_SUBSCRIBE_POLICY ?? 'warn'
  ).toLowerCase() as 'off' | 'warn' | 'block',
  /** profile-risk 非 CopyPool：off | warn | block；未设时沿用订阅策略 */
  smartMoneyProfileRiskCopyPoolPolicy: (() => {
    const raw = process.env.SMART_MONEY_PROFILE_RISK_COPY_POOL_POLICY?.trim().toLowerCase();
    if (raw === 'off' || raw === 'warn' || raw === 'block') return raw;
    return (process.env.SMART_MONEY_COPY_POOL_SUBSCRIBE_POLICY ?? 'warn').toLowerCase() as
      | 'off'
      | 'warn'
      | 'block';
  })(),
  /** v2.3 入榜：已平仓市场中收益 >5% 的占比下限 */
  smartMoneyMinHighReturnMarketShare: Math.max(
    0,
    Math.min(1, Number(process.env.SMART_MONEY_MIN_HIGH_RETURN_MARKET_SHARE ?? 0.5))
  ),
  /**
   * 入榜硬门槛：近窗已平仓平均盈利率（事件等权 meanReturn）下限。
   * 低于该值打 LOW_AVG_CLOSED_RETURN_RATE，拦截 CopyPool / eligible。
   * 默认 0.35 = 35%；可用 SMART_MONEY_MIN_AVG_CLOSED_RETURN_RATE 覆盖。
   */
  smartMoneyMinAvgClosedReturnRate: Math.max(
    0,
    Math.min(10, Number(process.env.SMART_MONEY_MIN_AVG_CLOSED_RETURN_RATE ?? 0.35))
  ),
  /** v2.3 入榜：Gamma 市场累计成交量门槛（USD） */
  smartMoneyMinMarketVolumeUsd: Math.max(0, Number(process.env.SMART_MONEY_MIN_MARKET_VOLUME_USD ?? 100_000)),
  /** v2.3 入榜：大盘口（volume >= minMarketVolumeUsd）仓位权重占比下限 */
  smartMoneyMinHighVolumeMarketShare: Math.max(
    0,
    Math.min(1, Number(process.env.SMART_MONEY_MIN_HIGH_VOLUME_MARKET_SHARE ?? 0.5))
  ),
  /** v2.3 入榜：最大回撤上限（比例，0.35 = 35%） */
  smartMoneyMaxEligibleDrawdown: Math.max(
    0,
    Math.min(1, Number(process.env.SMART_MONEY_MAX_ELIGIBLE_DRAWDOWN ?? 0.35))
  ),
  /** v2.3 入榜：最少已平仓市场样本数 */
  smartMoneyMinClosedMarketsForEligibility: Math.max(
    1,
    Number(process.env.SMART_MONEY_MIN_CLOSED_MARKETS_FOR_ELIGIBILITY ?? 8)
  ),
  /** v2.3 入榜：可解析到 Gamma 成交量的仓位占比下限 */
  smartMoneyMinLiquidityClassificationShare: Math.max(
    0,
    Math.min(1, Number(process.env.SMART_MONEY_MIN_LIQUIDITY_CLASSIFICATION_SHARE ?? 0.6))
  ),
  /** 基础筛选与惩罚阈值 */
  smartMoneyMinHoldingsValue: Math.max(0, Number(process.env.SMART_MONEY_MIN_HOLDINGS_VALUE ?? 2000)),
  /** 持仓超过该值标记 HIGH_HOLDINGS 并降权后排（0=不限制） */
  smartMoneyMaxHoldingsValue: Math.max(0, Number(process.env.SMART_MONEY_MAX_HOLDINGS_VALUE ?? 10_000)),
  smartMoneyMinPredictionCount: Math.max(0, Number(process.env.SMART_MONEY_MIN_PREDICTION_COUNT ?? 5)),
  smartMoneyMaxSingleSpikeRatio: Math.max(
    0,
    Math.min(1, Number(process.env.SMART_MONEY_MAX_SINGLE_SPIKE_RATIO ?? 0.6))
  ),
  smartMoneyMinRecentCurveStrength: Number(process.env.SMART_MONEY_MIN_RECENT_CURVE_STRENGTH ?? 0),
  smartMoneyMinCurvePointCount: getSmartMoneyMinCurvePointCount(),
  /**
   * 成交频率软罚阈值（24h 笔数或 30d 日均）。
   * 评分门槛：>soft 且未达硬线 → 软罚（不进 COPY_POOL_HARD）。
   */
  smartMoneyMaxTradesPerDay: Math.max(1, Number(process.env.SMART_MONEY_MAX_TRADES_PER_DAY ?? 200)),
  /** 近 30d 日均软罚阈值（与 maxTradesPerDay 同义档，默认 200） */
  smartMoneyMaxTradesPerDay30dAvg: Math.max(
    1,
    Number(process.env.SMART_MONEY_MAX_TRADES_PER_DAY_30D_AVG ?? 200)
  ),
  /**
   * 成交频率标记阈值：仅 30d 日均超过该值打 HIGH_TRADE_FREQUENCY（软扣分，不硬拦 CopyPool）。
   * 24h 尖峰即使超过也不打该旗（改 ELEVATED 软罚），避免活动日误杀。
   * 进榜质量改由平均盈利率等门槛把关。
   */
  smartMoneyMaxTradesPerDayHard: Math.max(
    1,
    Number(process.env.SMART_MONEY_MAX_TRADES_PER_DAY_HARD ?? 500)
  ),
  /** 榜前必须完成仿跟单（三情景）才允许进 COPY_POOL / 展示 */
  smartMoneyCopyReadyRequiredForPool: getBooleanEnv(
    'SMART_MONEY_COPY_READY_REQUIRED_FOR_POOL',
    true
  ),
  /** TraderScore 克制演进影子分写入；切主见 traderScoreNextAsPrimary */
  smartMoneyTraderScoreShadowEnabled: getBooleanEnv(
    'SMART_MONEY_TRADER_SCORE_SHADOW_ENABLED',
    true
  ),
  /** true：展示/入出池改用演进公式（影子观察 ≥7 天后打开） */
  smartMoneyTraderScoreNextAsPrimary: getBooleanEnv(
    'SMART_MONEY_TRADER_SCORE_NEXT_AS_PRIMARY',
    false
  ),
  /** 三情景 Copy：tight 滑点 bps / 延迟秒 */
  smartMoneyCopyTightSlippageBps: Math.max(
    0,
    Number(process.env.SMART_MONEY_COPY_TIGHT_SLIPPAGE_BPS ?? 10)
  ),
  smartMoneyCopyTightDelaySec: Math.max(
    0,
    Number(process.env.SMART_MONEY_COPY_TIGHT_DELAY_SEC ?? 15)
  ),
  /** 三情景 Copy：stress 滑点 bps / 延迟秒 */
  smartMoneyCopyStressSlippageBps: Math.max(
    0,
    Number(process.env.SMART_MONEY_COPY_STRESS_SLIPPAGE_BPS ?? 100)
  ),
  smartMoneyCopyStressDelaySec: Math.max(
    0,
    Number(process.env.SMART_MONEY_COPY_STRESS_DELAY_SEC ?? 90)
  ),
  /** 三情景合成权重（会归一化） */
  smartMoneyCopyScenarioWeightTight: Math.max(
    0,
    Number(process.env.SMART_MONEY_COPY_SCENARIO_WEIGHT_TIGHT ?? 0.2)
  ),
  smartMoneyCopyScenarioWeightBase: Math.max(
    0,
    Number(process.env.SMART_MONEY_COPY_SCENARIO_WEIGHT_BASE ?? 0.5)
  ),
  smartMoneyCopyScenarioWeightStress: Math.max(
    0,
    Number(process.env.SMART_MONEY_COPY_SCENARIO_WEIGHT_STRESS ?? 0.3)
  ),
  /** 仿跟单综合分：RT / 已平仓中位数权重（会归一化） */
  smartMoneyCopyRtWeight: Math.max(0, Number(process.env.SMART_MONEY_COPY_RT_WEIGHT ?? 0.6)),
  smartMoneyCopyMedianWeight: Math.max(
    0,
    Number(process.env.SMART_MONEY_COPY_MEDIAN_WEIGHT ?? 0.4)
  ),
  /** true：榜表 copyabilityScore 写 60/40 综合分；false：仍写纯 RT（综合分仅进 explain） */
  smartMoneyCopyCompositeAsPrimary: getBooleanEnv(
    'SMART_MONEY_COPY_COMPOSITE_AS_PRIMARY',
    true
  ),
  /** 入池/展示：综合分下限（替代旧 >0） */
  smartMoneyCopyPoolMinComposite: Math.max(
    0,
    Math.min(100, Number(process.env.SMART_MONEY_COPY_POOL_MIN_COMPOSITE ?? 25))
  ),
  smartMoneyCopyMedianScoreLo: Number(process.env.SMART_MONEY_COPY_MEDIAN_SCORE_LO ?? -0.05),
  smartMoneyCopyMedianScoreHi: Number(process.env.SMART_MONEY_COPY_MEDIAN_SCORE_HI ?? 0.25),
  smartMoneyCopyMedianNeutral: Math.max(
    0,
    Math.min(100, Number(process.env.SMART_MONEY_COPY_MEDIAN_NEUTRAL ?? 40))
  ),
  smartMoneyCopyMedianShrinkK: Math.max(
    1,
    Number(process.env.SMART_MONEY_COPY_MEDIAN_SHRINK_K ?? 8)
  ),
  smartMoneyCopyMedianMinN: Math.max(1, Number(process.env.SMART_MONEY_COPY_MEDIAN_MIN_N ?? 3)),
  smartMoneyCopyMedianGapMean: Math.max(
    0,
    Number(process.env.SMART_MONEY_COPY_MEDIAN_GAP_MEAN ?? 0.15)
  ),
  smartMoneyCopyMedianGapTotal: Math.max(
    0,
    Number(process.env.SMART_MONEY_COPY_MEDIAN_GAP_TOTAL ?? 0.2)
  ),
  smartMoneyCopyMedianPenaltyCap: Math.max(
    0,
    Math.min(100, Number(process.env.SMART_MONEY_COPY_MEDIAN_PENALTY_CAP ?? 40))
  ),
  /**
   * 峰权益 MDD ≥ 该值视为测算饱和（假 100%）：展示「-」，L1-DD 跳过。
   * 真回撤（如 0.48）仍走 maxDD ≤ 回报率。
   */
  smartMoneyMddSaturation: Math.max(
    0.9,
    Math.min(1, Number(process.env.SMART_MONEY_MDD_SATURATION ?? 0.999))
  ),
  /** Light 稀疏豁免：生涯 PnL ≥ 该值（0=关闭该腿） */
  smartMoneyLightSparseExemptMinPnl: Math.max(
    0,
    Number(process.env.SMART_MONEY_LIGHT_SPARSE_EXEMPT_MIN_PNL ?? 10_000)
  ),
  /** Light 稀疏豁免：生涯成交额 ≥ 该值（0=关闭该腿） */
  smartMoneyLightSparseExemptMinVolume: Math.max(
    0,
    Number(process.env.SMART_MONEY_LIGHT_SPARSE_EXEMPT_MIN_VOLUME ?? 100_000)
  ),
  /** 近 30d 笔均名义额低于该值 → MICRO_CLIP_TRADING（Phase G 默认 40） */
  smartMoneyMinAvgTradeNotionalUsd: Math.max(
    0,
    Number(process.env.SMART_MONEY_MIN_AVG_TRADE_NOTIONAL_USD ?? 40)
  ),
  /** 成交价落在窄边区间的占比阈值 → NARROW_EDGE_ENTRY（Phase G 默认 0.5） */
  smartMoneyNarrowEdgeEntryShare: Math.max(
    0,
    Math.min(1, Number(process.env.SMART_MONEY_NARROW_EDGE_ENTRY_SHARE ?? 0.5))
  ),
  /** 开仓数 ≥ 该值且中位名义过小 → DUST_POSITION_SPRAY */
  smartMoneyDustPositionMinCount: Math.max(
    1,
    Number(process.env.SMART_MONEY_DUST_POSITION_MIN_COUNT ?? 80)
  ),
  smartMoneyDustPositionMaxMedianUsd: Math.max(
    0,
    Number(process.env.SMART_MONEY_DUST_POSITION_MAX_MEDIAN_USD ?? 30)
  ),
  /** 开仓品类 Top1 占比 ≥ 该值 → CATEGORY_MONOCULTURE */
  smartMoneyMaxCategoryShare: Math.max(
    0,
    Math.min(1, Number(process.env.SMART_MONEY_MAX_CATEGORY_SHARE ?? 0.85))
  ),
  smartMoneyCategoryMonocultureMinPositions: Math.max(
    1,
    Number(process.env.SMART_MONEY_CATEGORY_MONOCULTURE_MIN_POSITIONS ?? 50)
  ),
  /** predictionCount / max(账户天数,7) 超过该值 → LIKELY_BOT 密度信号 */
  smartMoneyMaxPredictionsPerDayDensity: Math.max(
    1,
    Number(process.env.SMART_MONEY_MAX_PREDICTIONS_PER_DAY_DENSITY ?? 40)
  ),
  /** Enrich 后 copyability 低于该值：历史踢池阈值（F7 起不再驱动踢除，仅保留兼容） */
  smartMoneyMinCopyabilityForPool: Math.max(
    0,
    Math.min(100, Number(process.env.SMART_MONEY_MIN_COPYABILITY_FOR_POOL ?? 35))
  ),
  /** F7：是否因低 copyability 踢出 CopyPool（默认 false） */
  smartMoneyCopyabilityKickOnLowScore: getBooleanEnv(
    'SMART_MONEY_COPYABILITY_KICK_ON_LOW_SCORE',
    false
  ),
  smartMoneyBlacklistWallets: getWalletListEnv('SMART_MONEY_BLACKLIST_WALLETS'),
  smartMoneyBlacklistTags: getStringListEnv('SMART_MONEY_BLACKLIST_TAGS'),

  /**
   * 服务间鉴权：POST /api/internal/copy-trade/leader-signal（Header: X-Internal-Secret）。
   * 与消息服环境变量 COPYTRADE_BACKEND_INTERNAL_SECRET 使用相同值。
   */
  copyInternalSecret: (process.env.COPY_INTERNAL_SECRET ?? '').trim(),
  virtualCopyAccountsEnabled: getBooleanEnv('VIRTUAL_COPY_ACCOUNTS_ENABLED', !isProd()),
  virtualCopyExecutionEnabled: getBooleanEnv('VIRTUAL_COPY_EXECUTION_ENABLED', !isProd()),
  virtualCopyOrderBookFillEnabled: getBooleanEnv('VIRTUAL_COPY_ORDERBOOK_FILL_ENABLED', !isProd()),
  virtualCopySettlementEnabled: getBooleanEnv('VIRTUAL_COPY_SETTLEMENT_ENABLED', false),
  virtualCopyBuyEnabled: getBooleanEnv('VIRTUAL_COPY_BUY_ENABLED', !isProd()),
  virtualCopyActiveAccountQuota: Math.max(
    1,
    Number(process.env.VIRTUAL_COPY_ACTIVE_ACCOUNT_QUOTA ?? 20),
  ),
  virtualCopyActiveSubscriptionQuota: Math.max(
    1,
    Number(process.env.VIRTUAL_COPY_ACTIVE_SUBSCRIPTION_QUOTA ?? 200),
  ),
  virtualCopyFanoutLimit: Math.max(
    1,
    Number(process.env.VIRTUAL_COPY_FANOUT_LIMIT ?? 1_000),
  ),
  virtualCopyRateLimitWindowMs: Math.max(
    1_000,
    Number(process.env.VIRTUAL_COPY_RATE_LIMIT_WINDOW_MS ?? 60_000),
  ),
  virtualCopyAccountCreateRateLimit: Math.max(
    1,
    Number(process.env.VIRTUAL_COPY_ACCOUNT_CREATE_RATE_LIMIT ?? 10),
  ),
  virtualCopyAccountCreateIpRateLimit: Math.max(
    1,
    Number(process.env.VIRTUAL_COPY_ACCOUNT_CREATE_IP_RATE_LIMIT ?? 30),
  ),
  virtualCopySubscriptionRateLimit: Math.max(
    1,
    Number(process.env.VIRTUAL_COPY_SUBSCRIPTION_RATE_LIMIT ?? 30),
  ),
  virtualCopySubscriptionIpRateLimit: Math.max(
    1,
    Number(process.env.VIRTUAL_COPY_SUBSCRIPTION_IP_RATE_LIMIT ?? 100),
  ),
  virtualCopyCloseRateLimit: Math.max(
    1,
    Number(process.env.VIRTUAL_COPY_CLOSE_RATE_LIMIT ?? 30),
  ),
  virtualCopyCloseIpRateLimit: Math.max(
    1,
    Number(process.env.VIRTUAL_COPY_CLOSE_IP_RATE_LIMIT ?? 100),
  ),
  /** 模拟执行只读取公共 CLOB/Gamma；请求超时不允许回退公式成交。 */
  virtualCopyMarketDataTimeoutMs: Math.max(
    1_000,
    Number(process.env.VIRTUAL_COPY_MARKET_DATA_TIMEOUT_MS ?? 8_000),
  ),
  virtualCopyMarkStaleMs: Math.max(
    1_000,
    Number(process.env.VIRTUAL_COPY_MARK_STALE_MS ?? 60_000),
  ),
  virtualCopyDefaultMaxSlippage: Math.max(
    0,
    Math.min(0.5, Number(process.env.VIRTUAL_COPY_DEFAULT_MAX_SLIPPAGE ?? 0.05)),
  ),
  /** LINEAR_NOTIONAL_V1：买卖两侧均按成交毛名义金额计费。 */
  virtualCopyFeeModelVersion: 'LINEAR_NOTIONAL_V1' as const,
  virtualCopyFeeRate: Math.max(
    0,
    Math.min(1, Number(process.env.VIRTUAL_COPY_FEE_RATE ?? 0.002)),
  ),
  virtualCopyManualCloseMaxSlippage: Math.max(
    0,
    Math.min(0.5, Number(process.env.VIRTUAL_COPY_MANUAL_CLOSE_MAX_SLIPPAGE ?? 0.05)),
  ),
  virtualCopyCloseQuoteTtlMs: Math.max(
    5_000,
    Math.min(120_000, Number(process.env.VIRTUAL_COPY_CLOSE_QUOTE_TTL_MS ?? 30_000)),
  ),
  virtualCopyClaimLeaseMs: Math.max(
    30_000,
    Number(process.env.VIRTUAL_COPY_CLAIM_LEASE_MS ?? 120_000),
  ),
  virtualCopyWorkerConcurrency: Math.max(
    1,
    Math.min(32, Number(process.env.VIRTUAL_COPY_WORKER_CONCURRENCY ?? 8)),
  ),
  virtualCopyExecutionIntervalMs: Math.max(
    1_000,
    Number(process.env.VIRTUAL_COPY_EXECUTION_INTERVAL_MS ?? 5_000),
  ),
  virtualCopyLifecycleIntervalMs: Math.max(
    60_000,
    Number(process.env.VIRTUAL_COPY_LIFECYCLE_INTERVAL_MS ?? 300_000),
  ),
  virtualCopyReconciliationIntervalMs: Math.max(
    60_000,
    Number(process.env.VIRTUAL_COPY_RECONCILIATION_INTERVAL_MS ?? 300_000),
  ),
  ctfExchangeAddress:
    process.env.CTF_EXCHANGE_ADDRESS ?? '0xE111180000d2663C0091e4f400237545B87B996B',
  negRiskCtfExchangeAddress:
    process.env.NEG_RISK_CTF_EXCHANGE_ADDRESS ?? '0xe2222d279d744050d28e00520010520000310F59',
  /** 逗号分隔，用于判断链上 assetId 是否为抵押品（USDC）腿，以推断买卖方向 */
  collateralAssetIds: (process.env.COLLATERAL_ASSET_IDS ?? '0')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  copyDispatchConcurrency: Math.max(1, Number(process.env.COPY_DISPATCH_CONCURRENCY ?? 20)),
  copyDispatchWorkerConcurrency: Math.max(
    1,
    Number(process.env.COPY_DISPATCH_WORKER_CONCURRENCY ?? 4)
  ),
  /** copy-worker NATS 消费的本地待执行队列上限；超过后丢给 DB replay 兜底，避免内存无限增长。 */
  copyDispatchWorkerQueueMax: Math.max(
    1,
    Number(process.env.COPY_DISPATCH_WORKER_QUEUE_MAX ?? 1000)
  ),
  copyDispatchQueueShards: Math.max(1, Math.min(64, Number(process.env.COPY_DISPATCH_QUEUE_SHARDS ?? 4))),
  copyRetrySweepIntervalMs: Number(process.env.COPY_RETRY_SWEEP_INTERVAL_MS ?? 60_000),
  /**
   * 跟单单笔最大失败次数上限（非「额外重试 N 次」）。
   * 例：COPY_MAX_RETRIES=3 → 最多 3 次下单尝试；首次失败后最多再自动重试 2 次（retryCount 到 3 转 dead）。
   */
  copyMaxRetries: Math.max(0, Number(process.env.COPY_MAX_RETRIES ?? 5)),
  /** sweep 重试指数退避基数（毫秒） */
  copyRetryBaseDelayMs: Math.max(0, Number(process.env.COPY_RETRY_BASE_DELAY_MS ?? 2000)),
  /** sweep 重试指数退避上限（毫秒） */
  copyRetryMaxDelayMs: Math.max(
    0,
    Number(process.env.COPY_RETRY_MAX_DELAY_MS ?? 120_000)
  ),
  /**
   * @deprecated 资金类错误已不可重试；保留配置项兼容旧 .env，sweep 不再使用。
   */
  copyCollateralRetryDelayMs: Math.max(0, Number(process.env.COPY_COLLATERAL_RETRY_DELAY_MS ?? 3500)),
  copyFailStreakMode: getCopyFailStreakMode(),
  copyFailStreakMax: Math.max(1, Number(process.env.COPY_FAIL_STREAK_MAX ?? 10)),
  copyFailStreakCooldownMs: Math.max(
    60_000,
    Number(process.env.COPY_FAIL_STREAK_COOLDOWN_MS ?? 3_600_000)
  ),
  copyBuyMinNotionalUsd: Math.max(1, Number(process.env.COPY_BUY_MIN_NOTIONAL_USD ?? 1)),
  /** 开启跟单：Polymarket 保证金 USDC 须 ≥ 该值，或平台 Gas 余额 > 0 */
  copyMinFundingUsdc: Math.max(0, Number(process.env.COPY_MIN_FUNDING_USDC ?? 10)),
  /** 跟单「今日收益」统计时区（IANA） */
  copyPnlDayTimezone: (process.env.COPY_PNL_DAY_TIMEZONE ?? 'Asia/Shanghai').trim() || 'Asia/Shanghai',
  /** 跟单「今日收益」每日重置时刻（0–23，该时区内的小时，默认 8 即早上 8 点） */
  copyPnlDayResetHour: Math.min(23, Math.max(0, Number(process.env.COPY_PNL_DAY_RESET_HOUR ?? 8))),
  copyBuyMinNotionalBufferRatio: getCopyBuyMinNotionalBufferRatio(),
  copyBuyMaxAmountToleranceRatio: getCopyBuyMaxAmountToleranceRatio(),
  /** 跟单默认滑点（相对值，如 0.05 = 5%）；用于用户未显式配置时的兜底 */
  copyDefaultSlippage: getCopyDefaultSlippage(),
  /** 跟单行卡在 submitting 超过该毫秒则视为僵尸，dispatch 时重置为 failed（避免进程崩溃后永远卡住） */
  copyStaleSubmittingMs: Math.max(30_000, Number(process.env.COPY_STALE_SUBMITTING_MS ?? 180_000)),
  /** 单个 LeaderTrade 派发最多等待多久；超时后释放 worker 并依赖 DB replay/僵尸行扫描恢复。 */
  copyDispatchTimeoutMs: Math.max(5_000, Number(process.env.COPY_DISPATCH_TIMEOUT_MS ?? 60_000)),
  /** 市场白名单，空表示不限制 */
  copyMarketWhitelist: (process.env.COPY_MARKET_WHITELIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  copyDailyNotionalCapUsd: process.env.COPY_DAILY_NOTIONAL_CAP_USD
    ? Number(process.env.COPY_DAILY_NOTIONAL_CAP_USD)
    : undefined,
  tradingSystemMode: getTradingSystemMode(),
  /** 如 demo_custodial：仅允许服务端托管钱包作为 CLOB 执行钱包 */
  tradingExecutionMode: getTradingExecutionMode(),
  /**
   * 为 true 时开放「平台钱包」交易接口：POST/DELETE /api/trade/orders、GET /orders、GET /trades。
   * 生产环境默认关闭；仅在内网或明确需要时启用。
   */
  enablePlatformTradeRoutes: getEnablePlatformTradeRoutes(),
  /**
   * 为 true 时开放「下单实验室」：GET/POST /api/trade/lab/*（需登录 + API Key）。
   * 默认 false；生产环境务必保持 false，除非明确要暴露。
   */
  enableOrderLab: getBooleanEnv('ENABLE_ORDER_LAB', false),
  /** 平台 CLOB 下单扣 Gas 所用用户 ID（须提前为该用户充值 Gas） */
  platformGasUserId: getPlatformGasUserId(),

  /**
   * 为 true 时，用户买单（BUY）在校验 Polymarket deposit 抵押前，自动将托管地址 USDC.e 按缺口划至 deposit（并等待链上确认）。
   * 设为 false 则与旧行为一致，需用户手动 POST /api/custody/fund-polymarket-deposit。
   */
  /** 默认关闭：单一 Deposit Wallet 入金模式下买单应直接充 USDC.e 至 deposit，而非从托管地址自动划转 */
  autoFundPolymarketDeposit: getBooleanEnv('AUTO_FUND_POLYMARKET_DEPOSIT', false),
  /**
   * 为 true（默认）时：检测到 Polymarket deposit 上有 USDC.e 则通过 Relayer 自动 wrap 为 pUSD（入金同步、查余额、托管划转入金后触发）。
   * 设为 false 则仅在下买单时由 ensureDepositPusdReady 按需 wrap。
   */
  autoWrapPolymarketDepositUsdce: getBooleanEnv('AUTO_WRAP_POLYMARKET_DEPOSIT_USDCE', true),
  /**
   * 启用 Polymarket 官方 Bridge API 为用户生成桥接充值地址（推荐原生 USDC / 跨链入金）。
   * @see https://docs.polymarket.com/cn/trading/bridge/deposit
   */
  polymarketBridgeDepositEnabled: getBooleanEnv('POLYMARKET_BRIDGE_DEPOSIT_ENABLED', true),
  polymarketBridgeUrl: (process.env.POLYMARKET_BRIDGE_URL ?? 'https://bridge.polymarket.com').trim(),
  /** /supported-assets 进程内缓存（ms） */
  polymarketBridgeSupportedAssetsCacheMs: (() => {
    const n = Number(process.env.POLYMARKET_BRIDGE_SUPPORTED_ASSETS_CACHE_MS ?? 300_000);
    return Number.isFinite(n) ? Math.max(60_000, Math.floor(n)) : 300_000;
  })(),
  /**
   * EOA 入账原生 USDC 自动归集至 Polymarket Bridge evm 地址（非 deposit）；默认 true。
   */
  polymarketBridgeEoaNativeForward: getBooleanEnv('POLYMARKET_BRIDGE_EOA_NATIVE_FORWARD', true),
  /**
   * 自动补款时，在买单估算 maker 金额之上追加的 USDC 最小单位（6 decimals）。默认 10000 = $0.01，降低 tick 舍入导致 CLOB 仍报余额不足的概率。
   */
  polyDepositAutoFundBufferRaw: (() => {
    const raw = Number(process.env.POLY_DEPOSIT_AUTO_FUND_BUFFER_RAW ?? 10_000);
    const n = Number.isFinite(raw) ? Math.floor(raw) : 10_000;
    return Math.max(0, Math.min(1_000_000, n));
  })(),
  /** SELL 前 relayer/链上授权检查缓存（ms）；热路径命中可省 ~1s+ */
  polyDepositSellPrepCacheMs: (() => {
    const n = Number(process.env.POLY_DEPOSIT_SELL_PREP_CACHE_MS ?? 365 * 24 * 60 * 60_000);
    return Number.isFinite(n)
      ? Math.max(0, Math.min(365 * 24 * 60 * 60_000, Math.floor(n)))
      : 365 * 24 * 60 * 60_000;
  })(),
  /** SELL 授权准备的 DB 持久化缓存 TTL；用于跨重启/多进程复用 deposit 长期授权状态。 */
  polyDepositSellPrepDbCacheMs: (() => {
    const n = Number(process.env.POLY_DEPOSIT_SELL_PREP_DB_CACHE_MS ?? 365 * 24 * 60 * 60_000);
    return Number.isFinite(n)
      ? Math.max(0, Math.min(365 * 24 * 60 * 60_000, Math.floor(n)))
      : 365 * 24 * 60 * 60_000;
  })(),
  /** BUY 前 CLOB pUSD 同步缓存（ms） */
  polyDepositPusdSyncCacheMs: (() => {
    const n = Number(process.env.POLY_DEPOSIT_PUSD_SYNC_CACHE_MS ?? 180_000);
    return Number.isFinite(n) ? Math.max(0, Math.min(3_600_000, Math.floor(n))) : 180_000;
  })(),
  /** copy SELL 持仓 Data API 查询缓存（ms） */
  copyPositionsCacheMs: (() => {
    const n = Number(process.env.COPY_POSITIONS_CACHE_MS ?? 45_000);
    return Number.isFinite(n) ? Math.max(0, Math.min(600_000, Math.floor(n))) : 45_000;
  })(),
  /** resend | gmail_smtp */
  emailProvider: getEmailProvider(),
  /** Resend API key (EMAIL_PROVIDER=resend) */
  resendApiKey: (process.env.RESEND_API_KEY ?? '').trim(),
  /** From header, e.g. CopyOdds <you@gmail.com> */
  mailFrom: (process.env.MAIL_FROM ?? '').trim(),
  /** HMAC pepper for email code hashing; falls back to JWT_SECRET */
  emailCodePepper: (process.env.EMAIL_CODE_PEPPER ?? process.env.JWT_SECRET ?? '').trim(),
  /** AES-256-GCM key for TOTP secrets at rest (32-byte hex or base64); do not reuse JWT_SECRET */
  totpSecretEncryptionKey: (process.env.TOTP_SECRET_ENCRYPTION_KEY ?? '').trim(),
  /** TOTP issuer shown in Authenticator apps */
  totpIssuer: (process.env.TOTP_ISSUER ?? process.env.PASSKEY_RP_NAME ?? 'CopyOdds').trim(),
  smtpHost: (process.env.SMTP_HOST ?? 'smtp.gmail.com').trim(),
  smtpPort: Math.max(1, Number(process.env.SMTP_PORT ?? 465) || 465),
  smtpSecure: (process.env.SMTP_SECURE ?? 'true').trim().toLowerCase() === 'true',
  smtpUser: (process.env.SMTP_USER ?? '').trim(),
  smtpPass: (process.env.SMTP_PASS ?? '').trim(),
  /**
   * Resend 未验证域名时的测试模式（仅 EMAIL_PROVIDER=resend 生效）。
   * 默认：MAIL_FROM 含 resend.dev 时为 true。
   */
  emailCodeTestMode: (() => {
    if (getEmailProvider() !== 'resend') {
      return false;
    }
    const raw = (process.env.EMAIL_CODE_TEST_MODE ?? '').trim().toLowerCase();
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    const mailFrom = (process.env.MAIL_FROM ?? 'onboarding@resend.dev').trim();
    return mailFrom.includes('resend.dev');
  })(),
  emailCodeTestTo: (process.env.EMAIL_CODE_TEST_TO ?? '').trim().toLowerCase(),

  /** 验证码：同邮箱同类型发送冷却（秒） */
  emailCodeSendCooldownSec: Math.max(
    30,
    Number(process.env.EMAIL_CODE_SEND_COOLDOWN_SEC ?? 60) || 60
  ),
  /** 注册验证码：单邮箱每日上限 */
  emailCodeDailyRegisterMax: Math.max(
    3,
    Number(process.env.EMAIL_CODE_DAILY_REGISTER_MAX ?? 8) || 8
  ),
  /** 登录验证码：单邮箱每日上限（无密码登录，适当放宽） */
  emailCodeDailyLoginMax: Math.max(
    5,
    Number(process.env.EMAIL_CODE_DAILY_LOGIN_MAX ?? 24) || 24
  ),
  /** 注册+登录合计：单邮箱每日上限 */
  emailCodeDailyCombinedMax: Math.max(
    10,
    Number(process.env.EMAIL_CODE_DAILY_COMBINED_MAX ?? 30) || 30
  ),
  /** 单 IP 每小时发码上限（CDN/公司 NAT 场景需放宽） */
  emailCodeIpHourlyMax: Math.max(
    20,
    Number(process.env.EMAIL_CODE_IP_HOURLY_MAX ?? 80) || 80
  ),

  /** NATS（robot 控制面热更新；与 copytrade-messaging 共用 broker） */
  natsUrl: (process.env.NATS_URL ?? 'nats://127.0.0.1:4222').trim(),
  robotControlNatsEnabled: (() => {
    const raw = process.env.COPY_ROBOT_CONTROL_NATS_ENABLED?.trim().toLowerCase();
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    // 与 natsUrl 默认一致：未显式关闭则启用（避免有默认 URL 却仍判定 disabled）
    return true;
  })(),
  natsClientName: process.env.NATS_CLIENT_NAME?.trim() || 'polymarket-backend',
  /** copy-worker：未处理 LeaderTrade DB replay 扫描间隔（毫秒） */
  copyDispatchReplayIntervalMs: Math.max(
    30_000,
    Number(process.env.COPY_DISPATCH_REPLAY_INTERVAL_MS ?? 120_000)
  ),
  /** replay 优先处理最近窗口内的新信号，避免历史积压挡住最新跟单。 */
  copyDispatchReplayHotWindowMs: Math.max(
    60_000,
    Number(process.env.COPY_DISPATCH_REPLAY_HOT_WINDOW_MS ?? 10 * 60_000)
  ),
  /** 每轮 replay 留给历史积压 backfill 的比例，其余额度优先给 hot window。 */
  copyDispatchReplayBackfillRatio: (() => {
    const raw = Number(process.env.COPY_DISPATCH_REPLAY_BACKFILL_RATIO ?? 0.2);
    if (!Number.isFinite(raw)) return 0.2;
    return Math.max(0, Math.min(0.8, raw));
  })(),
  /** replay 自动归档过旧且无任何 copy row 的信号前等待多久；0 表示关闭自动归档。 */
  copyDispatchReplayArchiveNoRowAfterMs: Math.max(
    0,
    Number(process.env.COPY_DISPATCH_REPLAY_ARCHIVE_NO_ROW_AFTER_MS ?? 6 * 60 * 60_000)
  ),
  copyDispatchReplayLookbackHours: Math.max(
    1,
    Number(process.env.COPY_DISPATCH_REPLAY_LOOKBACK_HOURS ?? 48)
  ),
  copyDispatchReplayLimit: Math.max(1, Math.min(500, Number(process.env.COPY_DISPATCH_REPLAY_LIMIT ?? 100))),
};

if (CONFIG.emailProvider === 'gmail_smtp') {
  console.info(
    `[env] Email verification via Gmail SMTP (${CONFIG.smtpHost}:${CONFIG.smtpPort}, user=${CONFIG.smtpUser || '(unset)'})`,
  );
}

if (CONFIG.emailProvider === 'resend' && CONFIG.emailCodeTestMode) {
  if (!CONFIG.emailCodeTestTo) {
    console.warn(
      '[env] EMAIL_CODE_TEST_MODE is on but EMAIL_CODE_TEST_TO is empty — Resend verification emails will fail.',
    );
  } else {
    console.warn(
      `[env] Resend TEST MODE: codes are sent to ${CONFIG.emailCodeTestTo} only (not to the address users enter).`,
    );
  }
}

function isValidPolygonAddressEnv(s: string): boolean {
  const t = s.trim();
  return /^0x[a-fA-F0-9]{40}$/.test(t);
}

/**
 * Gas/档位购买收款与佣金领取打款源；未设置或格式非法则进程立即退出。
 * 须与 Go wallet `security.treasury_address`（mnemonicWithdraw 派生）及
 * `security.platform_usdce_transfer_recipients` 一致；该地址需持有 USDC.e + POL gas。
 */
(() => {
  const raw = (process.env.CUSTODY_TREASURY_ADDRESS ?? '').trim();
  if (!raw || !isValidPolygonAddressEnv(raw)) {
    console.error(
      '[env] CUSTODY_TREASURY_ADDRESS is required: set a valid Polygon address (0x + 40 hex chars). Example: CUSTODY_TREASURY_ADDRESS=0x...',
    );
    process.exit(1);
  }
})();

if ((process.env.GO_WALLET_TREASURY_WALLET_INDEX ?? '').trim() !== '') {
  console.warn(
    '[env] GO_WALLET_TREASURY_WALLET_INDEX is ignored: use CUSTODY_TREASURY_ADDRESS matching Go security.treasury_address. Remove it from env to silence this.',
  );
}

if ((process.env.CUSTODY_TREASURY_PRIVATE_KEY ?? '').trim() !== '') {
  console.warn(
    '[env] CUSTODY_TREASURY_PRIVATE_KEY is unused: treasury signing is in Go wallet (mnemonicWithdraw). Remove it from env to silence this.',
  );
}

if ((process.env.SETTLEMENT_AUTHORIZER_URL ?? '').trim() !== '' || (process.env.SETTLEMENT_AUTHORIZER_TOKEN ?? '').trim() !== '') {
  console.warn(
    '[env] SETTLEMENT_AUTHORIZER_* is removed (treasury whitelist + ledger commissions). Remove these vars to silence this.',
  );
}

/**
 * 出站 HTTP 服务 URL：
 * - GO_WALLET_SERVICE_URL：允许 http://127.0.0.1|localhost 或 http://RFC1918 内网字面量（同机/分机）
 * - 其它：生产须 HTTPS 且禁止私网/metadata
 */
export async function validateEnvOutboundUrlsAtStartup(): Promise<void> {
  const goUrl = (process.env.GO_WALLET_SERVICE_URL ?? '').trim();
  if (goUrl) {
    await validateOutboundServiceUrl('GO_WALLET_SERVICE_URL', goUrl);
  }

  const relayerUrl = (process.env.POLYMARKET_RELAYER_URL ?? '').trim();
  if (relayerUrl) {
    await validateOutboundServiceUrl('POLYMARKET_RELAYER_URL', relayerUrl);
  }
}

const envOutboundUrlValidationPromise = validateEnvOutboundUrlsAtStartup().catch((err) => {
  const msg = err instanceof SsrfBlockedError ? err.message : String(err);
  console.error(`[env] ${msg}`);
  process.exit(1);
});

/** 在 HTTP 服务监听前 await，确保 SSRF 相关 env URL 已校验 */
export function awaitEnvOutboundUrlValidation(): Promise<void> {
  return envOutboundUrlValidationPromise;
}

const _rpcUrlForSsrfWarn = (process.env.RPC_URL ?? '').trim();
if (_rpcUrlForSsrfWarn.startsWith('http://') && !/localhost|127\.0\.0\.1/i.test(_rpcUrlForSsrfWarn)) {
  console.warn(
    '[env] RPC_URL uses http:// to a non-local host; prefer https:// for operator-configured endpoints (RPC not fully SSRF-validated).',
  );
}

function getEnablePlatformTradeRoutes(): boolean {
  if (isProd()) {
    return process.env.ENABLE_PLATFORM_TRADE_ROUTES === 'true';
  }
  return process.env.ENABLE_PLATFORM_TRADE_ROUTES !== 'false';
}

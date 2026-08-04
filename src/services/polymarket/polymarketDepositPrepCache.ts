/**
 * 进程内缓存：deposit 侧 SELL 授权检查 / BUY pUSD CLOB 同步。
 * 降低 copy 热路径上重复的 relayer 注册与链上 allowance 扫描。
 */

const sellApprovalsReady = new Map<string, number>();
const pusdClobSynced = new Map<string, { at: number; minBalanceRaw: bigint }>();

function depositKey(deposit: string): string {
  return deposit.trim().toLowerCase();
}

export function isSellApprovalsPrepCached(deposit: string, ttlMs: number): boolean {
  const at = sellApprovalsReady.get(depositKey(deposit));
  return at != null && Date.now() - at < ttlMs;
}

export function markSellApprovalsPrepCached(deposit: string): void {
  sellApprovalsReady.set(depositKey(deposit), Date.now());
}

export function invalidateSellApprovalsPrepCache(deposit: string): void {
  sellApprovalsReady.delete(depositKey(deposit));
}

export function isPusdClobSyncCached(
  deposit: string,
  requiredRaw: bigint,
  ttlMs: number
): boolean {
  const hit = pusdClobSynced.get(depositKey(deposit));
  if (!hit || Date.now() - hit.at >= ttlMs) {
    return false;
  }
  return hit.minBalanceRaw >= requiredRaw;
}

export function markPusdClobSyncCached(deposit: string, verifiedBalanceRaw: bigint): void {
  const k = depositKey(deposit);
  const prev = pusdClobSynced.get(k);
  const minBalanceRaw =
    prev && Date.now() - prev.at < 3_600_000
      ? verifiedBalanceRaw > prev.minBalanceRaw
        ? verifiedBalanceRaw
        : prev.minBalanceRaw
      : verifiedBalanceRaw;
  pusdClobSynced.set(k, { at: Date.now(), minBalanceRaw });
}

export function invalidatePusdClobSyncCache(deposit: string): void {
  pusdClobSynced.delete(depositKey(deposit));
}

export function invalidateDepositPrepCache(deposit: string): void {
  const k = depositKey(deposit);
  sellApprovalsReady.delete(k);
  pusdClobSynced.delete(k);
}

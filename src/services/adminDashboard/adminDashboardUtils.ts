import type {
  DashboardActivity,
  DashboardExecutionTrendPoint,
  DashboardOverviewTrend,
  DashboardSystemUptimePoint,
  DashboardTopLeader,
  LeaderRiskLevel,
} from './types';

export const ROI_MAX_NORMAL = 10_000;
export const ROI_MIN_NORMAL = -100;
export const TOP_LEADERS_LIMIT = 5;
export const ACTIVITIES_LIMIT = 10;
export const TREND_DAYS = 7;
export const SYNC_ERROR_FRESHNESS_SECONDS = 30 * 60;
export const SYNC_RECENT_SECONDS = 5 * 60;

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function clampPercent(n: number): number {
  if (!Number.isFinite(n)) {
    return 0;
  }
  return Math.min(100, Math.max(0, n));
}

export function computeOverviewTrend(todayTotal: number, yesterdayTotal: number | null): DashboardOverviewTrend {
  if (yesterdayTotal == null) {
    return { dayChange: 0, dayChangePercent: 0 };
  }
  const dayChange = todayTotal - yesterdayTotal;
  const dayChangePercent =
    yesterdayTotal > 0 ? round2((dayChange / yesterdayTotal) * 100) : 0;
  return { dayChange, dayChangePercent };
}

export function formatMmDd(date: Date): string {
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${m}-${d}`;
}

export function lastNDaysUtc(n: number): Date[] {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const days: Date[] = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    days.push(new Date(today.getTime() - i * 24 * 60 * 60 * 1000));
  }
  return days;
}

export function buildExecutionTrend(
  dailyByDate: Map<string, { success: number; failed: number }>
): DashboardExecutionTrendPoint[] {
  return lastNDaysUtc(TREND_DAYS).map((day) => {
    const key = day.toISOString().slice(0, 10);
    const row = dailyByDate.get(key) ?? { success: 0, failed: 0 };
    const total = row.success + row.failed;
    const successRate = total > 0 ? round1((row.success / total) * 100) : 0;
    return {
      date: formatMmDd(day),
      successCount: row.success,
      failureCount: row.failed,
      successRate,
    };
  });
}

export function buildDailyMetricsTrend(
  dailyByDate: Map<
    string,
    { registeredUsers: number; onlineUsers: number; subscribedAddresses: number; gasPurchases: number }
  >
): Array<{
  date: string;
  registeredUsers: number;
  onlineUsers: number;
  subscribedAddresses: number;
  gasPurchases: number;
}> {
  return lastNDaysUtc(TREND_DAYS).map((day) => {
    const key = day.toISOString().slice(0, 10);
    const row =
      dailyByDate.get(key) ?? {
        registeredUsers: 0,
        onlineUsers: 0,
        subscribedAddresses: 0,
        gasPurchases: 0,
      };
    return {
      date: formatMmDd(day),
      registeredUsers: row.registeredUsers,
      onlineUsers: row.onlineUsers,
      subscribedAddresses: row.subscribedAddresses,
      gasPurchases: row.gasPurchases,
    };
  });
}

export function buildUptimeHistory(
  dailyUptimeByDate: Map<string, number>,
  fallbackPercent: number
): DashboardSystemUptimePoint[] {
  const fallback = clampPercent(fallbackPercent);
  return lastNDaysUtc(TREND_DAYS).map((day) => {
    const key = day.toISOString().slice(0, 10);
    const raw = dailyUptimeByDate.get(key);
    const value = raw != null ? clampPercent(raw) : fallback;
    return { date: formatMmDd(day), value: round1(value) };
  });
}

export function formatRuntimeDuration(startedAtMs: number | null, nowMs = Date.now()): string {
  if (startedAtMs == null || !Number.isFinite(startedAtMs) || startedAtMs > nowMs) {
    return '-';
  }
  const totalMinutes = Math.floor((nowMs - startedAtMs) / 60_000);
  if (totalMinutes < 1) {
    return '不足1分钟';
  }
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return hours > 0 ? `${days}天${hours}小时` : `${days}天`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}小时${minutes}分钟` : `${hours}小时`;
  }
  return `${minutes}分钟`;
}

export type SyncStatus = 'syncing' | 'idle' | 'error';

export function resolveSyncStatus(
  freshnessSeconds: number | null,
  syncError?: boolean
): SyncStatus {
  if (syncError || freshnessSeconds == null) {
    return 'error';
  }
  if (freshnessSeconds > SYNC_ERROR_FRESHNESS_SECONDS) {
    return 'error';
  }
  if (freshnessSeconds <= SYNC_RECENT_SECONDS) {
    return 'syncing';
  }
  return 'idle';
}

export function normalizeNodeStatus(raw: string | undefined): string {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'healthy' || v === 'ok' || v === 'up') {
    return 'healthy';
  }
  if (v === 'warning' || v === 'degraded' || v === 'warn') {
    return 'warning';
  }
  if (v === 'error' || v === 'down' || v === 'critical') {
    return 'error';
  }
  if (v === 'unknown' || v === '') {
    return 'unknown';
  }
  return 'unknown';
}

export function normalizeSystemMode(raw: string | undefined): string {
  const v = (raw ?? '').trim().toUpperCase();
  if (v === 'NORMAL' || v === 'TRACK_ONLY' || v === 'PAUSED') {
    return v;
  }
  const match = /MODE=(\w+)/i.exec(raw ?? '');
  if (match) {
    const mode = match[1].toUpperCase();
    if (mode === 'NORMAL' || mode === 'TRACK_ONLY' || mode === 'PAUSED') {
      return mode;
    }
  }
  return 'NORMAL';
}

export function formatCommissionUsdt(raw: string | undefined): string {
  if (raw == null || raw.trim() === '') {
    return '0.00';
  }
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) {
    return '0.00';
  }
  return n.toFixed(2);
}

export function isAbnormalRoi(roi: number): boolean {
  return !Number.isFinite(roi) || roi > ROI_MAX_NORMAL || roi < ROI_MIN_NORMAL;
}

export type TopLeaderCandidate = {
  leaderAddress: string;
  leaderId: string;
  displayName: string;
  isVerified: boolean;
  roi: number;
  winRate: number;
  followersCount: number;
  copyVolume: number;
  riskLevel: LeaderRiskLevel;
  roiSparkline: number[];
};

function normalizeScore(value: number, max: number): number {
  if (!Number.isFinite(value) || max <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(0, value / max));
}

export function scoreTopLeader(row: TopLeaderCandidate): number {
  const roiScore = normalizeScore(Math.max(0, row.roi), 100);
  const winRateScore = normalizeScore(row.winRate, 100);
  const followersScore = normalizeScore(row.followersCount, 5000);
  const volumeScore = normalizeScore(row.copyVolume, 1_000_000);
  return (
    roiScore * 0.35 +
    winRateScore * 0.25 +
    followersScore * 0.25 +
    volumeScore * 0.15
  );
}

export function rankTopLeaders(candidates: TopLeaderCandidate[]): DashboardTopLeader[] {
  const filtered = candidates.filter((row) => {
    if (row.followersCount <= 0) {
      return false;
    }
    if (isAbnormalRoi(row.roi)) {
      return false;
    }
    return true;
  });

  const sorted = [...filtered].sort((a, b) => scoreTopLeader(b) - scoreTopLeader(a));
  return sorted.slice(0, TOP_LEADERS_LIMIT).map((row, index) => ({
    rank: index + 1,
    leaderId: row.leaderId,
    displayName: row.displayName,
    isVerified: row.isVerified,
    leaderAddress: row.leaderAddress,
    roi: round2(row.roi),
    roiSparkline: row.roiSparkline.length > 0 ? row.roiSparkline.map(round2) : [round2(row.roi)],
    winRate: round2(row.winRate),
    followersCount: row.followersCount,
    riskLevel: row.riskLevel,
  }));
}

export type ActivityRowInput = {
  eventType: string;
  title: string;
  content: string | null;
  level: string;
  createdAt: Date;
  metadata: unknown;
};

export function normalizeActivityLevel(eventType: string, level: string): DashboardActivity['level'] {
  const lv = level.trim().toLowerCase();
  if (lv === 'success') {
    return 'success';
  }
  if (lv === 'warning' || lv === 'warn') {
    return 'warning';
  }
  if (lv === 'error' || lv === 'critical') {
    return 'error';
  }
  if (eventType === 'copy.success' || eventType === 'gas.order.paid' || eventType === 'withdraw.approved') {
    return 'success';
  }
  if (eventType === 'copy.failed' || eventType === 'withdraw.failed' || eventType === 'risk.blocked') {
    return 'error';
  }
  if (eventType === 'copy.paused' || eventType === 'leader.disabled') {
    return 'warning';
  }
  return 'info';
}

function readMetaString(metadata: unknown, key: string): string {
  if (metadata == null || typeof metadata !== 'object') {
    return '';
  }
  const v = (metadata as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : v != null ? String(v) : '';
}

/** 脱敏邮箱 */
export function maskEmail(email: string): string {
  const raw = email.trim();
  const at = raw.indexOf('@');
  if (at <= 0) {
    return '***';
  }
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  const maskedLocal = local.length <= 1 ? '*' : `${local[0]}***`;
  return `${maskedLocal}@${domain}`;
}

export function buildActivityDescription(
  eventType: string,
  content: string | null,
  metadata: unknown,
  maskAddress: (addr: string) => string
): string {
  if (content != null && content.trim() !== '') {
    return content.trim();
  }

  const userAddress = readMetaString(metadata, 'userAddress') || readMetaString(metadata, 'wallet');
  const leaderAddress = readMetaString(metadata, 'leaderAddress');
  const leaderName = readMetaString(metadata, 'leaderName');
  const orderId = readMetaString(metadata, 'orderId');
  const reason = readMetaString(metadata, 'reason');
  const email = readMetaString(metadata, 'email');

  const userMasked = userAddress ? maskAddress(userAddress) : '';
  const leaderLabel = leaderName || (leaderAddress ? maskAddress(leaderAddress) : '');

  switch (eventType) {
    case 'copy.success':
      return userMasked && leaderLabel
        ? `用户 ${userMasked} 跟单 ${leaderLabel} 成功${orderId ? `，订单 #${orderId}` : ''}`
        : '';
    case 'copy.failed':
      return userMasked
        ? `用户 ${userMasked} 跟单失败${reason ? `，原因：${reason}` : ''}`
        : '';
    case 'wallet.linked':
      return userMasked ? `用户 ${userMasked} 完成钱包绑定` : '';
    case 'gas.order.created':
      return userMasked
        ? `用户 ${userMasked} 创建套餐订单${orderId ? ` #${orderId}` : ''}`
        : '';
    case 'gas.order.paid':
      return userMasked
        ? `用户 ${userMasked} 支付套餐订单${orderId ? ` #${orderId}` : ''}`
        : '';
    case 'risk.blocked':
      return userMasked
        ? `风控拦截用户 ${userMasked} 的操作${reason ? `，原因：${reason}` : ''}`
        : '';
    case 'user.registered':
      return email
        ? `用户 ${maskEmail(email)} 完成注册`
        : userMasked
          ? `用户 ${userMasked} 完成注册`
          : '';
    default:
      return '';
  }
}

const NOISE_EVENT_TYPES = new Set(['sync.finished', 'node.ping']);

export function filterActivitiesForDashboard(
  rows: ActivityRowInput[],
  maskAddress: (addr: string) => string
): DashboardActivity[] {
  const noiseLatest = new Map<string, ActivityRowInput>();
  const regular: ActivityRowInput[] = [];

  for (const row of rows) {
    if (NOISE_EVENT_TYPES.has(row.eventType)) {
      if (!noiseLatest.has(row.eventType)) {
        noiseLatest.set(row.eventType, row);
      }
      continue;
    }
    regular.push(row);
  }

  const merged = [...regular, ...noiseLatest.values()];
  merged.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return merged.slice(0, ACTIVITIES_LIMIT).map((row) => ({
    eventType: row.eventType,
    title: row.title,
    description: buildActivityDescription(row.eventType, row.content, row.metadata, maskAddress),
    level: normalizeActivityLevel(row.eventType, row.level),
    createdAt: row.createdAt.toISOString(),
  }));
}

export function containsSensitiveText(text: string): boolean {
  const lower = text.toLowerCase();
  if (/\b(?:sk-|pk_|secret|token|bearer)\b/i.test(text)) {
    return true;
  }
  if (/0x[a-fA-F0-9]{40}/.test(text) && !text.includes('****')) {
    return true;
  }
  if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text) && !text.includes('***')) {
    return true;
  }
  return lower.includes('private') && lower.includes('key');
}

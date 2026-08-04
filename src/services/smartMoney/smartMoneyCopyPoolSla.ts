/**
 * TopN 日复评 SLA：日终（或接近日终）检查 priority due，未清零则打 AdminAlert。
 */
import { CONFIG } from '../../config/env';
import { recordAdminAlert } from '../adminDashboard/adminActivityLog';
import {
  businessDayKey,
  countPriorityTopNDue,
  getCopyPoolDualChannelStats,
  isDualChannelRescoreMode,
  recordDailyRescoreMeta,
} from './smartMoneyCopyPoolRescoreChannels';
import { getDiscoveryCursor, upsertDiscoveryCursor } from './smartMoneyDiscoveryCursor';

export const COPY_POOL_SLA_ALERT_SOURCE = 'COPY_POOL_TOPN_SLA';

function minutesIntoBusinessDay(now = new Date(), timeZone = CONFIG.smartMoneyCopyPoolDailyTz): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    return hour * 60 + minute;
  } catch {
    return now.getUTCHours() * 60 + now.getUTCMinutes();
  }
}

/**
 * 在业务日末尾窗口（默认最后 30 分钟）检查；同一 dayKey 只告警一次。
 */
export async function checkCopyPoolTopNDailySla(options?: {
  now?: Date;
  /** 从一天的第几分钟起视为「日终窗口」；默认 23:30 */
  endWindowFromMinute?: number;
  force?: boolean;
}): Promise<{
  checked: boolean;
  breached: boolean;
  dayKey: string;
  priorityDue: number;
  alerted: boolean;
}> {
  const now = options?.now ?? new Date();
  const dayKey = businessDayKey(now);
  const endFrom = options?.endWindowFromMinute ?? 23 * 60 + 30;

  if (!isDualChannelRescoreMode()) {
    return { checked: false, breached: false, dayKey, priorityDue: 0, alerted: false };
  }

  const minute = minutesIntoBusinessDay(now);
  if (!options?.force && minute < endFrom) {
    // 过 0 点后前 15 分钟：补检「昨日」SLA（防窗口内宕机漏告警）
    if (minute <= 15) {
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const yKey = businessDayKey(yesterday);
      const prev = await getDiscoveryCursor(COPY_POOL_SLA_ALERT_SOURCE);
      const alreadyYesterday =
        prev.meta != null &&
        typeof prev.meta === 'object' &&
        (prev.meta as { dayKey?: string; alerted?: boolean }).dayKey === yKey;
      if (!alreadyYesterday) {
        // 用昨天末尾视角：若昨天末仍有 due，无法精确重放；改为检查「今日已清但昨日未告警」跳过。
        // 简化：仅当昨日未记录任何 SLA meta 时，对「当前仍大量 due 且刚过日切」打一次 info 提示。
        const dueNow = await countPriorityTopNDue(now);
        if (dueNow >= Math.max(10, Math.floor(CONFIG.smartMoneyCopyPoolDailyTopN * 0.5))) {
          recordAdminAlert({
            alertType: 'smart_money_copy_pool_topn_sla_breach',
            title: `CopyPool Top${CONFIG.smartMoneyCopyPoolDailyTopN} 可能漏检昨日 SLA`,
            content: `日切后仍有 ${dueNow} 个 TopN 未复评；请核对 ${yKey} 是否完成日更`,
            level: 'warning',
            source: 'smart-money-copy-pool-sla',
            targetId: yKey,
            metadata: { dayKey: yKey, priorityDue: dueNow, catchUp: true },
          });
          await upsertDiscoveryCursor({
            source: COPY_POOL_SLA_ALERT_SOURCE,
            cursor: yKey,
            meta: {
              dayKey: yKey,
              alerted: true,
              priorityDue: dueNow,
              alertedAt: now.toISOString(),
              catchUp: true,
            },
          });
          return {
            checked: true,
            breached: true,
            dayKey: yKey,
            priorityDue: dueNow,
            alerted: true,
          };
        }
      }
    }
    return { checked: false, breached: false, dayKey, priorityDue: 0, alerted: false };
  }

  const priorityDue = await countPriorityTopNDue(now);
  await recordDailyRescoreMeta({ priorityDue });

  const breached = priorityDue > 0;
  if (!breached) {
    return { checked: true, breached: false, dayKey, priorityDue: 0, alerted: false };
  }

  const prev = await getDiscoveryCursor(COPY_POOL_SLA_ALERT_SOURCE);
  const already =
    prev.meta != null &&
    typeof prev.meta === 'object' &&
    (prev.meta as { dayKey?: string }).dayKey === dayKey &&
    (prev.meta as { alerted?: boolean }).alerted === true;
  if (already && !options?.force) {
    return { checked: true, breached: true, dayKey, priorityDue, alerted: false };
  }

  const stats = await getCopyPoolDualChannelStats().catch(() => null);
  recordAdminAlert({
    alertType: 'smart_money_copy_pool_topn_sla_breach',
    title: `CopyPool Top${CONFIG.smartMoneyCopyPoolDailyTopN} 日复评 SLA 未达标`,
    content: `${dayKey} 仍有 ${priorityDue} 个 TopN 地址今日未复评完成`,
    level: 'warning',
    source: 'smart-money-copy-pool-sla',
    targetId: dayKey,
    metadata: {
      dayKey,
      priorityDue,
      dailyTopN: CONFIG.smartMoneyCopyPoolDailyTopN,
      backgroundEligible: stats?.backgroundEligible ?? null,
      bgCursor: stats?.bgCursor ?? null,
    },
  });

  await upsertDiscoveryCursor({
    source: COPY_POOL_SLA_ALERT_SOURCE,
    cursor: dayKey,
    meta: {
      dayKey,
      alerted: true,
      priorityDue,
      alertedAt: now.toISOString(),
    },
  });

  return { checked: true, breached: true, dayKey, priorityDue, alerted: true };
}

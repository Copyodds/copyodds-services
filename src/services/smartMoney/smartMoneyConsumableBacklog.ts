/**
 * 可消费库存快照：真正能被下游消费的数量，避免把 nextDeep 到期误当成 Gate READY。
 */
import { prisma } from '../../db';
import { SMART_MONEY_PNL_WINDOW_DAYS } from './smartMoneyPositionStats';
import { rawPoolActiveWhere } from './smartMoneyRawPoolActive';
import type { SmartMoneyBatchBacklog } from './smartMoneyBatchObservability';

export async function snapshotConsumableBacklog(): Promise<SmartMoneyBatchBacklog> {
  const now = new Date();
  const [
    rawDue,
    qualifiedTotal,
    gateReadyQualified,
    scoredAll,
    scoredDue,
    copyPoolRescoreDue,
    elimReady,
  ] = await Promise.all([
    prisma.smartMoneyRawAddress.count({
      where: {
        ...rawPoolActiveWhere,
        pipelineStage: 'RAW',
        OR: [{ nextLightAnalyzeAt: null }, { nextLightAnalyzeAt: { lte: now } }],
      },
    }),
    prisma.smartMoneyRawAddress.count({
      where: { pipelineStage: 'QUALIFIED', dormant: false },
    }),
    prisma.$queryRaw<Array<{ cnt: bigint }>>`
      SELECT COUNT(*)::bigint AS cnt
      FROM "SmartMoneyRawAddress" ra
      WHERE ra."pipelineStage" = 'QUALIFIED'
        AND ra.dormant = false
        AND EXISTS (
          SELECT 1
          FROM "SmartMoneyClosedSnapshot" s
          WHERE s.wallet = ra.wallet
            AND s.purpose = 'GATE'
            AND s.status = 'READY'
            AND s."expiresAt" > NOW()
            AND s."windowDays" = ${SMART_MONEY_PNL_WINDOW_DAYS}
        )
    `.then((rows) => Number(rows[0]?.cnt ?? 0)),
    prisma.smartMoneyRawAddress.count({
      where: {
        pipelineStage: 'SCORED',
        dormant: false,
      },
    }),
    prisma.smartMoneyRawAddress.count({
      where: {
        pipelineStage: 'SCORED',
        dormant: false,
        OR: [{ nextDeepAnalyzeAt: null }, { nextDeepAnalyzeAt: { lte: now } }],
      },
    }),
    prisma.smartMoneyRawAddress.count({
      where: {
        pipelineStage: 'COPY_POOL',
        dormant: false,
        OR: [{ nextDeepAnalyzeAt: null }, { nextDeepAnalyzeAt: { lte: now } }],
      },
    }),
    prisma.smartMoneyRawAddress.count({
      where: {
        pipelineStage: 'ELIMINATED',
        dormant: false,
        AND: [
          { OR: [{ elimFrozenUntil: null }, { elimFrozenUntil: { lte: now } }] },
          { OR: [{ nextElimCheckAt: null }, { nextElimCheckAt: { lte: now } }] },
        ],
      },
    }),
  ]);

  const qualifiedGateReady = gateReadyQualified;
  const qualifiedGateMissing = Math.max(0, qualifiedTotal - qualifiedGateReady);

  return {
    rawDue,
    qualifiedTotal,
    qualifiedGateReady,
    qualifiedGateMissing,
    deepExecutable: qualifiedGateReady,
    scoredAll,
    scoredDue,
    /** F6：兼容旧字段名，语义改为「可调度 SCORED」而非库存 */
    scoredAwaitingEntry: scoredDue,
    copyPoolRescoreDue,
    elimReady,
  };
}

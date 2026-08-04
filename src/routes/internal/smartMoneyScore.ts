/**
 * POST /api/internal/smart-money/refresh-profile
 * 鉴权：Header X-Internal-Secret === COPY_INTERNAL_SECRET
 *
 * Admin / 运维统一走 TS 单轨 Deep Analyze（与 Cron 一致）。
 */
import { NextFunction, Router } from 'express';
import { z } from 'zod';
import { CONFIG } from '../../config/env';
import { Code, fail, success } from '../../utils/response';
import { recomputeSmartMoneyLeaderboardRanks } from '../../services/smartMoney/smartMoneyLeaderboardWriter';
import { ingestSmartMoneyRawAddresses } from '../../services/smartMoney/smartMoneyRawIngest';
import { runDeepAnalyzeForWallet } from '../../services/smartMoney/smartMoneyDeepAnalyze';

export const internalSmartMoneyScoreRouter = Router();

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid EVM address');

const refreshBodySchema = z.object({
  wallet: addressSchema,
  recomputeRanks: z.boolean().optional(),
});

internalSmartMoneyScoreRouter.post('/refresh-profile', async (req, res, next: NextFunction) => {
  try {
    const parsed = refreshBodySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, parsed.error.issues.map((issue) => issue.message).join('; '));
      return;
    }

    const wallet = parsed.data.wallet.toLowerCase();
    const recomputeRanks = parsed.data.recomputeRanks !== false;

    await ingestSmartMoneyRawAddresses([{ wallet, source: 'ADMIN_REFRESH' }]);
    const deep = await runDeepAnalyzeForWallet(wallet);
    let rankStats: Awaited<ReturnType<typeof recomputeSmartMoneyLeaderboardRanks>> | null = null;
    if (recomputeRanks && deep.scored) {
      rankStats = await recomputeSmartMoneyLeaderboardRanks();
    }
    success(res, {
      wallet,
      success: deep.success,
      scoreWritten: deep.scored,
      inCopyPool: deep.inCopyPool,
      scoreEngine: 'pipeline-deep',
      scoreVersion: CONFIG.smartMoneyScoreVersion,
      error: deep.error ?? null,
      rankStats,
    });
  } catch (error) {
    next(error);
  }
});

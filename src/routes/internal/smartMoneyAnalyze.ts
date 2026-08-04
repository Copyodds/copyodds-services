/**
 * POST /api/internal/smart-money/analyze/light/:wallet
 * POST /api/internal/smart-money/analyze/full/:wallet
 * POST /api/internal/smart-money/score/:wallet
 *
 * 鉴权：Header X-Internal-Secret === COPY_INTERNAL_SECRET
 */
import { NextFunction, Router } from 'express';
import { z } from 'zod';
import { CONFIG } from '../../config/env';
import { Code, fail, success } from '../../utils/response';
import { ingestSmartMoneyRawAddresses } from '../../services/smartMoney/smartMoneyRawIngest';
import { runLightAnalyzeForWallet } from '../../services/smartMoney/smartMoneyLightAnalyze';
import { runDeepAnalyzeForWallet } from '../../services/smartMoney/smartMoneyDeepAnalyze';
import { runCurveEnrichmentForWallet } from '../../services/smartMoney/smartMoneyDeepEnrich';
import { getSmartMoneyScoreCache } from '../../services/smartMoney/smartMoneyScoreCache';
import { recomputeSmartMoneyLeaderboardRanks } from '../../services/smartMoney/smartMoneyLeaderboardWriter';

export const internalSmartMoneyAnalyzeRouter = Router();

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid EVM address');

const walletParamsSchema = z.object({
  wallet: addressSchema,
});

const scoreBodySchema = z.object({
  recomputeRanks: z.boolean().optional(),
  skipIngest: z.boolean().optional(),
});

async function ingestWallet(wallet: string, source: string, skipIngest: boolean) {
  if (skipIngest) return;
  await ingestSmartMoneyRawAddresses([{ wallet, source }]);
}

internalSmartMoneyAnalyzeRouter.post(
  '/analyze/light/:wallet',
  async (req, res, next: NextFunction) => {
    try {
      const parsed = walletParamsSchema.safeParse(req.params);
      if (!parsed.success) {
        fail(res, Code.VALIDATION_FAILED, parsed.error.issues.map((issue) => issue.message).join('; '));
        return;
      }
      const wallet = parsed.data.wallet.toLowerCase();
      await ingestWallet(wallet, 'INTERNAL_LIGHT', false);
      const result = await runLightAnalyzeForWallet(wallet);
      success(res, { ...result, scoreVersion: CONFIG.smartMoneyScoreVersion });
    } catch (error) {
      next(error);
    }
  }
);

internalSmartMoneyAnalyzeRouter.post(
  '/analyze/full/:wallet',
  async (req, res, next: NextFunction) => {
    try {
      const parsed = walletParamsSchema.safeParse(req.params);
      if (!parsed.success) {
        fail(res, Code.VALIDATION_FAILED, parsed.error.issues.map((issue) => issue.message).join('; '));
        return;
      }
      const body = scoreBodySchema.safeParse(req.body ?? {});
      const wallet = parsed.data.wallet.toLowerCase();
      const recomputeRanks = body.success ? body.data.recomputeRanks !== false : true;
      await ingestWallet(wallet, 'INTERNAL_FULL', body.success ? body.data.skipIngest === true : false);
      const result = await runDeepAnalyzeForWallet(wallet);
      let rankStats: Awaited<ReturnType<typeof recomputeSmartMoneyLeaderboardRanks>> | null = null;
      // 入池/出分后必须重算 rank，否则 /cached（要求 rank NOT NULL）会空列表
      if (recomputeRanks && (result.scored || result.inCopyPool)) {
        rankStats = await recomputeSmartMoneyLeaderboardRanks().catch((error) => {
          console.warn('[smart-money-analyze] rank recompute failed', error);
          return null;
        });
      }
      success(res, {
        ...result,
        scoreVersion: CONFIG.smartMoneyScoreVersion,
        scoreEngine: 'pipeline-deep',
        rankStats,
      });
    } catch (error) {
      next(error);
    }
  }
);

internalSmartMoneyAnalyzeRouter.post('/score/:wallet', async (req, res, next: NextFunction) => {
  try {
    const parsed = walletParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, parsed.error.issues.map((issue) => issue.message).join('; '));
      return;
    }
    const bodyParsed = scoreBodySchema.safeParse(req.body ?? {});
    const recomputeRanks = bodyParsed.success ? bodyParsed.data.recomputeRanks !== false : true;
    const skipIngest = bodyParsed.success ? bodyParsed.data.skipIngest === true : false;
    const wallet = parsed.data.wallet.toLowerCase();

    await ingestWallet(wallet, 'INTERNAL_SCORE', skipIngest);
    const result = await runDeepAnalyzeForWallet(wallet);
    const scoreCache = result.scored ? await getSmartMoneyScoreCache(wallet) : null;

    let rankStats: Awaited<ReturnType<typeof recomputeSmartMoneyLeaderboardRanks>> | null = null;
    if (recomputeRanks && (result.scored || result.inCopyPool)) {
      rankStats = await recomputeSmartMoneyLeaderboardRanks();
    }

    success(res, {
      wallet,
      success: result.success,
      scored: result.scored,
      inCopyPool: result.inCopyPool,
      error: result.error ?? null,
      scoreVersion: CONFIG.smartMoneyScoreVersion,
      scoreEngine: 'pipeline-deep',
      scoreCache,
      rankStats,
    });
  } catch (error) {
    next(error);
  }
});

/** POST /api/internal/smart-money/analyze/enrich-curves/:wallet — Deep-Enrich 补 1D/1M */
internalSmartMoneyAnalyzeRouter.post(
  '/analyze/enrich-curves/:wallet',
  async (req, res, next: NextFunction) => {
    try {
      const parsed = walletParamsSchema.safeParse(req.params);
      if (!parsed.success) {
        fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, {
          details: parsed.error.flatten(),
        });
        return;
      }
      const wallet = parsed.data.wallet.toLowerCase();
      const result = await runCurveEnrichmentForWallet(wallet);
      success(res, result);
    } catch (error) {
      next(error);
    }
  }
);
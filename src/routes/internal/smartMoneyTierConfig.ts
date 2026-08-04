import { NextFunction, Router } from 'express';
import { z } from 'zod';
import { Code, fail, success } from '../../utils/response';
import {
  clearSmartMoneyTierConfigOverrides,
  getSmartMoneyTierConfigSnapshot,
  upsertSmartMoneyTierConfigSnapshot,
} from '../../services/smartMoney/smartMoneyTierConfig';

export const internalSmartMoneyTierConfigRouter = Router();

const thresholdPatchSchema = z
  .object({
    minHoldingsValue: z.number().finite().optional(),
    minPredictionCount: z.number().int().nonnegative().optional(),
    minCurvePointCount: z.number().int().positive().optional(),
    tier1fMinTrades30d: z.number().int().nonnegative().optional(),
    tier1fMinDataConfidence: z.number().finite().optional(),
    tier2MinTotalReturn: z.number().finite().optional(),
    tier2MaxDrawdown: z.number().finite().optional(),
    tier2MinCalmar: z.number().finite().optional(),
    tier2MinVolume: z.number().finite().optional(),
    scorePoolMinPnl1y: z.number().nonnegative().optional(),
    scorePoolMinLifetimeVolume: z.number().nonnegative().optional(),
    scorePoolMinWinRate: z.number().min(0).max(1).optional(),
    scorePoolMinProfitFactor: z.number().nonnegative().optional(),
    scorePoolMinTrades7d: z.number().int().nonnegative().optional(),
    scorePoolMinTrades30d: z.number().int().nonnegative().optional(),
    scorePoolMinClosedMarkets: z.number().int().positive().optional(),
    minClosedMarketsForEligibility: z.number().int().nonnegative().optional(),
    minHighReturnMarketShare: z.number().finite().optional(),
    minLiquidityClassificationShare: z.number().finite().optional(),
    minHighVolumeMarketShare: z.number().finite().optional(),
    updatedBy: z.string().max(128).optional(),
  })
  .refine((body) => Object.keys(body).some((key) => key !== 'updatedBy'), {
    message: 'At least one threshold field is required',
  });

internalSmartMoneyTierConfigRouter.get('/tier-config', async (_req, res, next: NextFunction) => {
  try {
    const snapshot = await getSmartMoneyTierConfigSnapshot();
    success(res, snapshot);
  } catch (error) {
    next(error);
  }
});

internalSmartMoneyTierConfigRouter.put('/tier-config', async (req, res, next: NextFunction) => {
  try {
    const parsed = thresholdPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, parsed.error.issues.map((issue) => issue.message).join('; '));
      return;
    }
    const { updatedBy, ...thresholds } = parsed.data;
    const saved = await upsertSmartMoneyTierConfigSnapshot({ thresholds, updatedBy });
    const snapshot = await getSmartMoneyTierConfigSnapshot();
    success(res, { saved, ...snapshot });
  } catch (error) {
    next(error);
  }
});

internalSmartMoneyTierConfigRouter.delete('/tier-config', async (_req, res, next: NextFunction) => {
  try {
    await clearSmartMoneyTierConfigOverrides();
    const snapshot = await getSmartMoneyTierConfigSnapshot();
    success(res, snapshot);
  } catch (error) {
    next(error);
  }
});

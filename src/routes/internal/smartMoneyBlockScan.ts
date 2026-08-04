/**
 * POST /api/internal/smart-money/block-scan-discoveries
 * 鉴权：Header X-Internal-Secret === COPY_INTERNAL_SECRET
 */
import { NextFunction, Router } from 'express';
import { z } from 'zod';
import { Code, fail, success } from '../../utils/response';
import { ingestBlockScanDiscoveries } from '../../services/smartMoney/blockScanDiscoveryIngest';

export const internalSmartMoneyBlockScanRouter = Router();

const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid EVM address');

const walletRowSchema = z.object({
  wallet: addressSchema,
  fillCount: z.number().int().positive(),
  maxNotional: z.string().min(1),
  lastBlock: z.number().int().nonnegative(),
});

const ingestBodySchema = z.object({
  chainId: z.number().int().positive(),
  fromBlock: z.number().int().nonnegative(),
  toBlock: z.number().int().nonnegative(),
  // 上限只做防滥用兜底，不再按 500 整批拒收；超出部分由 ingest 按名义金额排序截 TopN
  wallets: z.array(walletRowSchema).max(5000),
});

internalSmartMoneyBlockScanRouter.post('/block-scan-discoveries', async (req, res, next: NextFunction) => {
  try {
    const parsed = ingestBodySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, parsed.error.issues.map((issue) => issue.message).join('; '));
      return;
    }
    if (parsed.data.toBlock < parsed.data.fromBlock) {
    fail(res, Code.VALIDATION_FAILED, 'toBlock must be >= fromBlock');
      return;
    }

    const stats = await ingestBlockScanDiscoveries(parsed.data);
    success(res, stats);
  } catch (error) {
    next(error);
  }
});

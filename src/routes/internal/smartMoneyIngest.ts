import { NextFunction, Router } from 'express';
import { z } from 'zod';
import { Code, fail, success } from '../../utils/response';
import { ingestSmartMoneyRawAddresses } from '../../services/smartMoney/smartMoneyRawIngest';

export const internalSmartMoneyIngestRouter = Router();

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid EVM address');

const ingestBodySchema = z.object({
  wallets: z.array(
    z.object({
      wallet: addressSchema,
      source: z.string().min(1).max(64),
    })
  ),
});

internalSmartMoneyIngestRouter.post('/ingest', async (req, res, next: NextFunction) => {
  try {
    const parsed = ingestBodySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, parsed.error.issues.map((issue) => issue.message).join('; '));
      return;
    }
    const stats = await ingestSmartMoneyRawAddresses(parsed.data.wallets);
    success(res, stats);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/internal/polymarket/invalidate-user-clob-cache
 * 与 polymarket-admin-api 等内部服务配合：更新 Wallet.polymarketFunderAddress 后清除 Node 进程内 ClobClient 缓存。
 * 鉴权：X-Internal-Secret === COPY_INTERNAL_SECRET
 */
import { Router } from 'express';
import { z } from 'zod';
import { invalidateUserClobClientCache } from '../../services/polymarket/polymarketClob';
import { Code, fail, success } from '../../utils/response';

export const internalPolymarketRouter = Router();

const bodySchema = z.object({
  userId: z.number().int().positive(),
  walletAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid EVM address')
    .transform((s) => s.trim()),
});

internalPolymarketRouter.post('/invalidate-user-clob-cache', (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, {
      details: parsed.error.flatten(),
    });
    return;
  }
  const { userId, walletAddress } = parsed.data;
  invalidateUserClobClientCache(userId, walletAddress);
  success(res, { ok: true, userId, walletAddress });
});

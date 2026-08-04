import { NextFunction, Router } from 'express';
import { z } from 'zod';
import { Code, fail, success } from '../utils/response';
import { jwtAuth } from '../middlewares/jwtAuth';
import { claimShareToXGas, getShareToXStatus } from '../services/shareToX/shareToXGas';

const router = Router();

const claimSchema = z.object({
  wallet: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid EVM address')
    .optional()
    .nullable(),
});

router.get('/status', jwtAuth, async (req, res, next: NextFunction) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const status = await getShareToXStatus(req.user.userId);
    success(res, status);
  } catch (err) {
    next(err);
  }
});

router.post('/claim', jwtAuth, async (req, res, next: NextFunction) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const parsed = claimSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Invalid request body', 400, {
        details: parsed.error.issues,
      });
      return;
    }
    const result = await claimShareToXGas({
      userId: req.user.userId,
      wallet: parsed.data.wallet,
    });
    success(res, result);
  } catch (err) {
    next(err);
  }
});

export const shareToXRouter = router;
export default router;

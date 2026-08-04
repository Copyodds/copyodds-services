import { NextFunction, Router } from 'express';
import { z } from 'zod';
import { Code, success, fail } from '../utils/response';
import { jwtAuth } from '../middlewares/jwtAuth';
import {
  listActiveAffiliateTierProducts,
  listAffiliateTierProductsWithPricing,
  purchaseAffiliateTierWithPolymarketDeposit,
} from '../services/affiliate/affiliateTierShop';

const router = Router();

router.get('/pricing', jwtAuth, async (req, res, next: NextFunction) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const result = await listAffiliateTierProductsWithPricing(req.user.userId);
    success(res, result);
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next: NextFunction) => {
  try {
    const items = await listActiveAffiliateTierProducts();
    success(res, { items });
  } catch (err) {
    next(err);
  }
});

const purchaseSchema = z.object({
  productId: z.number().int().positive(),
});

router.post(
  '/orders/purchase-with-polymarket-deposit',
  jwtAuth,
  async (req, res, next: NextFunction) => {
    try {
      if (!req.user) {
        fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
        return;
      }
      const parsed = purchaseSchema.safeParse(req.body);
      if (!parsed.success) {
        fail(res, Code.VALIDATION_FAILED, 'Invalid request body', 400, {
          details: parsed.error.issues,
        });
        return;
      }
      const result = await purchaseAffiliateTierWithPolymarketDeposit({
        userId: req.user.userId,
        productId: parsed.data.productId,
      });
      success(res, result);
    } catch (err) {
      next(err);
    }
  },
);

export const affiliateTierShopRouter = router;

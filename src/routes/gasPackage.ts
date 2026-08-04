import { NextFunction, Router } from 'express';
import { z } from 'zod';
import { Code, success, fail } from '../utils/response';
import { jwtAuth } from '../middlewares/jwtAuth';
import { prisma } from '../db';
import { isAppError } from '../utils/appError';
import {
  listActivePackages,
  createPackageOrder,
  confirmPackageOrder,
  fulfillPackageOrder,
  purchasePackageWithCustodyWallet,
  purchasePackageWithPolymarketDeposit,
} from '../services/gas/gasPackage';
import { toPublicGasPackageOrder, toPublicGasUser } from '../utils/publicApiPayload';

function publicCreateOrderResult(result: Awaited<ReturnType<typeof createPackageOrder>>) {
  return {
    order: toPublicGasPackageOrder(result.order as { userId?: number }),
    package: result.package,
    suggestedPayment: result.suggestedPayment,
  };
}

function publicFulfillResult(result: Awaited<ReturnType<typeof fulfillPackageOrder>>) {
  if (!result) return result;
  return {
    packageOrder: toPublicGasPackageOrder(result.packageOrder as { userId?: number }),
    gasOrder: result.gasOrder,
    commissionPlan: result.commissionPlan,
    user: toPublicGasUser(result.user as Parameters<typeof toPublicGasUser>[0]),
  };
}

function publicPurchaseResult(result: Record<string, unknown>) {
  const packageOrder = result.packageOrder;
  return {
    ...result,
    packageOrder:
      packageOrder && typeof packageOrder === 'object'
        ? toPublicGasPackageOrder(packageOrder as { userId?: number })
        : packageOrder,
    user: toPublicGasUser(result.user as Parameters<typeof toPublicGasUser>[0]),
  };
}

const router = Router();

router.get('/', async (req, res, next: NextFunction) => {
  try {
    const packages = await listActivePackages();
    success(res, { items: packages });
  } catch (err) {
    next(err);
  }
});

const createOrderSchema = z.object({
  packageId: z.number().int().positive(),
  walletAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid EVM address')
    .optional(),
});

router.post('/orders', jwtAuth, async (req, res, next: NextFunction) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const parsed = createOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Invalid request body', 400, {
        details: parsed.error.issues,
      });
      return;
    }
    const { packageId, walletAddress } = parsed.data;
    const result = await createPackageOrder({
      userId: req.user.userId,
      packageId,
      walletAddress,
    });
    success(res, publicCreateOrderResult(result));
  } catch (err) {
    next(err);
  }
});

const confirmOrderSchema = z.object({
  txHash: z
    .string()
    .regex(/^0x([A-Fa-f0-9]{64})$/, 'Invalid transaction hash'),
});

router.post('/orders/:id/confirm', jwtAuth, async (req, res, next: NextFunction) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      fail(res, Code.VALIDATION_FAILED, 'Invalid order id', 400);
      return;
    }
    const order = await prisma.gasPackageOrder.findUnique({ where: { id } });
    if (!order || order.userId !== req.user.userId) {
      fail(res, Code.NOT_FOUND, 'Package order not found', 404);
      return;
    }
    const parsed = confirmOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Invalid request body', 400, {
        details: parsed.error.issues,
      });
      return;
    }
    const { txHash } = parsed.data;
    const result = await confirmPackageOrder({ orderId: id, txHash });
    success(
      res,
      result && typeof result === 'object' && 'userId' in result
        ? toPublicGasPackageOrder(result as { userId?: number })
        : result
    );
  } catch (err) {
    next(err);
  }
});

const purchaseWithCustodySchema = z.object({
  packageId: z.number().int().positive(),
});

router.post('/orders/purchase-with-custody', jwtAuth, async (req, res, next: NextFunction) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const parsed = purchaseWithCustodySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Invalid request body', 400, {
        details: parsed.error.issues,
      });
      return;
    }
    const result = await purchasePackageWithCustodyWallet({
      userId: req.user.userId,
      packageId: parsed.data.packageId,
    });
    success(res, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    if (message.includes('not found') || message.includes('inactive')) {
      fail(res, Code.NOT_FOUND, message, 404);
      return;
    }
    if (
      message.includes('Insufficient') ||
      message.includes('failed') ||
      message.includes('custodial wallet')
    ) {
      fail(res, Code.STATE_CONFLICT, message, 409);
      return;
    }
    next(err);
  }
});

router.post('/orders/purchase-with-polymarket-deposit', jwtAuth, async (req, res, next: NextFunction) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const parsed = purchaseWithCustodySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Invalid request body', 400, {
        details: parsed.error.issues,
      });
      return;
    }
    const result = await purchasePackageWithPolymarketDeposit({
      userId: req.user.userId,
      packageId: parsed.data.packageId,
    });
    success(res, publicPurchaseResult(result as Record<string, unknown>));
  } catch (err) {
    if (isAppError(err)) {
      next(err);
      return;
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    if (message.includes('not found') || message.includes('inactive')) {
      fail(res, Code.NOT_FOUND, message, 404);
      return;
    }
    if (
      message.includes('Insufficient') ||
      message.includes('failed') ||
      message.includes('custodial wallet')
    ) {
      fail(res, Code.STATE_CONFLICT, message, 409);
      return;
    }
    next(err);
  }
});

router.post('/orders/:id/fulfill', jwtAuth, async (req, res, next: NextFunction) => {
  try {
    if (!req.user) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      fail(res, Code.VALIDATION_FAILED, 'Invalid order id', 400);
      return;
    }

    const order = await prisma.gasPackageOrder.findUnique({ where: { id } });
    if (!order || order.userId !== req.user.userId) {
      fail(res, Code.NOT_FOUND, 'Package order not found', 404);
      return;
    }

    const result = await fulfillPackageOrder({ orderId: id });
    success(res, publicFulfillResult(result));
  } catch (err) {
    next(err);
  }
});

export const gasPackageRouter = router;


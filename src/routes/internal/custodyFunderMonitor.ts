/**
 * Go wallet chain_monitor ↔ Node：
 * - GET  /api/internal/custody/funder-watch-list
 * - POST /api/internal/custody/funder-deposit-detected
 * - GET  /api/internal/custody/eoa-watch-list
 * - POST /api/internal/custody/eoa-deposit-detected
 * 鉴权：Header X-Internal-Secret === COPY_INTERNAL_SECRET
 */
import { Router } from 'express';
import { z } from 'zod';
import { CONFIG } from '../../config/env';
import {
  handleGoEoaDepositCallback,
  listCustodialEoaWatchWallets,
} from '../../services/custody/custodyEoaDepositIngest';
import {
  handleGoFunderDepositCallback,
  listPolymarketFunderWatchWallets,
  resolveUsdcVariant,
} from '../../services/custody/polymarketFunderDepositIngest';
import { Code, fail, success } from '../../utils/response';

export const internalCustodyFunderMonitorRouter = Router();

const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid EVM address')
  .transform((s) => s.trim());

const txHashSchema = z
  .string()
  .min(1)
  .transform((s) => s.trim().toLowerCase())
  .refine((s) => /^0x[a-f0-9]{64}$/.test(s), 'Invalid tx hash');

const amountRawSchema = z
  .string()
  .min(1)
  .transform((s) => s.trim())
  .refine((s) => /^[0-9]+$/.test(s), 'amountRaw must be a decimal integer string')
  .transform((s) => BigInt(s))
  .refine((n) => n > 0n, 'amountRaw must be positive');

const blockNumberSchema = z.union([
  z.number().int().nonnegative(),
  z
    .string()
    .min(1)
    .transform((s) => s.trim())
    .refine((s) => /^[0-9]+$/.test(s), 'blockNumber must be a decimal integer')
    .transform((s) => BigInt(s)),
]);

const depositDetectedBodySchema = z.object({
  userId: z.number().int().positive(),
  funderAddress: addressSchema,
  custodialAddress: addressSchema,
  txHash: txHashSchema,
  logIndex: z.number().int().nonnegative(),
  blockNumber: blockNumberSchema,
  fromAddress: addressSchema,
  amountRaw: amountRawSchema,
  tokenAddress: addressSchema,
  usdcVariant: z.enum(['native', 'usdce', 'usdt', 'usdt0']).optional(),
  detectedAt: z.string().optional(),
  source: z.literal('go_chain_monitor').optional(),
});

internalCustodyFunderMonitorRouter.get('/funder-watch-list', async (_req, res, next) => {
  try {
    const items = await listPolymarketFunderWatchWallets();
    success(res, {
      items,
      count: items.length,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

internalCustodyFunderMonitorRouter.post('/funder-deposit-detected', async (req, res, next) => {
  try {
    if (!CONFIG.goFunderDepositCallbackEnabled) {
      fail(res, Code.FEATURE_DISABLED, 'Go funder deposit callback is disabled', 410);
      return;
    }

    const parsed = depositDetectedBodySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, {
        details: parsed.error.flatten(),
      });
      return;
    }

    const body = parsed.data;
    const variantFromToken = resolveUsdcVariant(body.tokenAddress);
    if (!variantFromToken) {
      fail(res, Code.VALIDATION_FAILED, 'Unsupported tokenAddress (expected USDC.e, native USDC, USDT, or USDT0)', 400);
      return;
    }
    if (body.usdcVariant && body.usdcVariant !== variantFromToken) {
      fail(res, Code.VALIDATION_FAILED, 'usdcVariant does not match tokenAddress', 400);
      return;
    }

    const result = await handleGoFunderDepositCallback({
      userId: body.userId,
      funderAddress: body.funderAddress,
      custodialAddress: body.custodialAddress,
      txHash: body.txHash as `0x${string}`,
      logIndex: body.logIndex,
      blockNumber: typeof body.blockNumber === 'bigint' ? body.blockNumber : BigInt(body.blockNumber),
      fromAddress: body.fromAddress,
      amountRaw: body.amountRaw,
      tokenAddress: body.tokenAddress,
    });

    if (!result.ok) {
      fail(res, result.code, result.message, result.httpStatus);
      return;
    }

    const httpStatus = result.status === 'inserted' ? 201 : 200;
    success(
      res,
      {
        ok: true,
        status: result.status,
        duplicate: result.status === 'duplicate',
        ledgerId: result.ledgerId ?? null,
        skipReason: result.skipReason ?? null,
      },
      httpStatus,
    );
  } catch (err) {
    next(err);
  }
});

internalCustodyFunderMonitorRouter.get('/eoa-watch-list', async (_req, res, next) => {
  try {
    const items = await listCustodialEoaWatchWallets();
    success(res, {
      items,
      count: items.length,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

internalCustodyFunderMonitorRouter.post('/eoa-deposit-detected', async (req, res, next) => {
  try {
    if (!CONFIG.goEoaDepositCallbackEnabled) {
      fail(res, Code.FEATURE_DISABLED, 'Go EOA deposit callback is disabled', 410);
      return;
    }

    const parsed = depositDetectedBodySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, {
        details: parsed.error.flatten(),
      });
      return;
    }

    const body = parsed.data;
    const variantFromToken = resolveUsdcVariant(body.tokenAddress);
    if (!variantFromToken) {
      fail(res, Code.VALIDATION_FAILED, 'Unsupported tokenAddress (expected USDC.e, native USDC, USDT, or USDT0)', 400);
      return;
    }
    if (body.usdcVariant && body.usdcVariant !== variantFromToken) {
      fail(res, Code.VALIDATION_FAILED, 'usdcVariant does not match tokenAddress', 400);
      return;
    }

    const result = await handleGoEoaDepositCallback({
      userId: body.userId,
      funderAddress: body.funderAddress,
      custodialAddress: body.custodialAddress,
      txHash: body.txHash as `0x${string}`,
      logIndex: body.logIndex,
      blockNumber: typeof body.blockNumber === 'bigint' ? body.blockNumber : BigInt(body.blockNumber),
      fromAddress: body.fromAddress,
      amountRaw: body.amountRaw,
      tokenAddress: body.tokenAddress,
    });

    if (!result.ok) {
      fail(res, result.code, result.message, result.httpStatus);
      return;
    }

    const httpStatus = result.status === 'inserted' ? 201 : 200;
    success(
      res,
      {
        ok: true,
        status: result.status,
        duplicate: result.status === 'duplicate',
        skipReason: result.skipReason ?? null,
      },
      httpStatus,
    );
  } catch (err) {
    next(err);
  }
});

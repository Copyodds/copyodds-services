import { Prisma } from '../generated/prisma/client';
import { D, type DecimalValue } from './virtualCopyMath';

export const VIRTUAL_COPY_FEE_MODEL_VERSION = 'LINEAR_NOTIONAL_V1' as const;

export type VirtualCopyFeeModelConfig = {
  version: typeof VIRTUAL_COPY_FEE_MODEL_VERSION;
  rate: DecimalValue;
};

export type VirtualCopyFeeQuote = {
  version: typeof VIRTUAL_COPY_FEE_MODEL_VERSION;
  rate: Prisma.Decimal;
  feeUsd: Prisma.Decimal;
  grossNotionalUsd: Prisma.Decimal;
  requiredCashUsd: Prisma.Decimal;
  netProceedsUsd: Prisma.Decimal;
};

/**
 * Versioned, deterministic simulation fee model. The rate is applied to gross
 * executed notional on both sides.
 */
export function quoteVirtualCopyFee(
  grossNotionalUsd: DecimalValue,
  config: VirtualCopyFeeModelConfig,
): VirtualCopyFeeQuote {
  if (config.version !== VIRTUAL_COPY_FEE_MODEL_VERSION) {
    throw new Error(`Unsupported virtual copy fee model: ${String(config.version)}`);
  }
  const gross = D(grossNotionalUsd);
  const rate = D(config.rate);
  if (gross.lt(0) || rate.lt(0) || rate.gt(1)) {
    throw new Error('Invalid virtual copy fee quote input');
  }
  const feeUsd = gross.mul(rate);
  return {
    version: config.version,
    rate,
    feeUsd,
    grossNotionalUsd: gross,
    requiredCashUsd: gross.add(feeUsd),
    netProceedsUsd: gross.sub(feeUsd),
  };
}

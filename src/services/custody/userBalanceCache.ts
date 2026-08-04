import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../../db';

type DecimalLike = Prisma.Decimal | number | string;

function toDecimal(value: DecimalLike): Prisma.Decimal {
  if (value instanceof Prisma.Decimal) return value;
  return new Prisma.Decimal(value);
}

export async function upsertUserDepositBalanceCache(
  userId: number,
  data: {
    depositUsdc: DecimalLike;
    depositPusd: DecimalLike;
  },
): Promise<void> {
  const depositUsdc = toDecimal(data.depositUsdc).toString();
  const depositPusd = toDecimal(data.depositPusd).toString();
  await prisma.$executeRawUnsafe(
    `
    INSERT INTO "UserBalanceCache" ("userId", "depositUsdc", "depositPusd", "cachedAt", "updatedAt")
    VALUES ($1, $2::numeric, $3::numeric, NOW(), NOW())
    ON CONFLICT ("userId") DO UPDATE SET
      "depositUsdc" = EXCLUDED."depositUsdc",
      "depositPusd" = EXCLUDED."depositPusd",
      "cachedAt" = NOW(),
      "updatedAt" = NOW()
    `,
    userId,
    depositUsdc,
    depositPusd,
  );
}

export async function upsertUserCustodyUsdcBalanceCache(
  userId: number,
  custodyUsdc: DecimalLike,
): Promise<void> {
  const amount = toDecimal(custodyUsdc).toString();
  await prisma.$executeRawUnsafe(
    `
    INSERT INTO "UserBalanceCache" ("userId", "custodyUsdc", "cachedAt", "updatedAt")
    VALUES ($1, $2::numeric, NOW(), NOW())
    ON CONFLICT ("userId") DO UPDATE SET
      "custodyUsdc" = EXCLUDED."custodyUsdc",
      "cachedAt" = NOW(),
      "updatedAt" = NOW()
    `,
    userId,
    amount,
  );
}

export type DepositBalanceCacheInput = {
  usdcEFormatted: string;
  nativeUsdcFormatted?: string;
  pUsdFormatted: string;
};

export async function persistDepositBalanceCache(
  userId: number,
  data: DepositBalanceCacheInput,
): Promise<void> {
  const native = data.nativeUsdcFormatted ?? '0';
  await upsertUserDepositBalanceCache(userId, {
    depositUsdc: new Prisma.Decimal(data.usdcEFormatted).plus(native),
    depositPusd: data.pUsdFormatted,
  });
}

export async function getCachedCustodyUsdcBalanceForUser(
  userId: number,
): Promise<{ formatted: string; cachedAt: Date } | null> {
  const row = await prisma.userBalanceCache.findUnique({
    where: { userId },
    select: { custodyUsdc: true, cachedAt: true },
  });
  if (!row) return null;
  return {
    formatted: row.custodyUsdc.toString(),
    cachedAt: row.cachedAt,
  };
}

/** Deposit USDC.e(+native) + pUSD from last persisted cache. Null when no row. */
export async function getCachedDepositCollateralUsd(userId: number): Promise<number | null> {
  const row = await prisma.userBalanceCache.findUnique({
    where: { userId },
    select: { depositUsdc: true, depositPusd: true },
  });
  if (!row) return null;
  const usdc = Number(row.depositUsdc.toString());
  const pusd = Number(row.depositPusd.toString());
  const total = (Number.isFinite(usdc) ? usdc : 0) + (Number.isFinite(pusd) ? pusd : 0);
  return total > 0 ? total : 0;
}

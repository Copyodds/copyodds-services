import { Prisma } from "../../generated/prisma/client";

import { prisma } from "../../db";

import type { DataApiPosition } from "../../services/polymarket/polymarketData";

import {
  EXPIRED_LOSER_AUTO_SETTLE_GRACE_MS,
  isActiveValuedApiPosition,
  isConfirmedExpiredLoserPosition,
  isWorthlessRedeemablePosition,
  OPEN_LOT_AUTO_SETTLE_MIN_AGE_MS,
  OPEN_LOT_CHAIN_FLAT_AUTO_SETTLE_MIN_AGE_MS,
  shouldAutoSettleCopyLotAsWorthless,
  shouldForceAutoSettleOpenCopyLot,
} from "../../services/polymarket/positionVisibility";

import {
  COPY_LOT_DUST_SHARES,
  consumeOpenCopyLotsForManualSell,
  getOpenCopyLotSizeForUserToken,
} from "./copyPositionLots";

import { resolveFollowerExpiredCloseSize } from "./copySettlementProceeds";
import {
  MANUAL_CLOSE_LEADER_ADDRESSES,
  shouldSkipManualExpiredAfterManualClose,
} from "./copyRedeemSettlementGuards";
import { clearAutoRedeemFailures } from "./autoRedeemFailureGuard";

const EPS = 1e-9;

function normalizeTokenId(tokenID: string): string {
  return tokenID.trim().toLowerCase();
}

function findApiPosition(
  positions: DataApiPosition[],
  tokenID: string,
): DataApiPosition | null {
  const key = normalizeTokenId(tokenID);

  return positions.find((p) => normalizeTokenId(p.asset) === key) ?? null;
}

async function oldestOpenLotAgeMs(
  userId: number,
  tokenID: string,
): Promise<number | null> {
  const target = normalizeTokenId(tokenID);

  const lots = await prisma.copyPositionLot.findMany({
    where: {
      userId,

      remainingSize: { gt: new Prisma.Decimal(EPS) },
    },

    select: { tokenID: true, createdAt: true },

    orderBy: { createdAt: "asc" },
  });

  const match = lots.find(
    (lot) => normalizeTokenId(String(lot.tokenID)) === target,
  );

  if (!match) return null;

  return Date.now() - match.createdAt.getTime();
}

async function isOpenLotYoungerThan(
  userId: number,

  tokenID: string,

  minAgeMs: number,
): Promise<boolean> {
  const ageMs = await oldestOpenLotAgeMs(userId, tokenID);

  return ageMs != null && ageMs < minAgeMs;
}

async function canAutoSettleTokenNow(params: {
  userId: number;

  tokenID: string;

  apiPos: DataApiPosition | null;

  allowChainFlatSettle?: boolean;

  now?: Date;
}): Promise<boolean> {
  const now = params.now ?? new Date();

  const { apiPos } = params;

  if (isActiveValuedApiPosition(apiPos)) return false;

  // Winning redeemable must wait for redeem — never book as expired worthless.
  if (apiPos?.redeemable === true && !isWorthlessRedeemablePosition(apiPos)) {
    return false;
  }

  const youngLot = await isOpenLotYoungerThan(
    params.userId,

    params.tokenID,

    OPEN_LOT_AUTO_SETTLE_MIN_AGE_MS,
  );

  if (youngLot && !(apiPos && isConfirmedExpiredLoserPosition(apiPos, now))) {
    return false;
  }

  if (!apiPos) {
    // Missing API row is ambiguous (index lag / wallet pair / pagination).
    // After the open lot has aged past the loser grace window, treat as chain-flat
    // so resolved losers do not sit forever as「等待结算」.
    const ageMs = await oldestOpenLotAgeMs(params.userId, params.tokenID);
    if (ageMs == null) return false;
    const agedEnoughForMissingApi =
      ageMs >= EXPIRED_LOSER_AUTO_SETTLE_GRACE_MS ||
      (params.allowChainFlatSettle === true &&
        ageMs >= OPEN_LOT_CHAIN_FLAT_AUTO_SETTLE_MIN_AGE_MS);
    if (!agedEnoughForMissingApi) return false;
    return shouldForceAutoSettleOpenCopyLot(null, now, {
      chainFlatWhenMissing: true,
    });
  }

  return shouldForceAutoSettleOpenCopyLot(apiPos, now, {
    chainFlatWhenMissing: false,
  });
}

async function findCanonicalTokenIdForUser(
  userId: number,
  tokenID: string,
): Promise<string> {
  const target = normalizeTokenId(tokenID);

  const rows = await prisma.copyPositionLot.findMany({
    where: {
      userId,

      remainingSize: { gt: new Prisma.Decimal(EPS) },
    },

    select: { tokenID: true },

    distinct: ["tokenID"],
  });

  const match = rows.find(
    (row) => normalizeTokenId(String(row.tokenID)) === target,
  );

  return match?.tokenID?.trim() || tokenID.trim();
}

async function findExistingManualExpiredExecution(
  userId: number,

  tokenID: string,
): Promise<{ id: string; tokenID: string } | null> {
  const target = normalizeTokenId(tokenID);

  const rows = await prisma.copyExecution.findMany({
    where: {
      followerUserId: userId,

      leaderAddress: "manual_expired",

      side: "SELL",

      status: "filled",
    },

    select: { id: true, tokenID: true },

    orderBy: { createdAt: "desc" },

    take: 200,
  });

  const match = rows.find(
    (row) => normalizeTokenId(String(row.tokenID)) === target,
  );

  return match ?? null;
}

async function consumeOpenLotsForManualExpired(params: {
  userId: number;

  legacyExecutionId: string;

  tokenID: string;

  apiPos: DataApiPosition | null;
}): Promise<boolean> {
  const canonicalToken = await findCanonicalTokenIdForUser(
    params.userId,
    params.tokenID,
  );

  // Live expired settlement must never consume paper (virtual) lots.
  const openCopyLotSize = await getOpenCopyLotSizeForUserToken({
    prismaClient: prisma as any,

    userId: params.userId,

    tokenID: canonicalToken,

  });

  if (!(openCopyLotSize > EPS)) return false;

  const walletShares = Number(params.apiPos?.size ?? 0);

  if (!(walletShares > EPS) && isActiveValuedApiPosition(params.apiPos)) {
    return false;
  }

  const closeSize = resolveFollowerExpiredCloseSize({
    openCopyLotSizeShares: openCopyLotSize,

    walletPositionShares: walletShares,
  });

  if (!(closeSize > EPS)) return false;

  const consumed = await consumeOpenCopyLotsForManualSell({
    prismaClient: prisma as any,

    userId: params.userId,

    legacyExecutionId: params.legacyExecutionId,

    tokenID: canonicalToken,

    exitPrice: 0,

    size: closeSize,

    allowAdditionalClose: true,

  });

  return consumed != null;
}

async function findLatestManualCloseExecution(
  userId: number,
  tokenID: string,
): Promise<{ id: string } | null> {
  const target = normalizeTokenId(tokenID);
  const rows = await prisma.copyExecution.findMany({
    where: {
      followerUserId: userId,
      leaderAddress: { in: [...MANUAL_CLOSE_LEADER_ADDRESSES] },
      side: "SELL",
      status: "filled",
    },
    select: { id: true, tokenID: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return rows.find((row) => normalizeTokenId(String(row.tokenID)) === target) ?? null;
}

async function absorbResidualLotsIntoManualClose(params: {
  userId: number;
  tokenID: string;
  manualCloseExecutionId: string;
  exitPrice?: number;
}): Promise<boolean> {
  const openCopyLotSize = await getOpenCopyLotSizeForUserToken({
    prismaClient: prisma as any,
    userId: params.userId,
    tokenID: params.tokenID,
  });
  if (!(openCopyLotSize > EPS)) return false;

  const consumed = await consumeOpenCopyLotsForManualSell({
    prismaClient: prisma as any,
    userId: params.userId,
    legacyExecutionId: params.manualCloseExecutionId,
    tokenID: params.tokenID,
    exitPrice: params.exitPrice ?? 0,
    size: openCopyLotSize,
    allowAdditionalClose: true,
  });
  return consumed != null;
}

async function createManualExpiredIfMissing(params: {
  userId: number;

  tokenID: string;

  apiPos: DataApiPosition | null;

  allowChainFlatSettle?: boolean;
}): Promise<boolean> {
  if (
    !(await canAutoSettleTokenNow({
      userId: params.userId,

      tokenID: params.tokenID,

      apiPos: params.apiPos,

      allowChainFlatSettle: params.allowChainFlatSettle,
    }))
  ) {
    return false;
  }

  const canonicalToken = await findCanonicalTokenIdForUser(
    params.userId,
    params.tokenID,
  );

  const existing = await findExistingManualExpiredExecution(
    params.userId,
    canonicalToken,
  );

  if (existing) {
    const walletShares = Number(params.apiPos?.size ?? 0);
    const manualClose = await findLatestManualCloseExecution(
      params.userId,
      canonicalToken,
    );
    if (
      shouldSkipManualExpiredAfterManualClose({
        hasManualCloseForToken: manualClose != null,
        walletPositionShares: walletShares,
      })
    ) {
      if (manualClose) {
        await absorbResidualLotsIntoManualClose({
          userId: params.userId,
          tokenID: canonicalToken,
          manualCloseExecutionId: manualClose.id,
          exitPrice: 0,
        });
      }
      return false;
    }

    const repaired = await consumeOpenLotsForManualExpired({
      userId: params.userId,

      legacyExecutionId: existing.id,

      tokenID: canonicalToken,

      apiPos: params.apiPos,
    });

    if (repaired) {
      console.info(
        "[copy-expired-settle] repaired manual_expired lot consume",
        {
          userId: params.userId,

          tokenID: canonicalToken,

          executionId: existing.id,
        },
      );
    }

    return repaired;
  }

  const openCopyLotSize = await getOpenCopyLotSizeForUserToken({
    prismaClient: prisma as any,

    userId: params.userId,

    tokenID: canonicalToken,

  });

  if (!(openCopyLotSize > COPY_LOT_DUST_SHARES)) return false;

  const walletShares = Number(params.apiPos?.size ?? 0);
  const manualClose = await findLatestManualCloseExecution(
    params.userId,
    canonicalToken,
  );
  if (
    shouldSkipManualExpiredAfterManualClose({
      hasManualCloseForToken: manualClose != null,
      walletPositionShares: walletShares,
    })
  ) {
    if (manualClose) {
      const absorbed = await absorbResidualLotsIntoManualClose({
        userId: params.userId,
        tokenID: canonicalToken,
        manualCloseExecutionId: manualClose.id,
        exitPrice: 0,
      });
      if (absorbed) {
        console.info("[copy-expired-settle] absorbed residual lots into manual_close", {
          userId: params.userId,
          tokenID: canonicalToken,
          manualCloseExecutionId: manualClose.id,
        });
      }
    }
    return false;
  }

  const closeSize = resolveFollowerExpiredCloseSize({
    openCopyLotSizeShares: openCopyLotSize,

    walletPositionShares: Number(params.apiPos?.size ?? 0),
  });

  if (!(closeSize > EPS)) return false;

  const execution = await prisma.copyExecution.create({
    data: {
      followerUserId: params.userId,

      leaderAddress: "manual_expired",

      tokenID: canonicalToken,

      side: "SELL",

      price: new Prisma.Decimal(0),

      size: new Prisma.Decimal(closeSize),

      ratioApplied: null,

      notional: new Prisma.Decimal(0),

      polymarketOrderId: null,

      status: "filled",

      error: "auto_settled_expired_worthless",
    },
  });

  const consumed = await consumeOpenLotsForManualExpired({
    userId: params.userId,

    legacyExecutionId: execution.id,

    tokenID: canonicalToken,

    apiPos: params.apiPos,
  });

  if (!consumed) {
    console.warn(
      "[copy-expired-settle] manual_expired created but lots not consumed",
      {
        userId: params.userId,

        tokenID: canonicalToken,

        executionId: execution.id,

        closeSize,
      },
    );
  }

  return consumed;
}

async function tryAutoSettleToken(params: {
  userId: number;

  tokenID: string;

  apiPos: DataApiPosition | null;

  allowChainFlatSettle?: boolean;
}): Promise<boolean> {
  if (
    !(await canAutoSettleTokenNow({
      userId: params.userId,

      tokenID: params.tokenID,

      apiPos: params.apiPos,

      allowChainFlatSettle: params.allowChainFlatSettle,
    }))
  ) {
    return false;
  }

  return createManualExpiredIfMissing({
    userId: params.userId,

    tokenID: params.tokenID,

    apiPos: params.apiPos,

    allowChainFlatSettle: params.allowChainFlatSettle,
  });
}

/** 过期输面自动 manual_expired（有 open lot 时）；可被持仓 GET / redeem cron 调用。 */

export async function autoSettleExpiredWorthlessPositions(
  userId: number,

  positions: DataApiPosition[],
): Promise<Set<string>> {
  const settled = new Set<string>();

  const conditionIds = [
    ...new Set(
      positions.map((p) => p.conditionId.trim().toLowerCase()).filter(Boolean),
    ),
  ];

  const redeemLogs = conditionIds.length
    ? await prisma.polymarketRedeemLog.findMany({
        where: { userId, conditionId: { in: conditionIds } },

        select: { conditionId: true },
      })
    : [];

  const redeemedConditions = new Set(
    redeemLogs.map((r) => r.conditionId.trim().toLowerCase()),
  );

  const candidates = positions.filter((p) =>
    shouldAutoSettleCopyLotAsWorthless(p, false),
  );

  for (const p of candidates) {
    // 输面可赎回不应占自动赎回熔断；清掉历史失败计数，避免后台一直显示「自动熔断」。
    if (isWorthlessRedeemablePosition(p)) {
      await clearAutoRedeemFailures({
        userId,
        conditionId: p.conditionId,
        outcomeIndex: p.outcomeIndex ?? 0,
      });
    }

    if (redeemedConditions.has(p.conditionId.trim().toLowerCase())) {
      continue;
    }

    if (isActiveValuedApiPosition(p)) continue;

    const openCopyLotSize = await getOpenCopyLotSizeForUserToken({
      prismaClient: prisma as any,

      userId,

      tokenID: p.asset,

    });

    const hasOpenLots = openCopyLotSize > COPY_LOT_DUST_SHARES;

    if (!shouldAutoSettleCopyLotAsWorthless(p, hasOpenLots)) continue;

    const created = await createManualExpiredIfMissing({
      userId,

      tokenID: p.asset,

      apiPos: p,
    });

    if (created) settled.add(normalizeTokenId(p.asset));
  }

  const openLotRows = await prisma.copyPositionLot.findMany({
    where: {
      userId,

      remainingSize: { gt: new Prisma.Decimal(EPS) },
    },

    select: { tokenID: true, buyCopyTradeRowId: true },
  });

  const realOpenTokenIds = [
    ...new Set(
      openLotRows
        .map((row) => String(row.tokenID).trim())
        .filter(Boolean),
    ),
  ];

  for (const tokenID of realOpenTokenIds) {
    const tokenKey = normalizeTokenId(tokenID);

    if (!tokenID || settled.has(tokenKey)) continue;

    const apiPos = findApiPosition(positions, tokenID);

    if (
      apiPos &&
      redeemedConditions.has(apiPos.conditionId.trim().toLowerCase())
    ) {
      continue;
    }

    const created = await tryAutoSettleToken({
      userId,

      tokenID,

      apiPos,

      // Never treat "missing from this Data API response" as chain-flat.
      // That caused mass false manual_expired while positions were still live.
      allowChainFlatSettle: false,
    });

    if (created) settled.add(tokenKey);
  }

  const repairedCount = await repairManualExpiredOpenLots(userId, positions);

  if (repairedCount > 0) {
    for (const tokenID of realOpenTokenIds) {
      const tokenKey = normalizeTokenId(tokenID);

      if (tokenKey) settled.add(tokenKey);
    }
  }

  if (settled.size > 0) {
    console.info("[copy-expired-settle] auto-settled worthless open lots", {
      userId,

      tokenCount: settled.size,
    });
  }

  return settled;
}

export async function repairManualExpiredOpenLots(
  userId: number,

  positions: DataApiPosition[] = [],
): Promise<number> {
  const openLotRows = await prisma.copyPositionLot.findMany({
    where: {
      userId,

      remainingSize: { gt: new Prisma.Decimal(EPS) },
    },

    select: { tokenID: true },

    distinct: ["tokenID"],
  });

  let repaired = 0;

  for (const row of openLotRows) {
    const tokenID = String(row.tokenID).trim();

    if (!tokenID) continue;

    const existing = await findExistingManualExpiredExecution(userId, tokenID);

    if (!existing) continue;

    const apiPos = findApiPosition(positions, tokenID);

    if (
      !(await canAutoSettleTokenNow({
        userId,

        tokenID,

        apiPos,

        allowChainFlatSettle: false,
      }))
    ) {
      continue;
    }

    const ok = await consumeOpenLotsForManualExpired({
      userId,

      legacyExecutionId: existing.id,

      tokenID,

      apiPos,
    });

    if (ok) repaired += 1;
  }

  if (repaired > 0) {
    console.info("[copy-expired-settle] repaired manual_expired open lots", {
      userId,

      tokenCount: repaired,
    });
  }

  return repaired;
}

/** @deprecated 仅保留 repair；新建 manual_expired 必须带 Data API 持仓上下文。 */

export async function settleOpenWorthlessLotsForUser(
  userId: number,

  positions: DataApiPosition[] = [],
): Promise<number> {
  return repairManualExpiredOpenLots(userId, positions);
}

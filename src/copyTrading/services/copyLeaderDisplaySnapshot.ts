import { prisma } from '../../db';

export type CopyLeaderDisplaySnapshot = {
  displayName: string | null;
  xUsername: string | null;
  tier: string | null;
};

function isWalletLikeDisplayName(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return /^0x[a-fA-F0-9]{10,}$/.test(raw.trim());
}

function cleanXUsername(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/^@+/, '');
  return cleaned || null;
}

/** Normalize Smart Money profile fields for CopyLeader snapshot storage. */
export function normalizeCopyLeaderDisplaySnapshot(input: {
  displayName?: string | null;
  xUsername?: string | null;
  tier?: string | null;
}): CopyLeaderDisplaySnapshot {
  const rawName = input.displayName?.trim() || null;
  const displayName =
    rawName && !isWalletLikeDisplayName(rawName) ? rawName : null;
  const xUsername = cleanXUsername(input.xUsername);
  const tier = input.tier?.trim().toUpperCase() || null;
  return {
    displayName,
    xUsername,
    tier: tier && /^[SABCD]$/.test(tier) ? tier : null,
  };
}

export async function loadCopyLeaderDisplaySnapshot(
  wallet: string
): Promise<CopyLeaderDisplaySnapshot | null> {
  const addr = wallet.trim().toLowerCase();
  if (!addr) return null;
  const row = await prisma.smartMoneyLeaderboardRow.findUnique({
    where: { wallet: addr },
    select: {
      displayName: true,
      xUsername: true,
      tier: true,
    },
  });
  if (!row) return null;
  return normalizeCopyLeaderDisplaySnapshot(row);
}

/** Only overwrite non-null snapshot fields so refresh paths don't wipe known names. */
export function copyLeaderDisplayUpdateData(
  snapshot: CopyLeaderDisplaySnapshot
): {
  displayName?: string;
  xUsername?: string;
  tier?: string;
} {
  const data: {
    displayName?: string;
    xUsername?: string;
    tier?: string;
  } = {};
  if (snapshot.displayName != null) data.displayName = snapshot.displayName;
  if (snapshot.xUsername != null) data.xUsername = snapshot.xUsername;
  if (snapshot.tier != null) data.tier = snapshot.tier;
  return data;
}

export async function syncCopyLeaderDisplaySnapshot(
  wallet: string,
  snapshot?: {
    displayName?: string | null;
    xUsername?: string | null;
    tier?: string | null;
  } | null
): Promise<void> {
  const addr = wallet.trim().toLowerCase();
  if (!addr) return;
  const normalized = snapshot
    ? normalizeCopyLeaderDisplaySnapshot(snapshot)
    : await loadCopyLeaderDisplaySnapshot(addr);
  if (!normalized) return;
  const data = copyLeaderDisplayUpdateData(normalized);
  if (Object.keys(data).length === 0) return;
  await prisma.copyLeader.updateMany({
    where: { address: addr },
    data,
  });
}

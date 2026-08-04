import { getDecryptedClobCredsForWalletIfValid } from '../../services/polymarket/polymarketAuth';
import { getExecutionWalletForUser } from '../../services/polymarket/automationSession';
import type { UserWalletRuntimeSnapshot } from './types';

const EMPTY_SNAPSHOT: UserWalletRuntimeSnapshot = {
  walletId: null,
  executionAddress: null,
  depositFunderAddress: null,
  hasClobCredentials: false,
};

export async function loadWalletSnapshotsForUserIds(
  userIds: number[]
): Promise<Map<number, UserWalletRuntimeSnapshot>> {
  const out = new Map<number, UserWalletRuntimeSnapshot>();
  const unique = [...new Set(userIds)].filter((id) => Number.isInteger(id) && id > 0);

  await Promise.all(
    unique.map(async (userId) => {
      try {
        const ctx = await getExecutionWalletForUser(userId);
        const walletId = ctx.walletId;
        let hasClobCredentials = false;
        try {
          hasClobCredentials = !!(await getDecryptedClobCredsForWalletIfValid(walletId));
        } catch {
          hasClobCredentials = false;
        }
        out.set(userId, {
          walletId,
          executionAddress: ctx.address?.trim() ?? null,
          depositFunderAddress: (ctx.polymarketFunderAddress ?? '').trim() || null,
          hasClobCredentials,
        });
      } catch (error) {
        console.warn('[copy-runtime] wallet snapshot failed for user', {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
        out.set(userId, { ...EMPTY_SNAPSHOT });
      }
    })
  );

  return out;
}

/**
 * Execution wallet resolution for Polymarket (custodial / GO_REMOTE only).
 * Legacy managed-session / SMART_WALLET flows have been removed in favor of a single deposit-wallet model.
 */
import { isAddress } from 'viem';
import { prisma } from '../../db';
import { getCustodialExecutionWallet } from '../custody/custody';
import { resolveExecutionWalletForTrading } from './executionWallet';

export type AutomationPermissionAction = 'BUY' | 'SELL' | 'REDEEM';

export type ExecutionWalletContext = Awaited<ReturnType<typeof resolveExecutionWalletForTrading>>;

export async function ensureAuthorizationOwnerAddress(userId: number, address: string) {
  if (!isAddress(address)) {
    throw new Error('Invalid address');
  }
  await getCustodialExecutionWallet(userId, address);
}

export async function getExecutionWalletForUser(
  userId: number,
  expectedAddress?: string
): Promise<ExecutionWalletContext> {
  return resolveExecutionWalletForTrading(userId, expectedAddress);
}

export async function assertAutomationPermission(_params: {
  userId: number;
  action: AutomationPermissionAction;
  expectedAddress?: string;
  notionalUsd?: number;
}) {
  await getExecutionWalletForUser(_params.userId, _params.expectedAddress);
}

export async function recordAutomationAction(_params: {
  userId: number;
  action: string;
  expectedAddress?: string;
  notionalUsd?: number;
  txHash?: string;
  referenceId?: string;
}) {
  /* Session-grant analytics removed; custodial execution does not log here. */
}

export async function listRedeemExecutionTargets(): Promise<
  Array<{ userId: number; address: string; expectedAddress?: string }>
> {
  const rows = await prisma.userCustodialKey.findMany({
    include: { wallet: true },
  });
  return rows
    .filter((row) => row.wallet.type === 'CUSTODIAL')
    .map((row) => ({
      userId: row.userId,
      address: row.wallet.address,
      expectedAddress: row.wallet.address,
    }));
}

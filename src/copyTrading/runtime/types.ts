import type { CopySubscription } from '../../generated/prisma/client';

export type CopyMode = CopySubscription['copyMode'];
export type CopyMinNotionalMode = 'SKIP' | 'BUMP_TO_MIN';

export type RobotRuntimeState = {
  /** 与 CopySubscription.id 相同 */
  robotId: string;
  subscriptionId: string;
  userId: number;
  leaderId: string;
  /** 已规范为小写 */
  leaderAddress: string;
  enabled: true;
  copyMode: CopyMode;
  copyRatio: number;
  fixedAmountUsd: number | null;
  minNotionalMode: CopyMinNotionalMode;
  maxAmount: number | null;
  minAmount: number | null;
  slippage: number | null;
  walletId: number | null;
  executionAddress: string | null;
  depositFunderAddress: string | null;
  hasClobCredentials: boolean;
  updatedAt: string;
  loadedAt: string;
};

export type RobotRuntimeStats = {
  totalRobots: number;
  leaderCount: number;
  uniqueUserCount: number;
  topLeaders: Array<{ leaderAddress: string; robotCount: number }>;
};

export type UserWalletRuntimeSnapshot = {
  walletId: number | null;
  executionAddress: string | null;
  depositFunderAddress: string | null;
  hasClobCredentials: boolean;
};

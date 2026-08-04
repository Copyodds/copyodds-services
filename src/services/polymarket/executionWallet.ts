import type { Signer as EthersSigner } from 'ethers';
import { createWalletClient } from 'viem';
import { CONFIG } from '../../config/env';
import { getCustodialExecutionWallet } from '../custody/custody';

/** 托管执行钱包：一律 Go wallet-api（GO_REMOTE），签名见 custody 层 */
export const GO_WALLET_SERVICE_URL = process.env.GO_WALLET_SERVICE_URL?.trim() ?? '';

export type ExecutionWalletProviderKind = 'db_custodial';

export function getExecutionWalletProviderKind(): ExecutionWalletProviderKind {
  return 'db_custodial';
}

export interface ExecutionWalletProvider {
  resolveExecutionWallet(
    userId: number,
    expectedAddress?: string
  ): Promise<{
    mode: 'legacy';
    provider: string;
    address: string;
    walletId: number;
    signer: EthersSigner;
    walletClient: ReturnType<typeof createWalletClient>;
    polymarketFunderAddress?: string | null;
  }>;
}

class DbCustodialExecutionProvider implements ExecutionWalletProvider {
  async resolveExecutionWallet(userId: number, expectedAddress?: string) {
    const legacy = await getCustodialExecutionWallet(userId, expectedAddress);
    const providerLabel =
      CONFIG.tradingExecutionMode === 'demo_custodial' ? 'DEMO_CUSTODIAL' : 'CUSTODIAL_SERVER';
    return {
      mode: 'legacy' as const,
      provider: providerLabel,
      address: legacy.address,
      walletId: legacy.walletId,
      signer: legacy.signer as EthersSigner,
      walletClient: legacy.walletClient,
      polymarketFunderAddress: legacy.polymarketFunderAddress ?? null,
    };
  }
}

let defaultProvider: ExecutionWalletProvider | null = null;

export function getDefaultExecutionWalletProvider(): ExecutionWalletProvider {
  if (!defaultProvider) {
    defaultProvider = new DbCustodialExecutionProvider();
  }
  return defaultProvider;
}

export async function resolveExecutionWalletForTrading(userId: number, expectedAddress?: string) {
  return getDefaultExecutionWalletProvider().resolveExecutionWallet(userId, expectedAddress);
}

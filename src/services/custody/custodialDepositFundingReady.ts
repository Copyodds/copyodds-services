import { getCustodialWalletForUser } from './custody';
import type { CustodialOpenPolymarketSummary } from './custodialWalletOpen';
import {
  depositWalletHasOnChainCode,
  isPolymarketRelayerBuilderConfigured,
} from '../polymarket/polymarketRelayerDeposit';
import {
  getPolymarketCredentialStatus,
} from '../polymarket/polymarketAuth';

export type CustodialDepositFundingReadyCheck = {
  ready: boolean;
  reasons: string[];
  custodyAddress?: string;
  depositAddress?: string;
  onchainDeployed?: boolean;
  relayerConfigured: boolean;
  polymarket?: CustodialOpenPolymarketSummary;
};

export function buildCustodialDepositFundingReadyMessage(check: CustodialDepositFundingReadyCheck): string {
  if (check.ready) {
    return '托管充值通道已就绪';
  }
  if (check.reasons.includes('deposit_not_deployed_on_chain')) {
    return 'Polymarket deposit 合约尚未在链上部署（WALLET-CREATE 未完成），请完成 POST /api/custody/open 后再充值';
  }
  if (check.reasons.includes('relayer_not_provisioned')) {
    return 'Polymarket deposit Relayer 注册未完成，请重试 POST /api/custody/open';
  }
  if (check.reasons.includes('polymarket_not_bound')) {
    return 'Polymarket 授权未完成，请重试 POST /api/custody/open';
  }
  if (check.reasons.includes('no_custodial_wallet')) {
    return '托管钱包未开通，请先 POST /api/custody/open';
  }
  return '托管充值通道未就绪，请先完成 POST /api/custody/open';
}

export async function evaluateCustodialDepositFundingReady(
  userId: number,
  open?: {
    address: string;
    polymarketResult: CustodialOpenPolymarketSummary;
  },
): Promise<CustodialDepositFundingReadyCheck> {
  const reasons: string[] = [];
  const relayerConfigured = isPolymarketRelayerBuilderConfigured();

  let custodyAddress = open?.address;
  let polymarket = open?.polymarketResult;

  if (!custodyAddress) {
    try {
      const w = await getCustodialWalletForUser(userId);
      custodyAddress = w.address;
      if (!polymarket) {
        const status = await getPolymarketCredentialStatus(userId, w.address).catch(() => ({ bound: false as const }));
        polymarket = {
          bound: status.bound,
          walletAddress: 'walletAddress' in status ? status.walletAddress : w.address,
          polymarketFunderAddress:
            w.polymarketFunderAddress ??
            ('polymarketFunderAddress' in status ? status.polymarketFunderAddress : null),
        };
      }
    } catch {
      return {
        ready: false,
        reasons: ['no_custodial_wallet'],
        relayerConfigured,
      };
    }
  }

  if (!polymarket?.bound) {
    reasons.push('polymarket_not_bound');
    if (polymarket?.authError) {
      reasons.push(`polymarket_auth_error:${polymarket.authError}`);
    }
  }

  const deposit = (polymarket?.polymarketFunderAddress ?? '').trim();
  if (!deposit || deposit.toLowerCase() === custodyAddress.toLowerCase()) {
    reasons.push('no_deposit_address');
  }

  let onchainDeployed: boolean | undefined;
  if (deposit) {
    onchainDeployed = await depositWalletHasOnChainCode(deposit);
    if (relayerConfigured && !onchainDeployed) {
      reasons.push('deposit_not_deployed_on_chain');
    }
  }

  // relayerDepositProvisioned 仅 open workflow 内存态；独立查询时以链上部署为准
  if (relayerConfigured && !polymarket?.relayerDepositProvisioned && onchainDeployed !== true) {
    reasons.push('relayer_not_provisioned');
    if (polymarket?.relayerProvisionError) {
      reasons.push(`relayer_error:${polymarket.relayerProvisionError}`);
    }
  }

  return {
    ready: reasons.length === 0,
    reasons,
    custodyAddress,
    depositAddress: deposit || undefined,
    onchainDeployed,
    relayerConfigured,
    polymarket,
  };
}

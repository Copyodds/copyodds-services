import { formatUnits, getAddress } from 'viem';
import { publicClient, PUSD_TOKEN, USDC_E_ADDRESS, WCOL_TOKEN } from './web3';
import { sumUsdcETransferInToRecipient } from './redeemProceedsFromChainParse';

const COLLATERAL_DECIMALS = 6;

export type RedeemChainProceedsResult =
  | { kind: 'confirmed'; usd: number }
  | { kind: 'unavailable' };

/**
 * 从 receipt 汇总转入 deposit 的 USDC.e + pUSD + WCOL（WCOL≈USDC.e，neg-risk CTF 直兑可能先入 WCOL）。
 */
export async function resolveRedeemUsdcProceedsFromChain(
  txHash: string,
  recipientAddress: string,
): Promise<RedeemChainProceedsResult> {
  const hash = txHash.trim().toLowerCase();
  if (!/^0x[a-f0-9]{64}$/.test(hash)) return { kind: 'unavailable' };

  let recipient: `0x${string}`;
  try {
    recipient = getAddress(recipientAddress.trim() as `0x${string}`);
  } catch {
    return { kind: 'unavailable' };
  }

  let receipt;
  try {
    receipt = await publicClient.getTransactionReceipt({ hash: hash as `0x${string}` });
  } catch {
    return { kind: 'unavailable' };
  }
  if (!receipt?.logs?.length) return { kind: 'unavailable' };

  const rawUsdc = sumUsdcETransferInToRecipient(receipt.logs, recipient, USDC_E_ADDRESS);
  const rawPusd = sumUsdcETransferInToRecipient(receipt.logs, recipient, PUSD_TOKEN);
  const rawWcol = sumUsdcETransferInToRecipient(receipt.logs, recipient, WCOL_TOKEN);
  const usd = Number(formatUnits(rawUsdc + rawPusd + rawWcol, COLLATERAL_DECIMALS));
  if (!Number.isFinite(usd)) return { kind: 'unavailable' };
  return { kind: 'confirmed', usd: Math.max(0, usd) };
}

/**
 * 返回 USD 数值（6 位小数）；无法解析或金额为 0 时返回 null。
 */
export async function fetchRedeemUsdcProceedsUsd(
  txHash: string,
  recipientAddress: string,
): Promise<number | null> {
  const result = await resolveRedeemUsdcProceedsFromChain(txHash, recipientAddress);
  if (result.kind !== 'confirmed' || result.usd <= 0) return null;
  return result.usd;
}

export { sumUsdcETransferInToRecipient } from './redeemProceedsFromChainParse';

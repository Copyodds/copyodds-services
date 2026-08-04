/**
 * NegRiskAdapter redeem calldata helpers (no env / RPC deps).
 * Official path: builder-relayer-client examples/redeem.ts
 */
import { encodeFunctionData, padHex, type Hex } from 'viem';
import { createConflictError } from '../../utils/appError';

const NEG_RISK_ADAPTER_REDEEM_ABI = [
  {
    type: 'function',
    name: 'redeemPositions',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_conditionId', type: 'bytes32' },
      { name: '_amounts', type: 'uint256[]' },
    ],
    outputs: [],
  },
] as const;

export function normalizeConditionIdToBytes32(conditionId: string): Hex {
  const hex = (conditionId.startsWith('0x') ? conditionId : `0x${conditionId}`) as Hex;
  return padHex(hex, { size: 32 });
}

/** Data API size（份额）→ CTF raw（6 decimals）。 */
export function sharesToConditionalTokenRaw(size: number): bigint {
  if (!Number.isFinite(size) || size <= 0) return 0n;
  const fixed = size.toFixed(6);
  const [whole, frac = ''] = fixed.split('.');
  return BigInt(whole) * 1_000_000n + BigInt((frac + '000000').slice(0, 6));
}

/**
 * NegRiskAdapter.redeemPositions(conditionId, [yes, no]) 的 amounts。
 * outcomeIndex 0=YES、1=NO；多结果市场通常各自独立 condition，仍按 binary 传。
 */
export function buildNegRiskAdapterRedeemAmounts(params: {
  outcomeIndex: number;
  size?: number;
  yesRaw?: bigint;
  noRaw?: bigint;
}): readonly [bigint, bigint] {
  if (params.yesRaw != null || params.noRaw != null) {
    return [params.yesRaw ?? 0n, params.noRaw ?? 0n];
  }
  const raw = sharesToConditionalTokenRaw(params.size ?? 0);
  const idx = params.outcomeIndex;
  if (!Number.isInteger(idx) || idx < 0) {
    throw createConflictError('Invalid outcomeIndex for NegRiskAdapter redeem');
  }
  if (idx === 0) return [raw, 0n];
  if (idx === 1) return [0n, raw];
  // 少见：多结果仍按「持有侧非零」传；NegRiskAdapter 官方示例仅 length=2
  return [raw, 0n];
}

export function encodeNegRiskAdapterRedeemCall(params: {
  conditionId: string;
  amounts: readonly [bigint, bigint];
}): `0x${string}` {
  return encodeFunctionData({
    abi: NEG_RISK_ADAPTER_REDEEM_ABI,
    functionName: 'redeemPositions',
    args: [normalizeConditionIdToBytes32(params.conditionId), [...params.amounts]],
  });
}

/** 纯逻辑，供单测与 dispatch 预检复用（不拉 env / RPC） */

export const ORDER_FUNDING_BUFFER_RATIO = 0.05;

export type CopyOrderFundingPrecheckResult =
  | { ok: true }
  | {
      ok: false;
      errorCode:
        | 'user_collateral_insufficient'
        | 'user_allowance_required'
        | 'user_token_approval_required'
        | 'user_gas_insufficient';
      errorMsg: string;
    };

export function requiredUsdWithBuffer(requiredUsd: number): number {
  if (!(requiredUsd > 0)) return 0;
  return requiredUsd * (1 + ORDER_FUNDING_BUFFER_RATIO);
}

export function evaluateBuyCollateralPrecheck(params: {
  depositUsd: number;
  hasDeposit: boolean;
  requiredUsd: number;
}): CopyOrderFundingPrecheckResult {
  const need = requiredUsdWithBuffer(params.requiredUsd);
  if (!params.hasDeposit) {
    return {
      ok: false,
      errorCode: 'user_collateral_insufficient',
      errorMsg:
        '未检测到独立的 Polymarket deposit 钱包，无法跟单买入；请先在钱包页完成 Polymarket 绑定与充值。',
    };
  }
  if (!(params.depositUsd >= need)) {
    return {
      ok: false,
      errorCode: 'user_collateral_insufficient',
      errorMsg: `Polymarket deposit 抵押不足：约需 $${need.toFixed(2)}（含缓冲），当前约 $${params.depositUsd.toFixed(2)}；请充值或完成 USDC→pUSD 准备后再试。`,
    };
  }
  return { ok: true };
}

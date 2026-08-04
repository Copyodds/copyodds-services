import { ethers } from 'ethers';
import { PUSD_TOKEN } from '../services/polymarket/web3';

/** CLOB V2：向 Exchange 等 spender 授权的是 pUSD，不是 USDC.e */
const COLLATERAL_ERC20 = PUSD_TOKEN;
/** 与 CONFIG.clobSpender 默认一致（CTF Exchange V2） */
const DEFAULT_CLOB_SPENDER = '0xE111180000d2663C0091e4f400237545B87B996B';
const MIN_POLYGON_PRIORITY_FEE_GWEI = 25;

/** Polymarket Conditional Tokens (ERC1155) — same for standard and neg-risk markets */
const CTF_CONTRACT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) public returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const ERC1155_ABI = [
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function isApprovedForAll(address account, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved) external',
];

/**
 * Polygon EIP-1559 / legacy fee overrides (matches ensureAllowance gas bumping).
 */
async function resolvePolygonFeeOverrides(signer: ethers.Signer) {
  if (!signer.provider) {
    throw new Error('Signer provider is missing; cannot estimate fees');
  }
  const feeData = await signer.provider.getFeeData();
  const txOptions: {
    maxFeePerGas?: ethers.BigNumber;
    maxPriorityFeePerGas?: ethers.BigNumber;
    gasPrice?: ethers.BigNumber;
    gasLimit?: ethers.BigNumber;
  } = {};

  const network = await signer.provider.getNetwork();
  if (network.chainId !== 137) {
    throw new Error(`Unsupported chainId ${network.chainId}; expected Polygon (137)`);
  }

  const minTip = ethers.utils.parseUnits(String(MIN_POLYGON_PRIORITY_FEE_GWEI), 'gwei');
  const bump = (v: ethers.BigNumber) => v.mul(12).div(10);

  if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
    const tip = ethers.BigNumber.from(feeData.maxPriorityFeePerGas);
    const priority = bump(tip.lt(minTip) ? minTip : tip);
    const latestBlock = await signer.provider.getBlock('latest').catch(() => null);
    const baseFee = latestBlock?.baseFeePerGas ? ethers.BigNumber.from(latestBlock.baseFeePerGas) : null;
    const suggestedMaxFee = feeData.maxFeePerGas ? ethers.BigNumber.from(feeData.maxFeePerGas) : undefined;
    const maxFeeFromBase = baseFee ? baseFee.mul(2).add(priority) : undefined;
    const maxFeeCandidate =
      suggestedMaxFee && maxFeeFromBase
        ? suggestedMaxFee.gt(maxFeeFromBase)
          ? suggestedMaxFee
          : maxFeeFromBase
        : suggestedMaxFee ?? maxFeeFromBase ?? priority;
    const maxFee = bump(maxFeeCandidate);
    txOptions.maxPriorityFeePerGas = priority;
    txOptions.maxFeePerGas = maxFee;
  } else if (feeData.gasPrice) {
    const gp = ethers.BigNumber.from(feeData.gasPrice);
    txOptions.gasPrice = bump(gp.lt(minTip) ? minTip : gp);
  } else {
    txOptions.gasPrice = bump(minTip);
  }

  return txOptions;
}

export async function ensureAllowance(
  signer: ethers.Signer,
  requiredAmount: ethers.BigNumber,
  spender: string = DEFAULT_CLOB_SPENDER
) {
  return ensureAllowances(signer, requiredAmount, [spender]);
}

export async function ensureAllowances(
  signer: ethers.Signer,
  requiredAmount: ethers.BigNumber,
  spenders: string[]
) {
  if (!signer.provider) {
    throw new Error('Signer provider is missing; cannot check/approve allowance');
  }

  const address = await signer.getAddress();
  const collateral = new ethers.Contract(COLLATERAL_ERC20, ERC20_ABI, signer);
  const uniqueSpenders = Array.from(
    new Set(
      spenders
        .map((spender) => spender.trim())
        .filter(Boolean)
        .map((spender) => spender.toLowerCase())
    )
  );

  if (!uniqueSpenders.length) {
    throw new Error('No spender provided for collateral (pUSD) allowance check');
  }

  for (const spender of uniqueSpenders) {
    const currentAllowance: ethers.BigNumber = await collateral.allowance(address, spender);

    if (currentAllowance.gte(requiredAmount)) {
      console.log(`pUSD allowance is sufficient for ${spender}`);
      continue;
    }

    const txOptions = await resolvePolygonFeeOverrides(signer);
    console.log(`pUSD allowance is insufficient for ${spender}, approving MaxUint256...`);
    try {
      const estimated = await collateral.estimateGas.approve(spender, ethers.constants.MaxUint256);
      txOptions.gasLimit = estimated.mul(12).div(10);
    } catch {
      // ignore
    }
    const tx = await collateral.approve(spender, ethers.constants.MaxUint256, txOptions);
    await tx.wait();
    console.log(`pUSD approve completed for ${spender}`);
  }
}

/**
 * SELL 前：授权 CTF Exchange 合约转移用户的 outcome ERC1155（Polymarket CLOB 要求）。
 * exchangeAddress：标准 `CLOB_SPENDER` 或 neg-risk `CLOB_SPENDER_NEG_RISK`。
 */
export async function ensureConditionalSellApproval(
  signer: ethers.Signer,
  exchangeAddress: string
): Promise<void> {
  return ensureConditionalSellApprovals(signer, [exchangeAddress]);
}

export async function ensureConditionalSellApprovals(
  signer: ethers.Signer,
  operatorAddresses: string[]
): Promise<void> {
  if (!signer.provider) {
    throw new Error('Signer provider is missing; cannot approve conditional tokens');
  }

  const owner = await signer.getAddress();
  const ctf = new ethers.Contract(CTF_CONTRACT, ERC1155_ABI, signer);
  const uniqueOperators = Array.from(
    new Set(
      operatorAddresses
        .map((address) => address.trim())
        .filter(Boolean)
        .map((address) => address.toLowerCase())
    )
  );

  if (!uniqueOperators.length) {
    throw new Error('No operator provided for conditional token approval');
  }

  for (const operatorAddress of uniqueOperators) {
    const approved = await ctf.isApprovedForAll(owner, operatorAddress);
    if (approved) {
      console.log(`CTF setApprovalForAll already enabled for ${operatorAddress}`);
      continue;
    }

    const txOptions = await resolvePolygonFeeOverrides(signer);
    try {
      const estimated = await ctf.estimateGas.setApprovalForAll(operatorAddress, true);
      txOptions.gasLimit = estimated.mul(12).div(10);
    } catch {
      // ignore
    }

    console.log(`CTF setApprovalForAll for operator ${operatorAddress} (SELL)...`);
    const tx = await ctf.setApprovalForAll(operatorAddress, true, txOptions);
    await tx.wait();
    console.log(`CTF setApprovalForAll completed for ${operatorAddress}`);
  }
}

/**
 * 分步诊断 Polymarket deposit Relayer 注册 / wrap 前置条件。
 *
 * 用法（在 polymarket-backend 目录，加载与 pm2 相同的 .env）：
 *   npx tsx scripts/diagnose-deposit-relayer-register.ts 9
 *   npx tsx scripts/diagnose-deposit-relayer-register.ts 9 --wallet-create-only
 *   npx tsx scripts/diagnose-deposit-relayer-register.ts 9 --try-wrap
 *
 * 说明：
 * - 独立进程不受 pm2 内 registry_stuck 熔断影响；若本脚本 STEP 5 成功但 POST /open 仍报「注册状态异常」，先 pm2 restart backend。
 * - --try-register / --try-wrap 会真实调用 Relayer（消耗 Builder 配额）。
 */
import '../src/loadEnv';
import { ethers } from 'ethers';
import { getAddress, type Address } from 'viem';
import { CONFIG } from '../src/config/env';
import { prisma } from '../src/db';
import { getCustodialWalletForUser } from '../src/services/custody/custody';
import {
  getBuilderCredentialSlotStatus,
  listBuilderCredentialSlots,
} from '../src/services/polymarket/polymarketBuilderCredentials';
import {
  assertRelayDerivedDepositMatches,
  collectDepositPusdCtfRelayerCalls,
  createDepositRelayClientForCustodialUser,
  depositWalletHasOnChainCode,
  ensureDepositWalletRelayerRegisteredWithRecovery,
  ensurePolymarketDepositTradingApprovalsViaRelayer,
  isPolymarketRelayerBuilderConfigured,
  isRelayerQuotaCooldownActive,
  relayerThrownMessage,
  waitRelayerTxSuccess,
} from '../src/services/polymarket/polymarketRelayerDeposit';
import { persistPolymarketWalletCreateRelayerTxId, loadPolymarketWalletCreateRelayerTxId } from '../src/services/polymarket/polymarketWalletCreateRelayerTx';
import { describeDepositWalletDerivation, resolvePolymarketDepositWalletAddress } from '../src/services/polymarket/polymarketDepositWalletDerive';
import { tryAutoWrapPolymarketDepositUsdce } from '../src/services/polymarket/polymarketDepositAutoWrap';
import { getPusdBalance, getUsdcBalance } from '../src/services/polymarket/web3';

const userId = Number.parseInt(process.argv[2] ?? '9', 10);
const tryRegister = process.argv.includes('--try-register');
const tryWrap = process.argv.includes('--try-wrap');
const tryWalletCreateOnly = process.argv.includes('--wallet-create-only');

function step(n: number, title: string): void {
  console.log(`\n${'='.repeat(60)}\nSTEP ${n}: ${title}\n${'='.repeat(60)}`);
}

function printOk(label: string, detail?: unknown): void {
  console.log(`  OK   ${label}`);
  if (detail !== undefined) {
    console.log('       ', JSON.stringify(detail, null, 2).split('\n').join('\n        '));
  }
}

function printFail(label: string, detail?: unknown): void {
  console.log(`  FAIL ${label}`);
  if (detail !== undefined) {
    console.log('       ', typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2));
  }
}

async function main(): Promise<void> {
  if (!Number.isFinite(userId) || userId <= 0) {
    console.error('usage: npx tsx scripts/diagnose-deposit-relayer-register.ts <userId> [--try-register] [--try-wrap]');
    process.exit(1);
  }

  console.log(`diagnose-deposit-relayer-register userId=${userId} tryRegister=${tryRegister} tryWrap=${tryWrap} tryWalletCreateOnly=${tryWalletCreateOnly}`);

  step(1, '环境 & Builder 凭证');
  printOk('chainId', { chainId: CONFIG.chainId });
  printOk('relayerUrl', { url: CONFIG.polymarketRelayerUrl ?? '(default)' });
  printOk('autoWrap', { enabled: CONFIG.autoWrapPolymarketDepositUsdce });
  const builderOk = isPolymarketRelayerBuilderConfigured();
  if (!builderOk) {
    printFail('POLYMARKET_BUILDER_* 未配置完整');
    process.exit(1);
  }
  printOk('builderConfigured', true);
  const slots = getBuilderCredentialSlotStatus();
  for (const s of slots) {
    const line = s.available
      ? `slot ${s.id} (${s.label}) key=${s.keyPrefix}… available`
      : `slot ${s.id} (${s.label}) key=${s.keyPrefix}… COOLDOWN ${Math.ceil(s.cooldownRemainingMs / 1000)}s`;
    console.log(`  - ${line}`);
  }
  if (isRelayerQuotaCooldownActive()) {
    printFail('所有 Builder slot 均在配额冷却中，WALLET-CREATE / wrap 都会失败');
  } else {
    printOk('至少一个 Builder slot 可用', { count: listBuilderCredentialSlots().length });
  }

  step(2, '数据库钱包');
  let custodial: string;
  let deposit: string;
  try {
    const w = await getCustodialWalletForUser(userId);
    custodial = ethers.utils.getAddress(w.address);
    const funder = (w.polymarketFunderAddress ?? '').trim();
    if (!funder) {
      printFail('polymarketFunderAddress 为空，需先 authorize-polymarket');
      process.exit(1);
    }
    deposit = ethers.utils.getAddress(funder);
    printOk('custodial EOA', { address: custodial });
    printOk('deposit (funder)', { address: deposit });
    const row = await prisma.wallet.findFirst({
      where: { userId, type: 'CUSTODIAL' } as any,
      select: { signingProvider: true, walletIndex: true },
    });
    printOk('wallet meta', row);
  } catch (e) {
    printFail('getCustodialWalletForUser', relayerThrownMessage(e));
    process.exit(1);
  }

  step(3, '链上 deposit 状态');
  const onchainCode = await depositWalletHasOnChainCode(deposit);
  printOk('deposit 合约字节码', { onchainDeployed: onchainCode });
  const [usdce, pusd] = await Promise.all([
    getUsdcBalance(deposit as Address),
    getPusdBalance(deposit as Address),
  ]);
  printOk('余额', {
    usdcE: usdce.formatted,
    usdcERaw: usdce.raw.toString(),
    pUsd: pusd.formatted,
    pUsdRaw: pusd.raw.toString(),
  });
  if (usdce.raw > 0n && pusd.raw === 0n) {
    console.log('  >> 有 USDC.e 未 wrap，注册成功后需执行 wrap');
  }

  step(4, 'RelayClient 推导 deposit 地址');
  let relayCtx;
  try {
    relayCtx = await createDepositRelayClientForCustodialUser(userId, custodial);
    printOk('relay client', { slotId: relayCtx.slotId });
    const derived = ethers.utils.getAddress(await relayCtx.relayClient.deriveDepositWalletAddress());
    const resolved = ethers.utils.getAddress(
      await resolvePolymarketDepositWalletAddress(custodial, CONFIG.chainId),
    );
    const resolvedMatch = resolved.toLowerCase() === deposit.toLowerCase();
    const relayDeriveMatch = derived.toLowerCase() === deposit.toLowerCase();
    if (resolvedMatch) {
      printOk('resolvePolymarketDepositWalletAddress 与 DB 一致（活跃 funder）', {
        resolved,
        relayerDeriveUups: derived,
        relayerDeriveMatchesDb: relayDeriveMatch,
      });
    } else {
      const variants = describeDepositWalletDerivation(custodial, CONFIG.chainId);
      printFail('resolvePolymarketDepositWalletAddress 与 DB 不一致', {
        resolved,
        relayerDeriveUups: derived,
        stored: deposit,
        beaconProxy: variants.beaconProxy,
        hint:
          deposit.toLowerCase() === derived.toLowerCase()
            ? 'DB 误存 UUPS；WALLET-CREATE 链上部署 Beacon。npm run backfill:polymarket-funder-repair -- <userId>'
            : '检查 owner 地址、chainId 或是否多钱包',
      });
      process.exit(1);
    }
    await assertRelayDerivedDepositMatches(relayCtx.relayClient, deposit, custodial);
    printOk('assertRelayDerivedDepositMatches');
  } catch (e) {
    printFail('relay derive', relayerThrownMessage(e));
    process.exit(1);
  }

  step(5, '待授权 Relayer 调用（只读）');
  const approvalCalls = await collectDepositPusdCtfRelayerCalls(deposit as Address);
  printOk('collectDepositPusdCtfRelayerCalls', {
    pendingCallCount: approvalCalls.length,
    targets: approvalCalls.map((c) => c.target),
  });

  if (!tryRegister && !tryWalletCreateOnly) {
    console.log('\n  (跳过 STEP 6–7：加 --try-register 或 --wallet-create-only 会真实提交 WALLET-CREATE)');
  } else {
    step(6, 'Relayer /deployed 与链上 bytecode 对比');
    let relayerDeployed = false;
    try {
      relayerDeployed = await relayCtx.relayClient.getDeployed(deposit, 'WALLET');
      printOk('relayer GET /deployed?address=deposit&type=WALLET', { relayerDeployed });
    } catch (e) {
      printFail('getDeployed(deposit)', relayerThrownMessage(e));
    }
    const onchainBefore = await depositWalletHasOnChainCode(deposit);
    printOk('链上 eth_getCode', { onchainDeployed: onchainBefore });
    if (relayerDeployed && !onchainBefore) {
      printFail('relayer-chain DESYNC', {
        relayerDeployed: true,
        onchainDeployed: false,
        hint: 'Relayer 认为已部署，链上无合约；WALLET-CREATE 会被 already deployed 拒绝，wrap 会 not registered',
      });
    }

    step(7, '原始 deployDepositWallet()（隔离，看 Relayer 原始响应）');
    try {
      const pendingTxId = await loadPolymarketWalletCreateRelayerTxId(deposit);
      if (pendingTxId) {
        printOk('DB 已有 WALLET-CREATE transactionID，跳过重复 submit', { pendingTxId });
        console.log('  >> 将 poll 该 tx 至 STATE_CONFIRMED（最多 15 分钟）');
        const txn = await waitRelayerTxSuccess(relayCtx.relayClient, pendingTxId, {
          reasonCode: 'POLYMARKET_RELAYER_DEPLOY_TIMEOUT',
          message: 'WALLET-CREATE 确认超时',
        });
        printOk('pending WALLET-CREATE 已确认', {
          transactionID: pendingTxId,
          state: txn.state,
          transactionHash: txn.transactionHash ?? null,
        });
      } else {
        const raw = await relayCtx.relayClient.deployDepositWallet();
        await persistPolymarketWalletCreateRelayerTxId({
          depositAddress: deposit,
          relayerTransactionId: raw.transactionID,
        });
        printOk('deployDepositWallet 提交成功', {
          transactionID: raw.transactionID,
          transactionHash: raw.transactionHash ?? null,
          state: (raw as { state?: string }).state ?? null,
        });
        console.log('  >> poll 至 STATE_CONFIRMED…');
        const txn = await waitRelayerTxSuccess(relayCtx.relayClient, raw.transactionID, {
          reasonCode: 'POLYMARKET_RELAYER_DEPLOY_TIMEOUT',
          message: 'WALLET-CREATE 确认超时',
        });
        printOk('WALLET-CREATE 已确认', {
          state: txn.state,
          transactionHash: txn.transactionHash ?? null,
        });
      }
    } catch (e) {
      printFail('deployDepositWallet 原始错误', relayerThrownMessage(e));
      if (relayerDeployed && !onchainBefore) {
        console.log('  >> DESYNC：Relayer 已标记 deployed，拒绝重复 CREATE，但链上从未部署合约');
        console.log('  >> 0.11 USDC 在 counterfactual 地址上，需链上 deploy 成功才能 wrap');
      } else if (!onchainBefore) {
        console.log('  >> 链上无合约：若错误含 already/deployed，优先查 relayer GET /deployed');
      } else {
        console.log('  >> 若含 already/deployed 且链上有合约 → registry 可能未完成');
      }
      console.log('  >> 若含 quota exceeded → Builder 日配额用尽');
    }

    if (tryWalletCreateOnly) {
      console.log('\n  (--wallet-create-only：跳过 recovery / open / wrap)');
    } else {
    step(8, 'WALLET-CREATE recovery（ensureDepositWalletRelayerRegisteredWithRecovery）');
    try {
      const reg = await ensureDepositWalletRelayerRegisteredWithRecovery(
        relayCtx.relayClient,
        deposit,
        { slotId: relayCtx.slotId },
      );
      if (reg.relayerEndStateConfirmed) {
        printOk('relayer 注册已确认', reg);
      } else {
        printFail('relayer 注册未确认（链上可能有合约但 registry 未完成）', reg);
        console.log('  >> relayerEndStateConfirmed=false 时 wrap 一定失败');
        console.log('  >> 常见：benign conflict / STATE_FAILED / DEPLOY_SUBMIT_REJECTED / 配额');
      }
    } catch (e) {
      printFail('WALLET-CREATE recovery', relayerThrownMessage(e));
    }

    step(9, '完整 open 同源流程（ensurePolymarketDepositTradingApprovalsViaRelayer）');
    try {
      const prov = await ensurePolymarketDepositTradingApprovalsViaRelayer({
        userId,
        custodialAddress: custodial,
        depositAddress: deposit,
      });
      if (prov.depositWalletRelayerConfirmed === false) {
        printFail('relayerDepositProvision 未完全成功', prov);
      } else {
        printOk('relayerDepositProvision', prov);
      }
    } catch (e) {
      const msg = relayerThrownMessage(e);
      if (msg.includes('注册状态异常') || msg.includes('REGISTRY_STUCK')) {
        printFail('REGISTRY_STUCK（本脚本进程内熔断；pm2 需 restart 后重试 POST /open）', msg);
      } else {
        printFail('ensurePolymarketDepositTradingApprovalsViaRelayer', msg);
      }
    }
    }
  }

  if (!tryWrap) {
    console.log('\n  (跳过 STEP 10：加 --try-wrap 会真实提交 wrap 批次)');
  } else {
    step(10, 'Auto wrap（tryAutoWrapPolymarketDepositUsdce）');
    try {
      const wrap = await tryAutoWrapPolymarketDepositUsdce(userId);
      if (wrap.transactionHash) {
        printOk('wrap success', wrap);
      } else {
        printFail('wrap 未成功', wrap);
      }
    } catch (e) {
      printFail('wrap threw', relayerThrownMessage(e));
    }
  }

  step(11, '若 POST /open 仍失败');
  console.log(`  1. pm2 restart backend   # 清进程内 registry_stuck 熔断`);
  console.log(`  2. 确认 Builder 配额恢复（STEP 1 无 COOLDOWN）`);
  console.log(`  3. npx tsx scripts/diagnose-deposit-relayer-register.ts ${userId} --wallet-create-only`);
  console.log(`  4. npx tsx scripts/diagnose-deposit-relayer-register.ts ${userId} --try-register`);
  console.log(`  5. curl POST /api/custody/open 或 --try-wrap`);
}

main().catch((e) => {
  console.error('fatal', e);
  process.exit(1);
});

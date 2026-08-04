import assert from 'node:assert/strict';
import { Prisma } from '../../generated/prisma/client';

process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';

async function main() {
  const {
    classifyCopyOrderFailure,
    describeRiskReason,
    resolveCopyMarketCooldownKey,
    RiskService,
    shouldCountCopyFailureTowardStreak,
  } = await import('./riskService');

  assert.equal(
    resolveCopyMarketCooldownKey({ marketId: null, tokenId: '  tok-1  ' }),
    'tok-1',
    'cooldown must fall back to tokenId when marketId is missing'
  );
  assert.equal(
    resolveCopyMarketCooldownKey({ marketId: 'mkt-1', tokenId: 'tok-1' }),
    'mkt-1',
    'marketId takes priority over tokenId'
  );
  assert.equal(
    resolveCopyMarketCooldownKey({ marketId: '  ', tokenId: null }),
    null,
    'blank marketId/tokenId yields no cooldown key'
  );

  assert.equal(classifyCopyOrderFailure('429 too many requests').errorCode, 'clob_rate_limit');
  assert.equal(
    classifyCopyOrderFailure('clob_rate_limit: order is invalid. Size (4.39) lower than the minimum: 5').errorCode,
    'user_min_order_size'
  );
  assert.equal(
    classifyCopyOrderFailure('clob_service_unavailable: invalid price (2.350266), min: 0.01 - max: 0.99').errorCode,
    'clob_rejected'
  );
  assert.equal(
    classifyCopyOrderFailure('not enough balance / allowance: balance 0 allowance 0').errorCode,
    'user_collateral_insufficient'
  );
  assert.equal(
    classifyCopyOrderFailure('not enough balance / allowance: balance 5000000 allowance 0').errorCode,
    'user_allowance_required'
  );
  assert.equal(
    classifyCopyOrderFailure('not enough balance / allowance: balance 5000000 allowance 5000000').errorCode,
    'user_collateral_insufficient'
  );
  assert.equal(
    classifyCopyOrderFailure('卖出未成交：当前盘口没有可立即成交的买单').errorCode,
    'clob_no_liquidity'
  );
  assert.equal(
    classifyCopyOrderFailure(
      'BUY not filled: no immediately matchable sell liquidity; FAK canceled the unfilled amount.'
    ).countTowardFailStreak,
    false
  );
  assert.equal(
    classifyCopyOrderFailure(
      'BUY not filled: no immediately matchable sell liquidity within FAK price; unfilled amount canceled.'
    ).errorCode,
    'clob_no_liquidity'
  );
  assert.equal(classifyCopyOrderFailure('no match').countTowardFailStreak, false);
  assert.equal(
    shouldCountCopyFailureTowardStreak({
      errorCode: 'clob_no_liquidity',
      countTowardFailStreak: true,
    }),
    false,
    'liquidity skips must never trip fail streak even if flag is wrong'
  );
  const missingOrderbook = classifyCopyOrderFailure(
    'the orderbook 18882403361959347327569285170061744562682172594625320968533893251098938134883 does not exist'
  );
  assert.equal(missingOrderbook.errorCode, 'clob_orderbook_missing');
  assert.equal(missingOrderbook.retryable, false);
  assert.equal(missingOrderbook.countTowardFailStreak, false);
  assert.equal(classifyCopyOrderFailure('insufficient balance').countTowardFailStreak, false);
  assert.ok(describeRiskReason('daily_cap')?.includes('当日'));
  assert.ok(describeRiskReason('already_open_position')?.includes('未平仓'));

  const risk = new RiskService();
  assert.equal(typeof risk.evaluate, 'function');
  assert.equal(typeof risk.recordFilledNotional, 'function');
  assert.deepEqual(
    await risk.evaluate(
      {
        userId: 1,
        subscription: {
          id: 'sub-sell-exit',
          onlyBuy: false,
          onlySell: false,
          minAmountUsd: new Prisma.Decimal(10),
          maxAmount: new Prisma.Decimal(0.01),
          maxAmountPerMarketUsd: new Prisma.Decimal(0.01),
          dailyTotalCapUsd: new Prisma.Decimal(0.01),
          slippage: null,
          marketCooldownMinutes: 60,
          pauseAfterConsecutiveFails: 1,
          skipBuyIfOpenPosition: true,
        },
        leaderPrice: 0.95,
        notionalUsd: 0.1,
        originalNotionalUsd: 0.1,
        marketId: 'blocked-by-buy-guards',
        tokenId: 'token-sell-exit',
        side: 'SELL',
        minNotionalAdjusted: false,
      },
      0.95
    ),
    { ok: true }
  );

  console.log('riskService.test.ts: ok');
}

main();

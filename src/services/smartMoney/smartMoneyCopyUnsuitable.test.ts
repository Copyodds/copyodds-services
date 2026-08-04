import assert from 'node:assert/strict';
import test from 'node:test';

process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';

import {
  detectCopyUnsuitableFlags,
  estimateAccountAgeDaysFromJoinText,
  inferTradeCategoryBucket,
} from './smartMoneyCopyUnsuitable';
import type { DataApiTrade } from '../polymarket/polymarketTrades';
import type { DataApiPosition } from '../polymarket/polymarketData';
import { COPY_POOL_HARD_FLAGS } from './smartMoneyPipelineTypes';
import { hasCopyPoolHardFlag } from './smartMoneyTierGate';

const NOW = Date.parse('2026-07-20T12:00:00.000Z');

function trade(partial: Partial<DataApiTrade> & { timestamp: number }): DataApiTrade {
  return {
    side: 'BUY',
    size: 20,
    price: 0.92,
    title: 'Highest temperature in Beijing on July 20?',
    slug: 'highest-temperature-in-beijing-on-july-20',
    ...partial,
  };
}

function position(partial: Partial<DataApiPosition>): DataApiPosition {
  return {
    asset: '1',
    conditionId: 'c1',
    size: 25,
    avgPrice: 0.9,
    curPrice: 0.91,
    currentValue: 22,
    redeemable: false,
    title: 'Highest temperature in Taipei?',
    slug: 'highest-temperature-in-taipei',
    ...partial,
  };
}

test('inferTradeCategoryBucket maps weather titles to TEMPERATURE', () => {
  assert.equal(
    inferTradeCategoryBucket('Highest temperature in Beijing?', 'highest-temperature-beijing'),
    'TEMPERATURE'
  );
});

test('estimateAccountAgeDaysFromJoinText parses month-year text', () => {
  const days = estimateAccountAgeDaysFromJoinText('Mar 2026', NOW);
  assert.ok(days != null && days > 100 && days < 160);
});

test('weather HFT-like sample triggers soft flags + LIKELY_BOT + HIGH_TRADE_FREQUENCY', () => {
  const trades: DataApiTrade[] = Array.from({ length: 40 }, (_, i) =>
    trade({
      timestamp: Math.floor((NOW - i * 60_000) / 1000),
      size: 10,
      price: 0.94,
    })
  );
  const openPositions: DataApiPosition[] = Array.from({ length: 60 }, (_, i) =>
    position({
      asset: String(i + 1),
      conditionId: `c${i}`,
      currentValue: 18,
      title: `Highest temperature in city ${i}?`,
      slug: `highest-temperature-city-${i}`,
    })
  );

  const result = detectCopyUnsuitableFlags({
    trades,
    openPositions,
    predictionCount: 6111,
    accountAgeDays: 120,
    trades30d: 16000, // 日均>500 → HIGH_TRADE_FREQUENCY（现为软扣分）
    nowMs: NOW,
  });

  assert.equal(result.flags.includes('MICRO_CLIP_TRADING'), true);
  assert.equal(result.flags.includes('NARROW_EDGE_ENTRY'), true);
  assert.equal(result.flags.includes('CATEGORY_MONOCULTURE'), true);
  assert.equal(result.flags.includes('LIKELY_BOT'), true);
  assert.equal(result.flags.includes('HIGH_TRADE_FREQUENCY'), true);
  assert.ok((result.metrics.predictionsPerDay ?? 0) > 40);
  // HIGH_TRADE_FREQUENCY / LIKELY_BOT 均为软扣分，不硬拦 CopyPool
  assert.equal(hasCopyPoolHardFlag(result.flags), false);
  assert.equal(hasCopyPoolHardFlag(['LIKELY_BOT']), false);
});

test('COPY_POOL_HARD_FLAGS: unverified hard; frequency/short-horizon/bot soft', () => {
  assert.equal(
    (COPY_POOL_HARD_FLAGS as readonly string[]).includes('TRADE_FREQUENCY_UNVERIFIED'),
    true
  );
  assert.equal((COPY_POOL_HARD_FLAGS as readonly string[]).includes('LIKELY_BOT'), false);
  assert.equal((COPY_POOL_HARD_FLAGS as readonly string[]).includes('LOW_COPYABILITY'), false);
  assert.equal((COPY_POOL_HARD_FLAGS as readonly string[]).includes('HIGH_TRADE_FREQUENCY'), false);
  assert.equal((COPY_POOL_HARD_FLAGS as readonly string[]).includes('SHORT_HORIZON_MARKET'), false);
  assert.equal(
    (COPY_POOL_HARD_FLAGS as readonly string[]).includes('LOW_AVG_CLOSED_RETURN_RATE'),
    true
  );
  assert.equal(hasCopyPoolHardFlag(['TRADE_FREQUENCY_UNVERIFIED']), true);
  assert.equal(hasCopyPoolHardFlag(['MICRO_CLIP_TRADING']), false);
  assert.equal(hasCopyPoolHardFlag(['LIKELY_BOT']), false);
  assert.equal(hasCopyPoolHardFlag(['HIGH_TRADE_FREQUENCY']), false);
  assert.equal(hasCopyPoolHardFlag(['SHORT_HORIZON_MARKET']), false);
  assert.equal(hasCopyPoolHardFlag(['LOW_AVG_CLOSED_RETURN_RATE']), true);
});


test('30d avg between soft and hard yields ELEVATED_TRADE_FREQUENCY only', () => {
  const result = detectCopyUnsuitableFlags({
    trades: [],
    openPositions: [],
    predictionCount: 100,
    accountAgeDays: 200,
    trades30d: 9000,
    nowMs: NOW,
  });
  assert.equal(result.flags.includes('ELEVATED_TRADE_FREQUENCY'), true);
  assert.equal(result.flags.includes('HIGH_TRADE_FREQUENCY'), false);
  assert.equal(hasCopyPoolHardFlag(result.flags), false);
});

test('bitcoin 5m up-down sample triggers SHORT_HORIZON_MARKET', () => {
  const trades: DataApiTrade[] = Array.from({ length: 20 }, (_, i) =>
    trade({
      timestamp: Math.floor((NOW - i * 60_000) / 1000),
      size: 50,
      price: 0.5,
      title: `Bitcoin Up or Down - July 20, 4:${String(i).padStart(2, '0')}AM ET`,
      slug: `btc-updown-${i}`,
    })
  );
  const result = detectCopyUnsuitableFlags({
    trades,
    openPositions: [],
    predictionCount: 200,
    accountAgeDays: 60,
    trades30d: 40,
    nowMs: NOW,
  });
  assert.equal(result.flags.includes('SHORT_HORIZON_MARKET'), true);
  // 短周期盘改为软扣分，不硬拦 CopyPool
  assert.equal(hasCopyPoolHardFlag(result.flags), false);
});

test('diversified human-like sample does not flag as bot', () => {
  const trades: DataApiTrade[] = Array.from({ length: 12 }, (_, i) =>
    trade({
      timestamp: Math.floor((NOW - i * 86_400_000) / 1000),
      size: 200,
      price: 0.45,
      title: i % 2 === 0 ? 'Will Trump win?' : 'NBA Finals winner?',
      slug: i % 2 === 0 ? 'trump-election' : 'nba-finals',
    })
  );
  const openPositions: DataApiPosition[] = [
    position({
      asset: '1',
      currentValue: 500,
      title: 'Will Trump win?',
      slug: 'trump-election',
    }),
    position({
      asset: '2',
      conditionId: 'c2',
      currentValue: 400,
      title: 'NBA Finals winner?',
      slug: 'nba-finals',
    }),
  ];

  const result = detectCopyUnsuitableFlags({
    trades,
    openPositions,
    predictionCount: 80,
    accountAgeDays: 400,
    trades30d: 12,
    nowMs: NOW,
  });

  assert.equal(result.flags.includes('LIKELY_BOT'), false);
  assert.equal(result.flags.includes('HIGH_TRADE_FREQUENCY'), false);
  assert.equal(result.flags.includes('MICRO_CLIP_TRADING'), false);
});

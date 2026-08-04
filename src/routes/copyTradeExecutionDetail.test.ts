import assert from 'node:assert/strict';
import {
  buildExecutionDetailTimeline,
  isExecutionDetailViewable,
  resolveExecutionDetailViewState,
} from './copyTradeExecutionDetail';

assert.equal(
  resolveExecutionDetailViewState({
    status: 'filled',
    side: 'BUY',
    openLotRemaining: '1.5',
  }),
  'open'
);

assert.equal(
  resolveExecutionDetailViewState({
    status: 'filled',
    side: 'BUY',
    openLotRemaining: '0.001',
  }),
  null
);

assert.equal(
  resolveExecutionDetailViewState({
    status: 'filled',
    side: 'SELL',
    settlementType: 'market_sell',
    openLotRemaining: null,
  }),
  'settled'
);

assert.equal(
  resolveExecutionDetailViewState({
    status: 'failed',
    side: 'BUY',
    openLotRemaining: '2',
  }),
  null
);

assert.equal(
  isExecutionDetailViewable({
    status: 'filled',
    side: 'BUY',
    openLotRemaining: '2',
    _lifecycle: { buy: {}, settlement: {} },
  }),
  true
);

const timeline = buildExecutionDetailTimeline(
  {
    status: 'filled',
    side: 'SELL',
    settlementType: 'redeem',
    createdAt: '2026-01-02T00:00:00.000Z',
    price: '1',
    size: '10',
    realizedPnlUsd: '3',
    settlementResult: 'win',
    _lifecycle: {
      buy: {
        status: 'filled',
        side: 'BUY',
        createdAt: '2026-01-01T00:00:00.000Z',
        price: '0.7',
        size: '10',
        leaderAddress: '0xabc1230000000000000000000000000000000001',
      },
      settlement: {
        status: 'filled',
        side: 'SELL',
        settlementType: 'redeem',
        createdAt: '2026-01-02T00:00:00.000Z',
        price: '1',
        size: '10',
        realizedPnlUsd: '3',
        settlementResult: 'win',
      },
    },
  },
  'settled'
);

assert.equal(timeline.length, 2);
assert.equal(timeline[0]?.phase, 'buy');
assert.equal(
  timeline[0]?.leaderAddress,
  '0xabc1230000000000000000000000000000000001'
);
assert.equal(timeline[1]?.phase, 'settlement');
assert.equal(timeline[1]?.title, '赎回结算');

const sellOnlyTimeline = buildExecutionDetailTimeline(
  {
    status: 'filled',
    side: 'SELL',
    settlementType: 'market_sell',
    createdAt: '2026-07-27T06:38:38.000Z',
    price: '0.57',
    size: '2.97',
    realizedPnlUsd: '0.594',
    settlementResult: 'win',
  },
  'settled'
);
assert.equal(sellOnlyTimeline.length, 1);
assert.equal(sellOnlyTimeline[0]?.phase, 'settlement');

const withBuyLifecycleTimeline = buildExecutionDetailTimeline(
  {
    status: 'filled',
    side: 'SELL',
    settlementType: 'market_sell',
    createdAt: '2026-07-27T06:38:38.000Z',
    price: '0.57',
    size: '2.97',
    realizedPnlUsd: '0.594',
    settlementResult: 'win',
    _lifecycle: {
      buy: {
        status: 'filled',
        side: 'BUY',
        createdAt: '2026-07-27T04:57:00.000Z',
        price: '0.37',
        size: '2.973',
      },
      settlement: {
        status: 'filled',
        side: 'SELL',
        settlementType: 'market_sell',
        createdAt: '2026-07-27T06:38:38.000Z',
        price: '0.57',
        size: '2.97',
        realizedPnlUsd: '0.594',
        settlementResult: 'win',
      },
    },
  },
  'settled'
);
assert.equal(withBuyLifecycleTimeline.length, 2);
assert.equal(withBuyLifecycleTimeline[0]?.phase, 'buy');
assert.equal(withBuyLifecycleTimeline[0]?.title, '买入成交');
assert.equal(withBuyLifecycleTimeline[1]?.phase, 'settlement');

const multiBuyTimeline = buildExecutionDetailTimeline(
  {
    status: 'filled',
    side: 'SELL',
    settlementType: 'market_sell',
    createdAt: '2026-07-31T00:29:00.000Z',
    price: '0.61',
    size: '8.14',
    realizedPnlUsd: '0.244',
    settlementResult: 'win',
    _lifecycle: {
      buy: {
        status: 'filled',
        side: 'BUY',
        createdAt: '2026-07-30T10:00:00.000Z',
        price: '0.55',
        size: '4',
      },
      buys: [
        {
          status: 'filled',
          side: 'BUY',
          createdAt: '2026-07-30T10:00:00.000Z',
          price: '0.55',
          size: '4',
        },
        {
          status: 'filled',
          side: 'BUY',
          createdAt: '2026-07-30T12:00:00.000Z',
          price: '0.61',
          size: '4.14',
        },
      ],
      settlement: {
        status: 'filled',
        side: 'SELL',
        settlementType: 'market_sell',
        createdAt: '2026-07-31T00:29:00.000Z',
        price: '0.61',
        size: '8.14',
        realizedPnlUsd: '0.244',
        settlementResult: 'win',
      },
    },
  },
  'settled'
);
assert.equal(multiBuyTimeline.length, 3);
assert.equal(multiBuyTimeline[0]?.phase, 'buy');
assert.equal(multiBuyTimeline[0]?.at, '2026-07-30T10:00:00.000Z');
assert.equal(multiBuyTimeline[1]?.phase, 'buy');
assert.equal(multiBuyTimeline[1]?.at, '2026-07-30T12:00:00.000Z');
assert.equal(multiBuyTimeline[2]?.phase, 'settlement');
assert.equal(multiBuyTimeline[2]?.title, '平仓结算');

console.log('copyTradeExecutionDetail.test: ok');

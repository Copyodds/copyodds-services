import assert from 'node:assert/strict';
import {
  buildDisplayExecutionRows,
  withResolvedDisplayLeaderAddress,
} from './executionLifecycleDisplay';
import type {
  BuyLotCloseDetail,
  LotCloseBuyLink,
} from '../../copyTrading/services/copyPositionLots';

const base = {
  leaderAddress: '0xleader',
  tokenID: '12345',
  price: '0.94',
  status: 'filled',
  createdAt: '2026-06-07T09:33:33.000Z',
};

const buyOpen = {
  ...base,
  id: 'buy-open',
  side: 'BUY',
  size: '1.1277',
  openLotRemaining: '1.1277',
  createdAt: '2026-06-07T09:33:33.000Z',
};
const buyClosed = {
  ...base,
  id: 'buy-closed',
  side: 'BUY',
  size: '0.95',
  openLotRemaining: '0',
  createdAt: '2026-06-07T06:20:07.000Z',
};
const manualClose = {
  ...base,
  id: '99',
  leaderAddress: 'manual_close',
  side: 'SELL',
  size: '0.95',
  settlementType: 'market_sell' as const,
  closedSize: '0.95',
  costBasisUsd: '0.89',
  proceedsUsd: '0.88',
  realizedPnlUsd: '-0.01',
  createdAt: '2026-06-07T06:48:57.000Z',
};

const lotLinks = new Map<string, LotCloseBuyLink[]>([
  ['99', [{ buyRowId: 'buy-closed', closedSize: 0.95 }]],
]);

const pairedRows = buildDisplayExecutionRows([buyOpen, buyClosed, manualClose], lotLinks);
assert.ok(pairedRows.find((r) => r.id === 'buy-open'));
assert.equal(pairedRows.find((r) => r.id === 'buy-closed'), undefined);
const pairedSettled = pairedRows.find((r) => r.id === '99');
assert.equal(pairedSettled?._lifecycle?.buy.id, 'buy-closed');
assert.equal(pairedSettled?.leaderAddress, '0xleader');

// Buy/sell share dust (e.g. 2.973 vs 2.97) must still keep buy on lifecycle for detail timeline.
const buyDust = {
  ...base,
  id: 'buy-dust',
  side: 'BUY',
  size: '2.973',
  openLotRemaining: '0',
  createdAt: '2026-07-27T04:57:00.000Z',
};
const sellDust = {
  ...base,
  id: 'sell-dust',
  side: 'SELL',
  size: '2.97',
  settlementType: 'market_sell' as const,
  closedSize: '2.97',
  costBasisUsd: '1.10',
  proceedsUsd: '1.69',
  realizedPnlUsd: '0.59',
  createdAt: '2026-07-27T06:38:38.000Z',
};
const dustLinks = new Map<string, LotCloseBuyLink[]>([
  ['sell-dust', [{ buyRowId: 'buy-dust', closedSize: 2.97 }]],
]);
const dustRows = buildDisplayExecutionRows([buyDust, sellDust], dustLinks);
const dustSettled = dustRows.find((r) => r.id === 'sell-dust');
assert.equal(dustSettled?._lifecycle?.buy.id, 'buy-dust');
assert.equal(dustRows.find((r) => r.id === 'buy-dust'), undefined);

// Sentinel settlement without paired buy in the page stays sentinel until an external fallback is applied.
const orphanManual = buildDisplayExecutionRows([manualClose], lotLinks);
assert.equal(orphanManual[0]?.leaderAddress, 'manual_close');
assert.equal(
  withResolvedDisplayLeaderAddress(orphanManual[0]!, '0xfrom-subscription').leaderAddress,
  '0xfrom-subscription'
);

const buyA = {
  ...base,
  id: 'a',
  side: 'BUY',
  size: '0.5',
  openLotRemaining: '0',
  createdAt: '2026-06-07T01:00:00.000Z',
};
const buyB = {
  ...base,
  id: 'b',
  side: 'BUY',
  size: '0.5',
  openLotRemaining: '0',
  createdAt: '2026-06-07T02:00:00.000Z',
};
const sell = {
  ...base,
  id: 'sell-1',
  side: 'SELL',
  size: '1',
  settlementType: 'market_sell' as const,
  closedSize: '1',
  createdAt: '2026-06-07T03:00:00.000Z',
};
const multiLinks = new Map<string, LotCloseBuyLink[]>([
  [
    'sell-1',
    [
      { buyRowId: 'a', closedSize: 0.5 },
      { buyRowId: 'b', closedSize: 0.5 },
    ],
  ],
]);
const multiDetails = new Map<string, BuyLotCloseDetail>([
  [
    'a',
    {
      realizedPnlUsd: '-1.5',
      entryAvgPrice: '0.94',
      exitPrice: '0',
      closedSize: '0.5',
      costBasisUsd: '1.5',
      proceedsUsd: '0',
      primarySellRowId: 'sell-1',
      settlementType: 'expired_worthless',
    },
  ],
  [
    'b',
    {
      realizedPnlUsd: '-1.68',
      entryAvgPrice: '0.94',
      exitPrice: '0',
      closedSize: '0.5',
      costBasisUsd: '1.68',
      proceedsUsd: '0',
      primarySellRowId: 'sell-1',
      settlementType: 'expired_worthless',
    },
  ],
]);
const sellMerged = {
  ...sell,
  costBasisUsd: '3.18',
  proceedsUsd: '0',
  realizedPnlUsd: '-3.18',
  settlementType: 'expired_worthless' as const,
};
// Same address/event settlement present → one merged card, not N singles with merged totals.
const multiRows = buildDisplayExecutionRows(
  [buyA, buyB, sellMerged],
  multiLinks,
  new Map(),
  multiDetails
);
assert.equal(multiRows.length, 1);
assert.equal(multiRows[0]?.id, 'sell-1');
assert.equal(multiRows[0]?._lifecycle, undefined);
assert.equal(multiRows[0]?.costBasisUsd, '3.18');
assert.equal(multiRows.find((r) => r.id === 'a'), undefined);
assert.equal(multiRows.find((r) => r.id === 'b'), undefined);

// Settlement row missing → per-buy cards keep their own lot-close amounts (not merged).
const multiOrphanRows = buildDisplayExecutionRows(
  [buyA, buyB],
  multiLinks,
  new Map(),
  multiDetails
);
assert.equal(multiOrphanRows.length, 2);
const orphanA = multiOrphanRows.find((r) => r.id === 'a');
const orphanB = multiOrphanRows.find((r) => r.id === 'b');
assert.equal(orphanA?.costBasisUsd, '1.5');
assert.equal(orphanB?.costBasisUsd, '1.68');
assert.equal(orphanA?._lifecycle?.settlement.costBasisUsd, '1.5');
assert.equal(orphanB?._lifecycle?.settlement.costBasisUsd, '1.68');

// Buy synthetic must hide the raw settlement row (avoid duplicate identical cards).
const dupBuy = {
  ...base,
  id: 'buy-dup',
  side: 'BUY',
  size: '3.18',
  openLotRemaining: '0',
  createdAt: '2026-07-10T02:28:00.000Z',
};
const dupSell = {
  ...base,
  id: 'sell-dup',
  leaderAddress: 'manual_expired',
  side: 'SELL',
  size: '3.18',
  settlementType: 'expired_worthless' as const,
  closedSize: '3.18',
  costBasisUsd: '3.18',
  proceedsUsd: '0',
  realizedPnlUsd: '-3.18',
  createdAt: '2026-07-10T02:28:00.000Z',
};
const dupDetail = new Map<string, BuyLotCloseDetail>([
  [
    'buy-dup',
    {
      realizedPnlUsd: '-3.18',
      entryAvgPrice: '0.5',
      exitPrice: '0',
      closedSize: '3.18',
      costBasisUsd: '3.18',
      proceedsUsd: '0',
      primarySellRowId: 'sell-dup',
      settlementType: 'expired_worthless',
    },
  ],
]);
const dupRows = buildDisplayExecutionRows([dupBuy, dupSell], new Map(), new Map(), dupDetail);
assert.equal(dupRows.length, 1);
assert.equal(dupRows[0]?.id, 'buy-dup');
assert.equal(dupRows[0]?._lifecycle?.settlement.id, 'sell-dup');
assert.equal(dupRows.find((r) => r.id === 'sell-dup'), undefined);

const buy1733 = {
  ...base,
  id: 'buy-1733',
  side: 'BUY',
  size: '1.1277',
  openLotRemaining: '0',
  createdAt: '2026-06-07T09:33:33.000Z',
};
const failedSell = {
  ...base,
  id: 'sell-failed',
  side: 'SELL',
  size: '1.12',
  status: 'failed',
  settlementType: 'market_sell' as const,
  closedSize: '1.1277',
  costBasisUsd: '1.06',
  proceedsUsd: '1.04',
  realizedPnlUsd: '-0.02',
  createdAt: '2026-06-07T09:36:00.000Z',
};
const failedLinks = new Map<string, LotCloseBuyLink[]>([
  ['sell-failed', [{ buyRowId: 'buy-1733', closedSize: 1.1277 }]],
]);
const failedRows = buildDisplayExecutionRows([buy1733, failedSell], failedLinks);
assert.equal(failedRows.find((r) => r.id === 'buy-1733'), undefined);
assert.ok(failedRows.find((r) => r.id === 'sell-failed'));

const buyOnlyDetail = new Map<string, BuyLotCloseDetail>([
  [
    'buy-orphan',
    {
      realizedPnlUsd: '-0.02',
      entryAvgPrice: '0.94',
      exitPrice: '0.93',
      closedSize: '1.1277',
      costBasisUsd: '1.06',
      proceedsUsd: '1.04',
      primarySellRowId: 'sell-missing',
    },
  ],
]);
const buyOrphan = {
  ...base,
  id: 'buy-orphan',
  side: 'BUY',
  size: '1.1277',
  openLotRemaining: '0',
  createdAt: '2026-06-07T09:33:33.000Z',
};
const orphanRows = buildDisplayExecutionRows(
  [buyOrphan],
  new Map(),
  new Map(),
  buyOnlyDetail
);
const orphanRow = orphanRows.find((r) => r.id === 'buy-orphan');
assert.ok(orphanRow?.settlementType === 'market_sell');
assert.equal(orphanRow?._lifecycle?.buy.id, 'buy-orphan');
assert.equal(orphanRow?._lifecycle?.settlement.id, 'sell-missing');

console.log('executionLifecycleDisplay.test.ts ok');

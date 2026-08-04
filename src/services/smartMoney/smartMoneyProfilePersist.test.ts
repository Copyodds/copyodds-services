import assert from 'node:assert/strict';
import test from 'node:test';
import { extractProfileTotalsFromRawSummary } from './smartMoneyProfilePersist.js';

test('extracts totals from HTML volumeSummary snapshot', () => {
  assert.deepEqual(
    extractProfileTotalsFromRawSummary({
      volumeSummary: {
        pnl: 1234.5,
        amount: 98765.43,
      },
    }),
    {
      totalPnl: '1234.5',
      totalVolume: '98765.43',
    }
  );
});

test('extracts totals from API fallback leaderboardStats snapshot', () => {
  assert.deepEqual(
    extractProfileTotalsFromRawSummary({
      source: 'api-fallback',
      leaderboardStats: {
        totalPnl: '32092.917',
        totalVolume: '221625.86556999997',
      },
    }),
    {
      totalPnl: '32092.917',
      totalVolume: '221625.86556999997',
    }
  );
});

test('prefers normalized totals and supports alternate volume field names', () => {
  assert.deepEqual(
    extractProfileTotalsFromRawSummary({
      totalPnl: '10',
      totalVolume: '20',
      volumeSummary: {
        pnl: 30,
        volume: 40,
        totalVolume: 50,
      },
    }),
    {
      totalPnl: '10',
      totalVolume: '20',
    }
  );
});

test('returns null for absent or invalid totals', () => {
  assert.deepEqual(extractProfileTotalsFromRawSummary({ leaderboardStats: {} }), {
    totalPnl: null,
    totalVolume: null,
  });
  assert.deepEqual(
    extractProfileTotalsFromRawSummary({
      volumeSummary: { pnl: 'not-a-number', amount: '' },
    }),
    {
      totalPnl: null,
      totalVolume: null,
    }
  );
});

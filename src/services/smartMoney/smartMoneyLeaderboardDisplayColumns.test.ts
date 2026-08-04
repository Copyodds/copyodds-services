/**
 * extractLeaderboardDisplayColumns：展示 closed PnL vs 门控账户曲线 PnL 分离
 */
import assert from 'node:assert/strict';
import { extractLeaderboardDisplayColumns } from './smartMoneyLeaderboardWriter.js';

const cols = extractLeaderboardDisplayColumns({
  displayProfile: {
    totalPnl1y: 295_000,
    maxDrawdownPercent: 0.11,
    maxDrawdownUsd: 5_100,
    totalReturnRatio: 1.14,
    pnlWindowDays: 173,
    pnlWindowMetrics: {
      pnl1y: {
        pnlUsd: 46_900,
        maxDrawdownUsd: 5_100,
        maxDrawdownRatio: 0.11,
        actualWindowDays: 173,
      },
    },
  },
});

assert.equal(cols.totalPnl1y, 295_000, 'UI/closed sample');
assert.equal(cols.accountPnl1y, 46_900, 'L1 must use curve account PnL');
assert.equal(cols.maxDrawdownUsd1y, 5_100);
assert.equal(cols.maxDrawdown1y, 0.11);

console.log('smartMoneyLeaderboardDisplayColumns.test.ts: ok');

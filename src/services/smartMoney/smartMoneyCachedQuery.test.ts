import assert from 'node:assert/strict';
import { CONFIG } from '../../config/env';
import {
  buildSmartMoneyCachedApiMeta,
  smartMoneyCachedDisplayWhere,
  smartMoneyLeaderboardRankWhere,
} from './smartMoneyCachedQuery';
import { copyPoolAboveExitWhere } from './smartMoneyPoolScore';

{
  const where = smartMoneyCachedDisplayWhere({ eligibleOnly: true });
  assert.equal(where.inCopyPool, true);
  assert.deepEqual(where.rank, { not: null });
  assert.equal(where.recentPnl7d, undefined);
  assert.equal(where.activeCandidate, undefined);
  assert.equal(where.eligible, undefined);
  if (CONFIG.smartMoneyCopyReadyRequiredForPool) {
    assert.deepEqual(where.copyabilityScore, {
      gte: CONFIG.smartMoneyCopyPoolMinComposite,
    });
  }
  if (CONFIG.smartMoneyTraderScoreAsPrimary) {
    assert.ok(Array.isArray(where.OR));
    assert.deepEqual(where.score, undefined);
  } else {
    assert.deepEqual(where.score, { gt: CONFIG.smartMoneyCopyPoolExitScore });
  }
}

{
  const where = smartMoneyCachedDisplayWhere({ eligibleOnly: false });
  assert.equal(where.inCopyPool, true);
  if (CONFIG.smartMoneyTraderScoreAsPrimary) {
    assert.ok(Array.isArray(where.OR));
  } else {
    assert.deepEqual(where.score, { gt: CONFIG.smartMoneyCopyPoolExitScore });
  }
}

{
  const exit = CONFIG.smartMoneyCopyPoolExitScore;
  const above = copyPoolAboveExitWhere();
  if (CONFIG.smartMoneyTraderScoreAsPrimary) {
    assert.ok(Array.isArray(above.OR));
    const first = above.OR?.[0] as { traderScore?: { gt: number } };
    assert.equal(first?.traderScore?.gt, exit);
    assert.ok(exit > 18);
  } else {
    assert.deepEqual(above.score, { gt: exit });
  }
}

{
  const rankWhere = smartMoneyLeaderboardRankWhere();
  assert.equal(rankWhere.inCopyPool, true);
  assert.equal(rankWhere.recentPnl7d, undefined);
  assert.notDeepEqual(rankWhere, { inCopyPool: true });
  if (CONFIG.smartMoneyTraderScoreAsPrimary) {
    assert.ok(Array.isArray(rankWhere.OR));
  } else {
    assert.deepEqual(rankWhere.score, { gt: CONFIG.smartMoneyCopyPoolExitScore });
  }
}

{
  const meta = buildSmartMoneyCachedApiMeta({ eligibleOnly: true });
  assert.equal(meta.copyPoolOnly, true);
  assert.ok(meta.deprecatedFields.includes('eligible'));
}

console.log('smartMoneyCachedQuery.test.ts: ok');

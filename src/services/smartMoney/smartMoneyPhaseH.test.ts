import assert from 'node:assert/strict';
import {
  hasBlockScanSource,
  hasLeaderboardSource,
  isFastTrackSource,
  isLeaderboardSource,
} from './smartMoneyRawSource.js';

assert.equal(isLeaderboardSource('LEADERBOARD_SYNC'), true);
assert.equal(hasLeaderboardSource(['BLOCK_SCAN']), false);
assert.equal(hasLeaderboardSource(['LEADERBOARD_SYNC', 'BLOCK_SCAN']), true);
assert.equal(hasBlockScanSource(['BLOCK_SCAN']), true);
assert.equal(isFastTrackSource(['ADMIN']), true);
assert.equal(isFastTrackSource([]), false);

console.log('smartMoneyPhaseH.test.ts: ok');

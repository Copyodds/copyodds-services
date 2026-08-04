import assert from 'node:assert/strict';
import { parseCopyTradingNatsPayload } from './copyTradingNatsHandler';

const ADDR = '0x1111111111111111111111111111111111111111';

assert.equal(parseCopyTradingNatsPayload(null), null);
assert.equal(parseCopyTradingNatsPayload({}), null);

const parsed = parseCopyTradingNatsPayload({
  leaderTradeId: 'lt-1',
  leaderAddress: ADDR,
  occurredAt: new Date().toISOString(),
});
assert.equal(parsed?.leaderTradeId, 'lt-1');

console.log('copyTradingNatsHandler.test.ts: ok');

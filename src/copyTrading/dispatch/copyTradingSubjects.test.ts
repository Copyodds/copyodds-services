import assert from 'node:assert/strict';
import {
  COPY_TRADING_WILDCARD,
  copyTradingSubject,
  parseCopyTradingSubject,
} from './copyTradingSubjects';

const ADDR = '0x1111111111111111111111111111111111111111';
const MIXED = `0X${ADDR.slice(2).toUpperCase()}`;

assert.equal(COPY_TRADING_WILDCARD, 'copy.trading.*');
assert.equal(copyTradingSubject(MIXED), `copy.trading.${ADDR}`);
assert.deepEqual(parseCopyTradingSubject(`copy.trading.${ADDR}`), { leaderAddress: ADDR });
assert.equal(parseCopyTradingSubject('robot.modify.x'), null);

console.log('copyTradingSubjects.test.ts: ok');

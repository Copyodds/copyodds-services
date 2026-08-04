import assert from 'node:assert/strict';
import { startOfUtcDay } from './copyRiskDailyNotional';

const day = startOfUtcDay(new Date('2026-05-23T15:30:00Z'));
assert.equal(day.toISOString(), '2026-05-23T00:00:00.000Z');

console.log('copyRiskDailyNotional.test.ts: ok');

import assert from 'node:assert/strict';
import { utcClaimDate } from './shareToXDate';

const d = new Date(Date.UTC(2026, 7, 1, 23, 59, 59));
const day = utcClaimDate(d);
assert.equal(day.toISOString(), '2026-08-01T00:00:00.000Z');

const next = utcClaimDate(new Date(Date.UTC(2026, 7, 2, 0, 0, 1)));
assert.equal(next.toISOString(), '2026-08-02T00:00:00.000Z');

console.log('shareToXGas.test.ts: ok');

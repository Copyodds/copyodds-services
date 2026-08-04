import assert from 'node:assert/strict';
import {
  describeCopyFundingOperationalFailure,
  isCopyFundingOperational,
  isCopyFundingReady,
  type CopyFundingSnapshot,
} from './copyFundingCheck';

function snap(partial: Partial<CopyFundingSnapshot>): CopyFundingSnapshot {
  return {
    minUsdcRequired: 10,
    minUsdcRequiredToOperate: 1,
    depositUsdcFormatted: '2',
    gasBalance: '1',
    hasSufficientUsdc: false,
    hasOperationalUsdc: true,
    hasGas: true,
    ...partial,
  };
}

assert.equal(isCopyFundingReady(snap({})), true);
assert.equal(isCopyFundingReady(snap({ hasGas: false })), false);
assert.equal(isCopyFundingReady(snap({ hasSufficientUsdc: false, hasGas: true })), true);
assert.equal(isCopyFundingOperational(snap({})), true);
assert.equal(
  isCopyFundingOperational(snap({ hasOperationalUsdc: false })),
  true
);
assert.equal(isCopyFundingOperational(snap({ hasGas: false })), false);

const gasMsg = describeCopyFundingOperationalFailure(snap({ hasGas: false }));
assert.ok(gasMsg.includes('Gas'));

console.log('copyFundingCheck.test.ts: ok');

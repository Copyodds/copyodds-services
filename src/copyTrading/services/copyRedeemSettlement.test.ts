import assert from 'node:assert/strict';
import { conservativeRedeemEstimateUsd } from './copyRedeemSettlement';
import { isWorthlessRedeemablePosition } from '../../services/polymarket/positionVisibility';
import type { DataApiPosition } from '../../services/polymarket/polymarketData';

function pos(partial: Partial<DataApiPosition> & Pick<DataApiPosition, 'size'>): DataApiPosition {
  return {
    asset: 'token-1',
    conditionId: '0xabc',
    size: partial.size,
    currentValue: partial.currentValue,
    curPrice: partial.curPrice,
    redeemable: partial.redeemable ?? false,
    outcomeIndex: partial.outcomeIndex ?? 0,
    ...partial,
  } as DataApiPosition;
}

assert.equal(
  conservativeRedeemEstimateUsd(pos({ size: 1.3816, currentValue: 0, curPrice: 0 })),
  0,
  'zero value must not treat share count as USD'
);

assert.equal(
  conservativeRedeemEstimateUsd(pos({ size: 1.3816, currentValue: 1.38 })),
  1.38,
  'positive currentValue is used'
);

assert.equal(
  conservativeRedeemEstimateUsd(pos({ size: 2, curPrice: 0.5, currentValue: undefined as unknown as number })),
  1,
  'curPrice * size when currentValue missing'
);

// 输面可赎回应跳过自动链上 redeem（避免 Relayer 空打 + 熔断）
assert.equal(
  isWorthlessRedeemablePosition(
    pos({ size: 2210, redeemable: true, currentValue: 0, curPrice: 0 })
  ),
  true,
  'large loser size with $0 value is worthless redeemable'
);
assert.equal(
  isWorthlessRedeemablePosition(
    pos({ size: 10, redeemable: true, currentValue: 8, curPrice: 0.8 })
  ),
  false,
  'winning redeemable must still go through chain redeem'
);

console.log('copyRedeemSettlement.test.ts ok');

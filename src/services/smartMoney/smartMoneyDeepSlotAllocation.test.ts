import assert from 'node:assert/strict';
import { allocateSmartMoneyDeepSlots } from './smartMoneyDeepSlotAllocation.js';

assert.deepEqual(
  allocateSmartMoneyDeepSlots({
    limit: 12,
    qualifiedDue: 106,
    scoredDue: 466,
    scoredReservedSlots: 1,
    minQualifiedShare: 0.58,
    refreshShare: 0.17,
  }),
  {
    qualifiedSlots: 9,
    refreshSlots: 2,
    scoredSlots: 1,
  }
);

// TopN 欠债时抬高复评份额，但仍保住 7 QUALIFIED + 1 SCORED。
assert.deepEqual(
  allocateSmartMoneyDeepSlots({
    limit: 12,
    qualifiedDue: 106,
    scoredDue: 466,
    scoredReservedSlots: 1,
    minQualifiedShare: 0.58,
    refreshShare: 0.34,
  }),
  {
    qualifiedSlots: 7,
    refreshSlots: 4,
    scoredSlots: 1,
  }
);

// QUALIFIED 不足时，空槽先给已到期 SCORED。
assert.deepEqual(
  allocateSmartMoneyDeepSlots({
    limit: 12,
    qualifiedDue: 5,
    scoredDue: 6,
    scoredReservedSlots: 1,
    minQualifiedShare: 0.58,
    refreshShare: 0.17,
  }),
  {
    qualifiedSlots: 5,
    refreshSlots: 2,
    scoredSlots: 5,
  }
);

// QUALIFIED/SCORED 均不足时，剩余槽不再无限回让 refresh（F5：受 refreshShare 上限约束）。
assert.deepEqual(
  allocateSmartMoneyDeepSlots({
    limit: 12,
    qualifiedDue: 5,
    scoredDue: 0,
    scoredReservedSlots: 1,
    minQualifiedShare: 0.58,
    refreshShare: 0.17,
  }),
  {
    qualifiedSlots: 5,
    refreshSlots: 2,
    scoredSlots: 0,
  }
);

assert.deepEqual(
  allocateSmartMoneyDeepSlots({
    limit: 0,
    qualifiedDue: 100,
    scoredDue: 100,
    scoredReservedSlots: 1,
    minQualifiedShare: 0.58,
    refreshShare: 0.17,
  }),
  {
    qualifiedSlots: 0,
    refreshSlots: 0,
    scoredSlots: 0,
  }
);

// 组合模拟：配额必须始终为非负整数、不超批次，并在启用复评时填满批次。
for (let limit = 1; limit <= 20; limit += 1) {
  for (let qualifiedDue = 0; qualifiedDue <= 24; qualifiedDue += 1) {
    for (let scoredDue = 0; scoredDue <= 24; scoredDue += 3) {
      for (const minQualifiedShare of [0.5, 0.58, 0.66, 0.8, 1]) {
        for (const refreshShare of [0, 0.1, 0.17, 0.34, 0.5]) {
          const slots = allocateSmartMoneyDeepSlots({
            limit,
            qualifiedDue,
            scoredDue,
            scoredReservedSlots: 1,
            minQualifiedShare,
            refreshShare,
          });
          const values = [slots.qualifiedSlots, slots.refreshSlots, slots.scoredSlots];
          assert.ok(values.every((value) => Number.isInteger(value) && value >= 0));
          assert.ok(slots.qualifiedSlots <= qualifiedDue);
          assert.ok(slots.scoredSlots <= scoredDue);

          const total = values.reduce((sum, value) => sum + value, 0);
          assert.ok(total <= limit);
          assert.ok(slots.refreshSlots <= Math.floor(limit * refreshShare));

          const floor = Math.ceil(limit * minQualifiedShare);
          if (qualifiedDue >= floor) {
            assert.ok(slots.qualifiedSlots >= floor);
          }
        }
      }
    }
  }
}

console.log('smartMoneyDeepSlotAllocation.test.ts: ok');

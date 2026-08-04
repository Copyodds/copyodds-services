import assert from 'node:assert/strict';
import { mapPool } from '../../copyTrading/services/mapPool';

/** Mirrors redeemCron redeemable-first partition. */
function partitionRedeemableFirst<T extends { hasRedeemable: boolean }>(items: T[]): {
  redeemable: T[];
  rest: T[];
} {
  return {
    redeemable: items.filter((p) => p.hasRedeemable),
    rest: items.filter((p) => !p.hasRedeemable),
  };
}

async function main(): Promise<void> {
  const items = [
    { id: 1, hasRedeemable: false },
    { id: 2, hasRedeemable: true },
    { id: 3, hasRedeemable: false },
    { id: 4, hasRedeemable: true },
  ];
  const { redeemable, rest } = partitionRedeemableFirst(items);
  assert.deepEqual(
    redeemable.map((x) => x.id),
    [2, 4]
  );
  assert.deepEqual(
    rest.map((x) => x.id),
    [1, 3]
  );

  const order: number[] = [];
  await mapPool([1, 2, 3, 4, 5], 2, async (n) => {
    order.push(n);
    await new Promise((r) => setTimeout(r, 5));
  });
  assert.deepEqual([...order].sort((a, b) => a - b), [1, 2, 3, 4, 5]);

  console.log('redeemCron.priority.test.ts: ok');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

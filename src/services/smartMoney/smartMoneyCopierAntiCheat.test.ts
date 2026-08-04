import assert from 'node:assert/strict';

async function main(): Promise<void> {
  const {
    computeTopSubscriberNotionalShare,
    isCopierWashSuspect,
  } = await import('./smartMoneyCopierAntiCheat');

  assert.equal(computeTopSubscriberNotionalShare([100, 50, 50]), 0.5);
  assert.equal(computeTopSubscriberNotionalShare([900, 50, 50]), 0.9);
  assert.equal(isCopierWashSuspect({ topSubscriberNotionalShare: 0.9, excludedSelfCopyCount: 0 }), true);
  assert.equal(isCopierWashSuspect({ topSubscriberNotionalShare: 0.5, excludedSelfCopyCount: 2 }), true);
  assert.equal(isCopierWashSuspect({ topSubscriberNotionalShare: 0.5, excludedSelfCopyCount: 0 }), false);

  console.log('smartMoneyCopierAntiCheat.test.ts: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

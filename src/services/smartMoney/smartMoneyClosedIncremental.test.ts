import assert from 'node:assert/strict';

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/polycopy_test';
process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';

async function main(): Promise<void> {
  const {
    computeNewestClosedAtMs,
    mergeClosedRowsIncremental,
  } = await import('./smartMoneyClosedIncremental');
  const typeMod = await import('../polymarket/polymarketData');
  type DataApiPosition = typeMod.DataApiPosition;

  function row(input: {
    conditionId: string;
    asset: string;
    timestamp: string;
    outcomeIndex?: number;
  }): DataApiPosition {
    return {
      asset: input.asset,
      conditionId: input.conditionId,
      redeemable: false,
      outcomeIndex: input.outcomeIndex ?? 0,
      timestamp: input.timestamp,
    };
  }

  {
    const nowMs = Date.parse('2026-07-29T00:00:00.000Z');
    const existing = [
      row({ conditionId: 'c1', asset: 'a1', timestamp: '2026-07-20T00:00:00.000Z' }),
      row({ conditionId: 'c2', asset: 'a2', timestamp: '2026-06-01T00:00:00.000Z' }),
    ];
    const incoming = [
      row({ conditionId: 'c3', asset: 'a3', timestamp: '2026-07-28T00:00:00.000Z' }),
      row({ conditionId: 'c1', asset: 'a1', timestamp: '2026-07-20T00:00:00.000Z' }),
    ];
    const merged = mergeClosedRowsIncremental({
      existing,
      incoming,
      nowMs,
      windowDays: 365,
      maxRows: 100,
    });
    assert.equal(merged.length, 3);
    assert.equal(computeNewestClosedAtMs(merged), Date.parse('2026-07-28T00:00:00.000Z'));
  }

  {
    const nowMs = Date.parse('2026-07-29T00:00:00.000Z');
    const old = row({
      conditionId: 'old',
      asset: 'a',
      timestamp: '2024-01-01T00:00:00.000Z',
    });
    const merged = mergeClosedRowsIncremental({
      existing: [old],
      incoming: [],
      nowMs,
      windowDays: 365,
      maxRows: 10,
    });
    assert.equal(merged.length, 0);
  }

  {
    const nowMs = Date.parse('2026-07-29T00:00:00.000Z');
    const many = Array.from({ length: 20 }, (_, i) =>
      row({
        conditionId: `c${i}`,
        asset: `a${i}`,
        timestamp: new Date(nowMs - i * 86_400_000).toISOString(),
      })
    );
    const merged = mergeClosedRowsIncremental({
      existing: many,
      incoming: [],
      nowMs,
      windowDays: 365,
      maxRows: 5,
    });
    assert.equal(merged.length, 5);
    assert.equal(computeNewestClosedAtMs(merged), nowMs);
  }

  console.log('smartMoneyClosedIncremental.test: OK');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

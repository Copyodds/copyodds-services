import assert from 'node:assert/strict';

process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';

async function main(): Promise<void> {
  const {
    alignScoreExplainTraderProfileToBoard,
    resolveSmartMoneyDisplayAuthority,
    stampSmartMoneyDisplayRevision,
  } = await import('./smartMoneyDisplayAuthority');

  assert.equal(
    resolveSmartMoneyDisplayAuthority({ hasLeaderboardRow: true, hasScoreCache: true }),
    'leaderboard'
  );
  assert.equal(
    resolveSmartMoneyDisplayAuthority({ hasLeaderboardRow: true, hasScoreCache: false }),
    'leaderboard'
  );
  assert.equal(
    resolveSmartMoneyDisplayAuthority({ hasLeaderboardRow: false, hasScoreCache: true }),
    'score_cache'
  );
  assert.equal(
    resolveSmartMoneyDisplayAuthority({ hasLeaderboardRow: false, hasScoreCache: false }),
    'none'
  );

  const aligned = alignScoreExplainTraderProfileToBoard({
    scoreExplain: {
      traderProfile: {
        tier: 'C',
        traderType: 'DIRECTIONAL',
        traderScore: { score: 77.59 },
        card: { tier: 'C', traderScore: 77.59, traderType: 'DIRECTIONAL' },
      },
    },
    tier: 'S',
    traderScore: '87.09',
    traderType: 'DIRECTIONAL',
  }) as {
    traderProfile: {
      tier: string;
      traderScore: { score: number };
      card: { tier: string; traderScore: number };
    };
  };

  assert.equal(aligned.traderProfile.tier, 'S');
  assert.equal(aligned.traderProfile.traderScore.score, 87.09);
  assert.equal(aligned.traderProfile.card.tier, 'S');
  assert.equal(aligned.traderProfile.card.traderScore, 87.09);

  const createdCard = alignScoreExplainTraderProfileToBoard({
    scoreExplain: { traderProfile: { tier: 'C' } },
    tier: 'A',
    traderScore: 80,
    traderType: 'DIRECTIONAL',
  }) as {
    traderProfile: { tier: string; card: { tier: string; traderScore: number; traderType: string } };
  };
  assert.equal(createdCard.traderProfile.tier, 'A');
  assert.equal(createdCard.traderProfile.card.tier, 'A');
  assert.equal(createdCard.traderProfile.card.traderScore, 80);
  assert.equal(createdCard.traderProfile.card.traderType, 'DIRECTIONAL');

  const stamped = stampSmartMoneyDisplayRevision({ foo: 1 }, new Date('2026-07-27T00:00:00.000Z'));
  assert.equal(stamped.foo, 1);
  assert.equal(stamped.displayRevisionAt, '2026-07-27T00:00:00.000Z');

  console.log('smartMoneyDisplayAuthority.test.ts: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import assert from 'node:assert/strict';

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/polycopy_test';
process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';

async function main(): Promise<void> {
  process.env.SMART_MONEY_STRONG_REVIVE_COOLDOWN_MS = String(3 * 24 * 60 * 60 * 1000); // 3d
  process.env.SMART_MONEY_STRONG_REVIVE_DEEP_COOLDOWN_MS = String(7 * 24 * 60 * 60 * 1000);

  const {
    isStrongReviveSource,
    elimReasonRequiresDeepRecheck,
    isReviveCooldownBypassSource,
    resolveStrongReviveCooldownMs,
    isStrongReviveCooldownActive,
    canAttemptStrongRevive,
  } = await import('./smartMoneyEliminated');

  assert.equal(isStrongReviveSource('BLOCK_SCAN'), true);
  assert.equal(isStrongReviveSource('LEADERBOARD_SYNC'), true);
  assert.equal(isStrongReviveSource('ADMIN_REFRESH'), true);
  assert.equal(isStrongReviveSource('PREDICTING_TOP'), false);
  assert.equal(isStrongReviveSource('noise'), false);

  assert.equal(elimReasonRequiresDeepRecheck('L1-PNL|wr=0.1'), true);
  assert.equal(elimReasonRequiresDeepRecheck('COPY_HARD|LIKELY_BOT'), true);
  assert.equal(elimReasonRequiresDeepRecheck('SCORE_BELOW_ENTER|miss=2'), true);
  assert.equal(elimReasonRequiresDeepRecheck('T1L-2'), false);
  assert.equal(elimReasonRequiresDeepRecheck('L0-B:NONE'), false);

  assert.equal(isReviveCooldownBypassSource('ADMIN'), true);
  assert.equal(isReviveCooldownBypassSource('MANUAL_RETRY'), true);
  assert.equal(isReviveCooldownBypassSource('BLOCK_SCAN'), false);

  assert.equal(resolveStrongReviveCooldownMs('T1L-2'), 3 * 24 * 60 * 60 * 1000);
  assert.equal(resolveStrongReviveCooldownMs('L1-DUST|x=1'), 7 * 24 * 60 * 60 * 1000);
  assert.equal(resolveStrongReviveCooldownMs('COPY_HARD|HIGH_TRADE_FREQUENCY'), 7 * 24 * 60 * 60 * 1000);

  const now = new Date('2026-07-29T12:00:00.000Z');
  assert.equal(
    isStrongReviveCooldownActive({
      updatedAt: new Date('2026-07-29T06:00:00.000Z'),
      elimFrozenUntil: null,
      tierFailReason: 'L1-DUST',
      now,
    }),
    true,
    'Deep elim within 7d stays cooling'
  );
  assert.equal(
    isStrongReviveCooldownActive({
      updatedAt: new Date('2026-07-26T11:00:00.000Z'),
      elimFrozenUntil: null,
      tierFailReason: 'T1L-2',
      now,
    }),
    false,
    'Light elim after 3d can revive'
  );
  assert.equal(
    isStrongReviveCooldownActive({
      updatedAt: new Date('2026-07-28T12:00:00.000Z'),
      elimFrozenUntil: null,
      tierFailReason: 'T1L-2',
      now,
    }),
    true,
    'Light elim within 3d stays cooling'
  );
  assert.equal(
    isStrongReviveCooldownActive({
      updatedAt: new Date('2026-07-01T00:00:00.000Z'),
      elimFrozenUntil: new Date('2026-07-30T00:00:00.000Z'),
      tierFailReason: 'T1L-2',
      now,
    }),
    true,
    'frozen until blocks revive'
  );
  assert.equal(
    canAttemptStrongRevive({
      source: 'LEADERBOARD_SYNC',
      updatedAt: new Date('2026-07-29T06:00:00.000Z'),
      elimFrozenUntil: null,
      tierFailReason: 'L1-DUST',
      now,
    }),
    false,
    'board source cannot revive Deep elimination inside 7d'
  );
  assert.equal(
    canAttemptStrongRevive({
      source: 'BLOCK_SCAN',
      updatedAt: new Date('2026-07-20T00:00:00.000Z'),
      elimFrozenUntil: null,
      tierFailReason: 'L1-DUST',
      now,
    }),
    true,
    'block source can revive after Deep cooldown'
  );
  assert.equal(
    canAttemptStrongRevive({
      source: 'ADMIN_REFRESH',
      updatedAt: new Date('2026-07-29T11:59:59.000Z'),
      elimFrozenUntil: new Date('2026-08-30T00:00:00.000Z'),
      tierFailReason: 'L1-DUST',
      now,
    }),
    true,
    'admin bypasses cooldown and freeze'
  );

  console.log('smartMoneyEliminated.test.ts: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

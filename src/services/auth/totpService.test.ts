import assert from 'node:assert/strict';

process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';

async function main() {
  const { normalizeWithdrawAuthorizationInput } = await import('./totpService');

  const normalized = normalizeWithdrawAuthorizationInput({
    to: '0x00000000000000000000000000000000000000aa',
    amount: '01.250000',
    idempotencyKey: '  withdrawal-1  ',
  });
  assert.equal(normalized.to, '0x00000000000000000000000000000000000000AA');
  assert.equal(normalized.amount, '1.25');
  assert.equal(normalized.idempotencyKey, 'withdrawal-1');

  assert.throws(() =>
    normalizeWithdrawAuthorizationInput({
      to: normalized.to,
      amount: '1.0000001',
      idempotencyKey: 'withdrawal-2',
    }),
  );
  assert.throws(() =>
    normalizeWithdrawAuthorizationInput({
      to: normalized.to,
      amount: '1',
      idempotencyKey: ' ',
    }),
  );

  console.log('totpService.test.ts: ok');
}

main();

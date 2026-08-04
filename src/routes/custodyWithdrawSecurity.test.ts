import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function main() {
  const source = await readFile(`${__dirname}/custody.ts`, 'utf8');

  assert.match(
    source,
    /router\.post\('\/withdraw-polymarket-deposit', jwtAuth, \(_req, res\) => \{[\s\S]*?LEGACY_WITHDRAW_DISABLED/,
  );
  assert.match(
    source,
    /router\.post\('\/withdraw', jwtAuth, \(_req, res\) => \{[\s\S]*?DIRECT_EOA_WITHDRAW_DISABLED/,
  );
  assert.match(
    source,
    /withdrawPolymarketDepositV2Schema[\s\S]*?amount: z\.string\(\)[\s\S]*?idempotencyKey: z\.string\(\)[\s\S]*?authorization: z\.string\(\)/,
  );
  assert.match(
    source,
    /withdrawPolymarketDepositToAddressV2\(\{[\s\S]*?authorization: parsed\.data\.authorization/,
  );
  assert.doesNotMatch(
    source,
    /router\.post\('\/withdraw-polymarket-deposit-v2'[\s\S]{0,180}requireStepUp/,
  );

  console.log('custodyWithdrawSecurity.test.ts: ok');
}

main();

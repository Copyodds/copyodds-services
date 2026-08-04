import assert from 'node:assert/strict';
import {
  resolveUsdcVariant,
  USDC_E_TOKEN_ADDRESS,
  USDC_NATIVE_TOKEN_ADDRESS,
  USDT_POLYGON_TOKEN_ADDRESS,
  USDT0_POLYGON_TOKEN_ADDRESS,
} from './usdcTokenVariant';

assert.equal(resolveUsdcVariant(USDC_E_TOKEN_ADDRESS), 'usdce');
assert.equal(resolveUsdcVariant(USDC_NATIVE_TOKEN_ADDRESS), 'native');
assert.equal(resolveUsdcVariant(USDT_POLYGON_TOKEN_ADDRESS), 'usdt');
assert.equal(resolveUsdcVariant(USDT0_POLYGON_TOKEN_ADDRESS), 'usdt0');
assert.equal(resolveUsdcVariant('0x0000000000000000000000000000000000000001'), null);

console.log('custodyEoaDepositIngest.test.ts ok');

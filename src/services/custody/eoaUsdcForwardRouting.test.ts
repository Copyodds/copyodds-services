import assert from 'node:assert/strict';
import { shouldRouteNativeUsdcEoaToBridge } from './eoaUsdcForwardRouting';

assert.equal(shouldRouteNativeUsdcEoaToBridge('auto_chain_deposit'), true);
assert.equal(shouldRouteNativeUsdcEoaToBridge('manual_api'), true);
assert.equal(shouldRouteNativeUsdcEoaToBridge('auto_order'), true);

console.log('eoaUsdcForwardRouting ok');

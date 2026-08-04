import assert from 'node:assert/strict';
import { evaluateBuyCollateralPrecheck } from './copyOrderFundingPrecheckLogic';

assert.equal(
  evaluateBuyCollateralPrecheck({
    hasDeposit: false,
    depositUsd: 10,
    requiredUsd: 1,
  }).ok,
  false
);

assert.equal(
  evaluateBuyCollateralPrecheck({
    hasDeposit: true,
    depositUsd: 3.5,
    requiredUsd: 3.15,
  }).ok,
  true
);

assert.equal(
  evaluateBuyCollateralPrecheck({
    hasDeposit: true,
    depositUsd: 3.1,
    requiredUsd: 3.15,
  }).ok,
  false
);

console.log('copyOrderFundingPrecheck.test.ts: ok');

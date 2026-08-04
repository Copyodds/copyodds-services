import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldPersistProfileAfterLightPass } from './smartMoneyLightProfileFetch.js';

test('shouldPersistProfileAfterLightPass returns boolean', () => {
  assert.equal(typeof shouldPersistProfileAfterLightPass(), 'boolean');
});

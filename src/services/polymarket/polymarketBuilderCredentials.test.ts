import assert from 'node:assert/strict';
import {
  builderSlotPool,
  selectBuilderCredentialSlotsForPreference,
} from './polymarketBuilderSlotSelect';

type Slot = { id: string };

function slot(id: string): Slot {
  return { id };
}

const primary = slot('primary');
const backup1 = slot('backup-1');
const backup2 = slot('backup-2');

assert.equal(builderSlotPool('primary'), 'primary');
assert.equal(builderSlotPool('backup-1'), 'backup');

{
  const sel = selectBuilderCredentialSlotsForPreference(
    [primary, backup1, backup2],
    'primary_only',
    () => true
  );
  assert.deepEqual(
    sel.slots.map((s) => s.id),
    ['primary']
  );
  assert.equal(sel.fallbackToPrimary, false);
}

{
  const sel = selectBuilderCredentialSlotsForPreference(
    [primary, backup1, backup2],
    'backup_first',
    () => true
  );
  assert.deepEqual(
    sel.slots.map((s) => s.id),
    ['backup-1', 'backup-2']
  );
  assert.equal(sel.fallbackToPrimary, false);
}

{
  const cooling = new Set(['backup-1', 'backup-2']);
  const sel = selectBuilderCredentialSlotsForPreference(
    [primary, backup1, backup2],
    'backup_first',
    (id) => !cooling.has(id)
  );
  assert.deepEqual(
    sel.slots.map((s) => s.id),
    ['primary']
  );
  assert.equal(sel.fallbackToPrimary, true);
  assert.deepEqual(sel.skippedCooldownSlotIds.sort(), ['backup-1', 'backup-2']);
}

{
  const sel = selectBuilderCredentialSlotsForPreference([primary], 'backup_first', () => true);
  assert.deepEqual(
    sel.slots.map((s) => s.id),
    ['primary']
  );
  assert.equal(sel.fallbackToPrimary, true);
}

{
  const cooling = new Set(['primary']);
  const sel = selectBuilderCredentialSlotsForPreference(
    [primary, backup1],
    'primary_only',
    (id) => !cooling.has(id)
  );
  assert.deepEqual(sel.slots.map((s) => s.id), []);
  assert.deepEqual(sel.skippedCooldownSlotIds, ['primary']);
}

console.log('polymarketBuilderCredentials.test.ts: ok');

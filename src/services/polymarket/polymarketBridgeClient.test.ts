import assert from 'node:assert/strict';

function parseDepositAddresses(raw: unknown): { evm?: string; svm?: string } {
  if (!raw || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  const inner = o.address && typeof o.address === 'object' ? (o.address as Record<string, unknown>) : o;
  const out: { evm?: string; svm?: string } = {};
  for (const key of ['evm', 'svm'] as const) {
    const v = inner[key];
    if (typeof v === 'string' && v.trim()) out[key] = v.trim();
  }
  return out;
}

const sample = {
  address: {
    evm: '0x23566f8b2E82aDfCf01846E54899d110e97AC053',
    svm: 'CrvTBvzryYxBHbWu2TiQpcqD5M7Le7iBKzVmEj3f36Jb',
  },
  note: 'Only certain chains and tokens are supported.',
};

const parsed = parseDepositAddresses(sample);
assert.equal(parsed.evm, '0x23566f8b2E82aDfCf01846E54899d110e97AC053');
assert.equal(parsed.svm, 'CrvTBvzryYxBHbWu2TiQpcqD5M7Le7iBKzVmEj3f36Jb');

console.log('polymarketBridgeClient parse ok');

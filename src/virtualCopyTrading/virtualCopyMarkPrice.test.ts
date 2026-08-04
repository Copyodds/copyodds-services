import assert from 'node:assert/strict';
import { createVirtualMarkPriceService, valueVirtualLots } from './virtualCopyMarkPrice';

const now = new Date('2026-07-17T08:00:00.000Z');
const calls: string[] = [];
const service = createVirtualMarkPriceService({
  now: () => now,
  staleAfterMs: 60_000,
  fetch: async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/midpoint')) {
      return { ok: true, status: 200, async json() { return { mid: null }; } };
    }
    if (url.includes('/last-trade-price')) {
      return { ok: false, status: 404, async json() { return {}; } };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return [{
          clobTokenIds: '["token-no","token-yes"]',
          outcomePrices: '["0.4","0.6"]',
          updatedAt: '2026-07-17T07:59:30.000Z',
        }];
      },
    };
  },
});

async function main() {
  const mark = await service.resolve('token-yes');
  assert.equal(mark.price?.toString(), '0.6');
  assert.equal(mark.source, 'POLYMARKET_GAMMA_OUTCOME');
  assert.equal(mark.status, 'DEGRADED');
  assert.equal(mark.stalenessMs, 30_000);
  assert.equal(calls.length, 3, 'Gamma is used only after both CLOB sources fail');

  const valuation = valueVirtualLots(
    [
      { tokenId: 'token-yes', remainingSize: '10', entryPrice: '0.5', entryFeeUsd: '0.1' },
      { tokenId: 'missing', remainingSize: '2', entryPrice: '0.2', entryFeeUsd: '0.01' },
    ],
    new Map([['token-yes', mark]]),
  );
  assert.equal(valuation.positionValueUsd.toString(), '6.4');
  assert.equal(valuation.unrealizedPnlUsd.toString(), '0.89');
  assert.equal(valuation.priceStatus, 'PARTIAL_COST_BASIS');
  assert.equal(valuation.unavailableMarkCount, 1);

  console.log('virtual copy mark price tests passed');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TtlMemoryCache, stableCacheKey } from './ttlMemoryCache';

describe('TtlMemoryCache', () => {
  it('returns cached value within TTL and singleflight concurrent loaders', async () => {
    const cache = new TtlMemoryCache({ ttlMs: 60_000, maxEntries: 8 });
    let loads = 0;
    const loader = async () => {
      loads += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { n: loads };
    };

    const [a, b] = await Promise.all([
      cache.getOrSet('k', loader),
      cache.getOrSet('k', loader),
    ]);
    assert.equal(loads, 1);
    assert.equal(a.hit, false);
    assert.equal(b.hit, true);
    assert.deepEqual(a.value, b.value);

    const c = await cache.getOrSet('k', loader);
    assert.equal(loads, 1);
    assert.equal(c.hit, true);
  });

  it('stableCacheKey sorts object keys', () => {
    assert.equal(
      stableCacheKey({ b: 1, a: { d: 2, c: 3 } }),
      stableCacheKey({ a: { c: 3, d: 2 }, b: 1 })
    );
  });
});

import assert from 'node:assert/strict';
import {
  assertSafeOutboundUrl,
  POLYMARKET_API_HOSTS,
  SsrfBlockedError,
  validateOutboundServiceUrl,
} from './ssrfGuard';

async function assertThrows(fn: () => Promise<void>, pattern?: RegExp): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch (err) {
    threw = true;
    assert.ok(err instanceof SsrfBlockedError, `expected SsrfBlockedError, got ${err}`);
    if (pattern) {
      assert.match((err as SsrfBlockedError).message, pattern);
    }
  }
  assert.ok(threw, 'expected function to throw SsrfBlockedError');
}

async function testAllowedPolymarketProfileUrl(): Promise<void> {
  await assertSafeOutboundUrl('https://polymarket.com/profile/0x0000000000000000000000000000000000000000', {
    allowedHosts: ['polymarket.com', 'www.polymarket.com'],
  });
  console.log('[PASS] allows polymarket.com profile URL');
}

async function testBlocksPrivateAndMetadataIps(): Promise<void> {
  const cases = [
    'http://127.0.0.1/',
    'http://10.0.0.1/',
    'http://169.254.169.254/',
    'http://[::1]/',
    'https://evil.com/',
  ];
  for (const url of cases) {
    await assertThrows(
      () =>
        assertSafeOutboundUrl(url, {
          allowedHosts: POLYMARKET_API_HOSTS,
        }),
      /Blocked/
    );
  }
  console.log('[PASS] blocks private/metadata and non-allowlisted hosts');
}

async function testBlocksUserinfoRedirectTrick(): Promise<void> {
  await assertThrows(
    () =>
      assertSafeOutboundUrl('https://polymarket.com@169.254.169.254/', {
        allowedHosts: ['polymarket.com'],
      }),
    /Blocked/
  );
  console.log('[PASS] blocks userinfo URL trick to metadata IP');
}

async function testValidateGoWalletUrlDevVsProd(): Promise<void> {
  const prevNodeEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'development';
    await validateOutboundServiceUrl('GO_WALLET_SERVICE_URL', 'http://127.0.0.1:9528');
    console.log('[PASS] dev allows http://127.0.0.1:9528');

    process.env.NODE_ENV = 'production';
    await validateOutboundServiceUrl('GO_WALLET_SERVICE_URL', 'http://127.0.0.1:9528');
    console.log('[PASS] production allows GO_WALLET http://127.0.0.1:9528 (co-located)');

    await validateOutboundServiceUrl('GO_WALLET_SERVICE_URL', 'http://172.19.0.5:9528');
    console.log('[PASS] production allows GO_WALLET http://RFC1918:9528 (split deploy)');

    await assertThrows(
      () => validateOutboundServiceUrl('POLYMARKET_RELAYER_URL', 'http://127.0.0.1:9528'),
      /production requires https/i
    );
    console.log('[PASS] production still rejects non-wallet localhost URLs');

    await assertThrows(
      () => validateOutboundServiceUrl('GO_WALLET_SERVICE_URL', 'http://169.254.169.254/'),
      /Blocked|not allowed|http|requires https/i
    );
    console.log('[PASS] production rejects metadata IP for Go wallet URL');
  } finally {
    if (prevNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = prevNodeEnv;
    }
  }
}

async function main(): Promise<void> {
  await testAllowedPolymarketProfileUrl();
  await testBlocksPrivateAndMetadataIps();
  await testBlocksUserinfoRedirectTrick();
  await testValidateGoWalletUrlDevVsProd();
  console.log('ssrfGuard tests finished OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import assert from 'node:assert/strict';
import { createServer } from 'node:http';

process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';
process.env.GO_WALLET_APP_KEY = 'test-key';
process.env.GO_WALLET_APP_TOKEN = 'test-token';

async function main() {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      requests.push({ path: req.url ?? '', body });
      res.setHeader('content-type', 'application/json');
      if (body.code === '999999') {
        res.statusCode = 503;
        res.end('{"message":"wallet unavailable"}');
        return;
      }
      if (req.url === '/createWallet') {
        res.end(
          `{"code":0,"derivation_credential":"${'ab'.repeat(32)}","data":[{"network":"Polygon","addr":"0x00000000000000000000000000000000000000AA","wallet_index":7}]}`,
        );
      } else if (req.url === '/withdrawal-authorizations/status') {
        res.end('{"code":0,"data":{"status":"enabled"}}');
      } else if (req.url === '/withdrawal-authorizations/setup') {
        res.end('{"code":0,"data":{"provisioningUri":"otpauth://test","secret":"SECRET","expiresIn":600}}');
      } else if (req.url === '/withdrawal-authorizations/verify') {
        res.end('{"code":0,"data":{"token":"opaque-one-shot","expiresIn":90}}');
      } else if (req.url === '/sign/typed-data') {
        res.end(`{"code":0,"address":"0x00000000000000000000000000000000000000AA","signature":"0x${'11'.repeat(65)}"}`);
      } else if (req.url === '/sign/message') {
        res.end(`{"code":0,"address":"0x00000000000000000000000000000000000000AA","signature":"0x${'22'.repeat(65)}"}`);
      } else if (req.url === '/treasury/payout-usdce') {
        res.end(
          '{"code":0,"hash":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","from":"0x00000000000000000000000000000000000000dd","to":"0x00000000000000000000000000000000000000bb","amount":"1250000"}',
        );
      } else {
        res.end('{"code":0,"data":{"totpEnabled":false}}');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  process.env.GO_WALLET_SERVICE_URL = `http://127.0.0.1:${address.port}`;

  try {
    const client = await import('./goWalletClient');
    const { createGoWalletViemAccount } = await import('./goWalletViemAccount');
    const identity = { refer_code: 'refer-123', walletIndex: 7 };
    const walletPassword = 'plain-wallet-password';

    assert.deepEqual(await client.goCreateWallet(identity.refer_code, walletPassword), {
      polygonAddress: '0x00000000000000000000000000000000000000AA',
      walletIndex: 7,
    });
    assert.equal(requests[0]?.body.wallet_password, walletPassword);

    assert.deepEqual(await client.goTotpStatus(identity), { totpEnabled: true });
    assert.equal(
      (await client.goTotpSetup({ ...identity, accountLabel: 'a@example.com', issuer: 'CopyOdds' }))
        .manualEntryKey,
      'SECRET',
    );

    const exactIntent = {
      ...identity,
      network: 'Polygon' as const,
      depositWallet: '0x00000000000000000000000000000000000000bb',
      asset: 'USDC.e' as const,
      to: '0x00000000000000000000000000000000000000cc',
      amount: '1.25',
      idempotencyKey: 'withdrawal-1',
      code: '123456',
    };
    assert.equal((await client.goTotpVerifyWithdraw(exactIntent)).authorization, 'opaque-one-shot');
    const verifyRequest = requests.find((r) => r.path === '/withdrawal-authorizations/verify');
    assert.deepEqual(verifyRequest?.body, exactIntent);

    const typedData = {
      domain: { name: 'Relay', chainId: 137 },
      types: { Relay: [{ name: 'nonce', type: 'uint256' }] },
      primaryType: 'Relay',
      message: { nonce: 1 },
    };
    const authorized = createGoWalletViemAccount({
      referCode: identity.refer_code,
      walletIndex: identity.walletIndex,
      walletPassword,
      address: '0x00000000000000000000000000000000000000AA',
      withdrawalAuthorization: {
        token: 'opaque-one-shot',
        idempotencyKey: exactIntent.idempotencyKey,
      },
    });
    const ordinary = createGoWalletViemAccount({
      referCode: identity.refer_code,
      walletIndex: identity.walletIndex,
      walletPassword,
      address: '0x00000000000000000000000000000000000000AA',
    });
    await authorized.signTypedData(typedData);
    await ordinary.signTypedData(typedData);
    const signBodies = requests.filter((r) => r.path === '/sign/typed-data').map((r) => r.body);
    assert.deepEqual(signBodies[0]?.withdrawalAuthorization, {
      token: 'opaque-one-shot',
      idempotencyKey: exactIntent.idempotencyKey,
    });
    assert.equal(
      'withdrawalAuthorization' in signBodies[1]!,
      false,
      'authorization must not leak to another signer',
    );
    assert.equal('platformAuthorization' in signBodies[0]!, false);
    assert.equal('platformAuthorization' in signBodies[1]!, false);
    for (const body of signBodies) {
      assert.equal(body.wallet_password, walletPassword);
    }

    const payout = await client.goTreasuryPayoutUsdce({
      to: '0x00000000000000000000000000000000000000bb',
      amount: '1250000',
    });
    assert.equal(payout.hash.startsWith('0x'), true);
    assert.deepEqual(
      requests.find((r) => r.path === '/treasury/payout-usdce')?.body,
      { to: '0x00000000000000000000000000000000000000bb', amount: '1250000' },
    );

    await client.goSignMessage(identity.refer_code, identity.walletIndex, walletPassword, 'test');
    await assert.rejects(
      () =>
        client.goSignTransaction({
          ...identity,
          wallet_password: walletPassword,
          chainId: 137,
          to: exactIntent.to,
          data: '0x',
          nonce: 1,
          gasLimit: 21_000,
          gasPrice: '0x1',
        }),
      /EOA transaction signing is disabled/,
    );
    assert.equal(requests.find((request) => request.path === '/sign/message')?.body.wallet_password, walletPassword);
    assert.equal(requests.some((request) => request.path === '/sign/transaction'), false);

    await assert.rejects(() =>
      client.goTotpVerifyWithdraw({ ...exactIntent, code: '999999' }),
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  console.log('goWalletClient.test.ts: ok');
}

main();

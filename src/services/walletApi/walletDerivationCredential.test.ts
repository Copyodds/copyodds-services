import assert from 'node:assert/strict';

process.env.CUSTODY_TREASURY_ADDRESS =
  process.env.CUSTODY_TREASURY_ADDRESS ?? '0x0000000000000000000000000000000000000001';
process.env.NODE_WALLET_DERIVATION_ENCRYPTION_KEY = '42'.repeat(32);

async function main() {
  const {
    loadWalletPassword,
    normalizeWalletPassword,
    upsertWalletPassword,
  } = await import('./walletDerivationCredential');
  const { generateWalletPassword } = await import('../custody/walletPasswordCrypto');

  assert.equal(normalizeWalletPassword('  secret  '), 'secret');
  assert.throws(() => normalizeWalletPassword(''));
  assert.throws(
    () => normalizeWalletPassword('aes-256-gcm.iv.tag.ct'),
    /Invalid wallet derivation credential ciphertext/,
  );

  assert.equal(generateWalletPassword('INVITE123'), generateWalletPassword('INVITE123'));
  assert.notEqual(generateWalletPassword('INVITE123'), generateWalletPassword('INVITE456'));

  const store = {
    walletDerivationCredential: {
      rows: new Map<string, { cipher: string; scheme: string; version: number; userId: number }>(),
      async upsert(args: {
        where: { referCode: string };
        create: { referCode: string; userId: number; cipher: string; scheme: string; version: number };
        update: { userId: number; cipher: string; scheme: string; version: number };
      }) {
        this.rows.set(args.where.referCode, {
          cipher: args.create.cipher ?? args.update.cipher,
          scheme: args.create.scheme ?? args.update.scheme,
          version: args.create.version ?? args.update.version,
          userId: args.create.userId ?? args.update.userId,
        });
      },
      async findUnique(args: { where: { referCode: string } }) {
        const row = this.rows.get(args.where.referCode);
        return row ? { cipher: row.cipher, version: row.version } : null;
      },
    },
  };

  await upsertWalletPassword(
    { referCode: 'INVITE123', userId: 1, walletPassword: 'plain-password' },
    store as never,
  );
  assert.equal(await loadWalletPassword('INVITE123', store as never), 'plain-password');
  assert.equal(
    store.walletDerivationCredential.rows.get('INVITE123')?.cipher,
    'plain-password',
  );

  await assert.rejects(
    () => loadWalletPassword('MISSING', store as never),
    /is missing/,
  );

  console.log('walletDerivationCredential.test.ts: ok');
}

void main();

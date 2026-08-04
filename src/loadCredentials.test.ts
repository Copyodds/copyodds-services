import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applySystemdCredentials, readCredentialFile } from './loadCredentials';

function withTempDir(run: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-cred-'));
  try {
    run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

withTempDir((dir) => {
  fs.writeFileSync(path.join(dir, 'go_wallet_app_key'), 'test-key\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'go_wallet_app_token'), 'test-token', 'utf8');
  fs.writeFileSync(path.join(dir, 'node_wallet_derivation_encryption_key'), 'a'.repeat(64), 'utf8');
  assert.equal(readCredentialFile(dir, 'go_wallet_app_key'), 'test-key');
  assert.equal(readCredentialFile(dir, 'go_wallet_app_token'), 'test-token');
  assert.equal(readCredentialFile(dir, 'missing'), null);
});

withTempDir((dir) => {
  process.env.CREDENTIALS_DIRECTORY = dir;
  process.env.GO_WALLET_APP_KEY = 'from-dotenv';
  process.env.GO_WALLET_APP_TOKEN = 'from-dotenv-token';
  fs.writeFileSync(path.join(dir, 'go_wallet_app_key'), 'from-credential', 'utf8');
  fs.writeFileSync(path.join(dir, 'go_wallet_app_token'), 'from-credential-token', 'utf8');
  fs.writeFileSync(path.join(dir, 'node_wallet_derivation_encryption_key'), 'b'.repeat(64), 'utf8');
  fs.writeFileSync(
    path.join(dir, 'custody_treasury_address'),
    '0x1111111111111111111111111111111111111111\n',
    'utf8',
  );

  const applied = applySystemdCredentials();
  assert.deepEqual(applied, [
    'GO_WALLET_APP_KEY',
    'GO_WALLET_APP_TOKEN',
    'NODE_WALLET_DERIVATION_ENCRYPTION_KEY',
    'CUSTODY_TREASURY_ADDRESS',
  ]);
  assert.equal(process.env.GO_WALLET_APP_KEY, 'from-credential');
  assert.equal(process.env.GO_WALLET_APP_TOKEN, 'from-credential-token');
  assert.equal(process.env.NODE_WALLET_DERIVATION_ENCRYPTION_KEY, 'b'.repeat(64));
  assert.equal(process.env.CUSTODY_TREASURY_ADDRESS, '0x1111111111111111111111111111111111111111');

  delete process.env.CREDENTIALS_DIRECTORY;
  delete process.env.GO_WALLET_APP_KEY;
  delete process.env.GO_WALLET_APP_TOKEN;
  delete process.env.NODE_WALLET_DERIVATION_ENCRYPTION_KEY;
  delete process.env.CUSTODY_TREASURY_ADDRESS;
});

console.log('loadCredentials.test.ts OK');

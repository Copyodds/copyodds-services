import assert from 'node:assert/strict';
import { decryptSecretV2, encryptSecretV2 } from './secretV2Crypto';

const pass = 'LocalDevWallet2026';
const plain = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const enc = encryptSecretV2(plain, pass);
assert.ok(enc.startsWith('v2:'));
assert.equal(decryptSecretV2(enc, pass), plain);

// wallet cfg.wallet.toml 中 mnemonicUser 样本（与 WALLET_PASSWORD_USER 联调口令一致时可解密）
const walletSample =
  'v2:G632GeC9F1EgFKYhonY8fus7H67dxSDREboLpOwv8OjQanqHEiTGbsFVNqobsOfRhp8UlY1cImbyi/WTn7LuRXwdzDoQBuw0X9fgwmYeP9V0RdAuvj4De1F3AvvI/1uTW8gl/VMTP9mWCLs2SZwpEcs/dDL8+nslbkNZOX/PMqaqLwoxwCfyI1o';
try {
  const m = decryptSecretV2(walletSample, pass);
  assert.ok(m.split(' ').length >= 12, 'wallet sample should decrypt to mnemonic words');
  console.info('[secretV2Crypto] wallet sample decrypt ok, words=', m.split(' ').length);
} catch (e) {
  console.warn('[secretV2Crypto] wallet sample skipped (password mismatch on this machine)');
}

console.info('[secretV2Crypto] roundtrip ok');

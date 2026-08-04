/**
 * 离线工具：将 relayer 明文私钥加密为 v2: 密文（与 wallet encrypt-mnemonic-v2 同算法）。
 *
 * 用法：
 *   npx tsx scripts/encrypt-relayer-key-v2.ts --private-key 0x... --password "与 WALLET_PASSWORD_GAS 一致的口令"
 *
 * 将输出写入 backend .env：
 *   EOA_FORWARD_RELAYER_PRIVATE_KEY=v2:...
 *   EOA_FORWARD_RELAYER_PASSWORD=...   # 或复用 WALLET_PASSWORD_GAS
 */
import { encryptSecretV2 } from '../src/utils/secretV2Crypto';

function readArg(flag: string): string {
  const i = process.argv.indexOf(flag);
  if (i < 0 || !process.argv[i + 1]) {
    console.error(`缺少参数 ${flag}`);
    process.exit(1);
  }
  return process.argv[i + 1];
}

const privateKey = readArg('--private-key');
const password = readArg('--password');

const out = encryptSecretV2(privateKey.trim(), password);
console.log(out);

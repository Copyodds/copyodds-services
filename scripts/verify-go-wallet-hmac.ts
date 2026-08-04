/**
 * 校验 Node `goWalletHmac` 与 Go `middleware.HMACReplayGuard` 的消息串一致（golden vector）。
 * 运行：npx tsx scripts/verify-go-wallet-hmac.ts
 */
import assert from 'node:assert';
import { goWalletHmacSignHex, sha256HexUtf8 } from '../src/services/walletApi/goWalletHmac';

const token = 'test-app-token';

assert.strictEqual(
  sha256HexUtf8('{}'),
  '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  'sha256({}) hex',
);

const sign = goWalletHmacSignHex({
  method: 'POST',
  path: '/sign/message',
  bodyStr: '{}',
  appToken: token,
  timestampSec: '1700000000',
  nonce: 'test-nonce-1',
});

assert.strictEqual(
  sign,
  '72eaf600b6969bf3a816f7e7a5481cb0ac100fae44875bf02bf6fe007fa8ffe0',
  'HMAC-SHA256 hex',
);

console.log('go-wallet HMAC contract OK');

import { createHash, createHmac, randomUUID } from 'node:crypto';

export function sha256HexUtf8(bodyStr: string): string {
  return createHash('sha256').update(bodyStr, 'utf8').digest('hex');
}

/** 与 Go wallet `middleware.HMACReplayGuard` 使用同一消息串（便于单测 golden）。 */
export function goWalletHmacSignHex(params: {
  method: string;
  path: string;
  bodyStr: string;
  appToken: string;
  timestampSec: string;
  nonce: string;
}): string {
  const bodyHash = sha256HexUtf8(params.bodyStr);
  const msg = `${params.method}\n${params.path}\n${params.timestampSec}\n${params.nonce}\n${bodyHash}`;
  return createHmac('sha256', params.appToken).update(msg, 'utf8').digest('hex');
}

/** 与 Go wallet `middleware.HMACReplayGuard` 一致：HMAC-SHA256(appToken, method+path+ts+nonce+sha256(body)) */
export function buildGoWalletHmacHeaders(params: {
  method: string;
  path: string;
  bodyStr: string;
  appToken: string;
}): { 'X-Timestamp': string; 'X-Nonce': string; 'X-Sign': string } {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID();
  const sign = goWalletHmacSignHex({
    method: params.method,
    path: params.path,
    bodyStr: params.bodyStr,
    appToken: params.appToken,
    timestampSec: ts,
    nonce,
  });
  return {
    'X-Timestamp': ts,
    'X-Nonce': nonce,
    'X-Sign': sign,
  };
}

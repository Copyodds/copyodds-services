/**
 * 统一从「项目根目录」加载 .env。
 * 部分 dotenv 版本会从 __dirname 去找 dist/src/.env，导致 PM2 下即使 cwd 正确也注入 0 个变量。
 * 顺序：process.cwd() → dist 上级（deploy 根）→ src 上级（本地开发根）。
 */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { applySystemdCredentials } from './loadCredentials';

const candidates = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '..', '..', '.env'),
  path.resolve(__dirname, '..', '.env'),
];

let loadedPath: string | null = null;
for (const p of candidates) {
  if (!fs.existsSync(p)) continue;
  // override: PM2 may retain stale PASSKEY_* from an earlier start; .env on disk should win.
  const r = dotenv.config({ path: p, override: true });
  if (!r.error) {
    loadedPath = p;
    const count = r.parsed ? Object.keys(r.parsed).length : 0;
    console.log(`[env] loaded ${p} (${count} vars)`);
    break;
  }
  console.warn(`[env] failed to parse ${p}:`, r.error?.message);
}

if (!loadedPath) {
  console.warn('[env] No readable .env file; tried:', candidates.join(' | '));
}

// systemd LoadCredential 优先于 .env 中的 GO_WALLET_APP_KEY / GO_WALLET_APP_TOKEN
applySystemdCredentials();

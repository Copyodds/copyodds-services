/**
 * 校验 Polymarket Builder 凭证是否可用。
 *
 * 注意：官方 support 提到的 GET /builder/profile 在公开 relayer-v2 上返回 404，
 * @polymarket/builder-relayer-client 也不包含该端点。tier / 日配额请到
 * https://polymarket.com/settings?tab=builder 查看（Current Tier）。
 *
 * 本脚本用已存在的鉴权端点 GET /transactions 验证 HMAC 凭证是否被 relayer 接受。
 *
 * 用法：
 *   npx tsx scripts/check-builder-profile.ts
 *   npm run check:builder-profile
 *   node --env-file=.env dist/scripts/check-builder-profile.js   # deploy 包
 */
import '../src/loadEnv';
import { BuilderSigner } from '@polymarket/builder-signing-sdk';
import { CONFIG } from '../src/config/env';
import {
  listBuilderCredentialSlots,
  type BuilderCredentialSlot,
} from '../src/services/polymarket/polymarketBuilderCredentials';

type ProbeResult = {
  path: string;
  status: number;
  body: string;
};

function maskKey(key: string): string {
  if (!key || key.length < 12) return '(too short)';
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

async function signedGet(
  slot: BuilderCredentialSlot,
  baseUrl: string,
  path: string
): Promise<ProbeResult> {
  const signer = new BuilderSigner({
    key: slot.key,
    secret: slot.secret,
    passphrase: slot.passphrase,
  });
  const headers = signer.createBuilderHeaderPayload('GET', path);
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
  const body = (await response.text()).slice(0, 800);
  return { path, status: response.status, body };
}

function interpretAuth(status: number, body: string): string {
  if (status >= 200 && status < 300) return '凭证有效（relayer 接受了 Builder HMAC）';
  if (status === 401 || status === 403) return '凭证被拒绝：检查 API_KEY / SECRET / PASSPHRASE 是否匹配 Builder 控制台';
  if (status === 404) return '端点不存在（路径未注册）';
  if (status === 429 || /quota|rate.?limit|too many/i.test(body)) {
    return '凭证有效，但已触发配额/限流（可能已用完日限额）';
  }
  return `未预期状态 ${status}`;
}

async function main(): Promise<void> {
  const baseUrl = CONFIG.polymarketRelayerUrl || 'https://relayer-v2.polymarket.com';
  const slots = listBuilderCredentialSlots();

  console.log('=== Polymarket Builder Credential Check ===');
  console.log(`relayer: ${baseUrl}`);
  console.log(`slots configured: ${slots.length}`);
  console.log(`
说明:
- GET /builder/profile 在公开 relayer 上目前 404，不能用来查 tier。
- tier / daily limit 请打开: https://polymarket.com/settings?tab=builder
- 本脚本改为探测 GET /transactions（builder-relayer-client 真实鉴权路径）。
`);

  if (slots.length === 0) {
    console.log(`FAIL: 未配置 POLYMARKET_BUILDER_API_KEY / SECRET / PASSPHRASE`);
    process.exit(1);
  }

  let anyOk = false;
  for (const slot of slots) {
    console.log(`\n--- slot ${slot.id} (${slot.label}) key=${maskKey(slot.key)} ---`);

    // 1) 官方提到但实际 404 的路径（保留探测，方便以后恢复）
    try {
      const profile = await signedGet(slot, baseUrl, '/builder/profile');
      console.log(`probe ${profile.path}: HTTP ${profile.status}`);
      if (profile.status === 404) {
        console.log('  (expected) /builder/profile 未开放；忽略');
      } else if (profile.status >= 200 && profile.status < 300) {
        console.log('  profile body:', profile.body);
        anyOk = true;
      } else {
        console.log('  body:', profile.body);
      }
    } catch (err) {
      console.log(`probe /builder/profile error:`, err instanceof Error ? err.message : err);
    }

    // 2) 真实鉴权探测
    try {
      const txns = await signedGet(slot, baseUrl, '/transactions');
      console.log(`probe ${txns.path}: HTTP ${txns.status}`);
      console.log(`  → ${interpretAuth(txns.status, txns.body)}`);
      if (txns.status >= 200 && txns.status < 300) {
        anyOk = true;
        try {
          const parsed = JSON.parse(txns.body);
          const n = Array.isArray(parsed) ? parsed.length : undefined;
          console.log(n !== undefined ? `  transactions returned: ${n}` : `  body: ${txns.body.slice(0, 200)}`);
        } catch {
          console.log(`  body: ${txns.body.slice(0, 200)}`);
        }
      } else {
        console.log(`  body: ${txns.body}`);
      }
    } catch (err) {
      console.log(`probe /transactions error:`, err instanceof Error ? err.message : err);
    }
  }

  console.log('\n=== 如何确认 Builder 账号状态（tier）===');
  console.log('1. 浏览器登录创建该 Builder 账号的 polymarket.com');
  console.log('2. Settings → Builders: https://polymarket.com/settings?tab=builder');
  console.log('3. 查看 Current Tier：Unverified(100/天) / Verified(10000/天) / Partner(无限)');
  console.log('4. 凭证可用但经常 429 → 多半是 Unverified 日限额用尽，邮件 builder@polymarket.com 申请 Verified');

  process.exit(anyOk ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

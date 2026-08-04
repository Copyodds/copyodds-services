/**
 * 可选：对运行中的 Go wallet-api + wallet-signer 做最小联调（createWallet + sign/message）。
 *
 * 前置：
 *   - wallet-signer 已启动（`GEN_PASSWORD` / `WALLET_PASSWORD_USER` 与 cfg 中助记词匹配）
 *   - wallet-api 监听 GO_WALLET_SERVICE_URL，`[signer].embedded=true` 或 signer.url 可用
 *
 * 运行：
 *   SMOKE_GO_WALLET=1 npx tsx scripts/smoke-go-wallet-e2e.ts
 */
import 'dotenv/config';

const ENABLED = process.env.SMOKE_GO_WALLET === '1' || process.env.SMOKE_GO_WALLET === 'true';

async function main() {
  if (!ENABLED) {
    console.log('skip smoke-go-wallet-e2e (set SMOKE_GO_WALLET=1 to run)');
    return;
  }

  const base = (process.env.GO_WALLET_SERVICE_URL ?? '').replace(/\/+$/, '');
  const key = process.env.GO_WALLET_APP_KEY ?? '';
  const token = process.env.GO_WALLET_APP_TOKEN ?? '';
  const walletPassword = process.env.SMOKE_WALLET_PASSWORD ?? 'SmokeTest99';

  if (!base || !key) {
    console.error('GO_WALLET_SERVICE_URL and GO_WALLET_APP_KEY required');
    process.exit(1);
  }

  const referCode = `PM${Date.now().toString().slice(-10)}`;
  const createBody = JSON.stringify({ refer_code: referCode, wallet_password: walletPassword });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-key': key,
  };

  if (token) {
    const { buildGoWalletHmacHeaders } = await import('../src/services/walletApi/goWalletHmac.js');
    Object.assign(headers, buildGoWalletHmacHeaders({ method: 'POST', path: '/createWallet', bodyStr: createBody, appToken: token }));
  }

  const r1 = await fetch(`${base}/createWallet`, { method: 'POST', headers, body: createBody });
  const t1 = await r1.text();
  if (!r1.ok) {
    console.error('createWallet failed', r1.status, t1);
    process.exit(1);
  }
  const j1 = JSON.parse(t1) as { data?: Array<{ network?: string; wallet_index?: number; addr?: string }> };
  const poly = j1.data?.find((x) => String(x.network ?? '').toLowerCase() === 'polygon');
  const wi = poly?.wallet_index;
  if (wi == null || typeof wi !== 'number') {
    console.error('createWallet: missing polygon wallet_index', t1);
    process.exit(1);
  }

  const signBody = JSON.stringify({ refer_code: referCode, walletIndex: wi, message: 'smoke-go-wallet-e2e' });
  const signHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-key': key,
  };
  if (token) {
    const { buildGoWalletHmacHeaders } = await import('../src/services/walletApi/goWalletHmac.js');
    Object.assign(signHeaders, buildGoWalletHmacHeaders({ method: 'POST', path: '/sign/message', bodyStr: signBody, appToken: token }));
  }

  const r2 = await fetch(`${base}/sign/message`, { method: 'POST', headers: signHeaders, body: signBody });
  const t2 = await r2.text();
  if (!r2.ok) {
    console.error('sign/message failed', r2.status, t2);
    process.exit(1);
  }
  const j2 = JSON.parse(t2) as { signature?: string; address?: string; code?: number; msg?: string };
  if (j2.code && j2.code !== 0) {
    console.error('sign/message error payload', t2);
    process.exit(1);
  }
  if (!j2.signature?.startsWith('0x')) {
    console.error('sign/message: missing signature', t2);
    process.exit(1);
  }

  console.log('smoke-go-wallet-e2e OK', { referCode, walletIndex: wi, address: j2.address });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

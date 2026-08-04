import type { ApiKeyCreds, ClobClient } from '@polymarket/clob-client-v2';

function normalizeClobApiKeyCreds(raw: unknown): ApiKeyCreds {
  if (!raw || typeof raw !== 'object') return raw as ApiKeyCreds;
  const r = raw as Record<string, unknown>;
  const key = (r.key ?? r.apiKey ?? r.api_key ?? '').toString();
  const secret = (r.secret ?? r.apiSecret ?? r.api_secret ?? '').toString();
  const passphrase = (r.passphrase ?? '').toString();
  return { key, secret, passphrase };
}

function credsComplete(c: ApiKeyCreds): boolean {
  return Boolean(c.key?.trim() && c.secret?.trim() && c.passphrase?.trim());
}

/** SDK 的 createOrDeriveApiKey 在 createApiKey 抛错时不会走 derive；Polymarket 常对「已存在 key」返回 400 Could not create api key。 */
function isRecoverableCreateApiKeyFailure(err: unknown): boolean {
  const e = err as { name?: string; status?: number; message?: string; data?: { error?: unknown } };
  if (e?.name !== 'ApiError' || typeof e.status !== 'number') return false;
  if (e.status !== 400 && e.status !== 409) return false;
  const blob = `${e.message ?? ''} ${typeof e.data?.error === 'string' ? e.data.error : JSON.stringify(e.data ?? {})}`.toLowerCase();
  return (
    blob.includes('could not create') ||
    blob.includes('create api key') ||
    blob.includes('already') ||
    blob.includes('exists') ||
    blob.includes('maximum') ||
    blob.includes('limit')
  );
}

/**
 * L1 交换 CLOB API credentials：优先 derive（侧已有 key），否则 create；create 在可恢复 400/409 时再 derive。
 * 替代 `ClobClient#createOrDeriveApiKey`（其在 create 抛错时不回退）。
 */
export async function exchangeClobL1ApiKeyCreateOrDerive(client: ClobClient): Promise<ApiKeyCreds> {
  try {
    const d0 = normalizeClobApiKeyCreds(await client.deriveApiKey(0));
    if (credsComplete(d0)) return d0;
  } catch {
    /* 尚无 key 时 derive 失败属正常 */
  }

  try {
    const created = normalizeClobApiKeyCreds(await client.createApiKey(0));
    if (credsComplete(created)) return created;
  } catch (e) {
    if (!isRecoverableCreateApiKeyFailure(e)) throw e;
  }

  const d1 = normalizeClobApiKeyCreds(await client.deriveApiKey(0));
  if (!credsComplete(d1)) {
    throw new Error('Polymarket CLOB deriveApiKey returned incomplete credentials after create');
  }
  return d1;
}

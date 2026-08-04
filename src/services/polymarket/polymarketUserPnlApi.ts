/**
 * 官网个人页「盈亏」曲线在浏览器中由 user-pnl-api 提供（与 __NEXT_DATA__ 脱水字段同源形状：t=unix 秒、p=美元累计盈亏）。
 * @see https://github.com/qualiaenjoyer/polymarket-apis/blob/main/src/polymarket_apis/clients/data_client.py (get_pnl)
 */

import { CONFIG } from '../../config/env';
import { polymarketApiSafeFetchOptions, safeFetch } from '../../utils/ssrfGuard';

const USER_PNL_API_URL = 'https://user-pnl-api.polymarket.com/user-pnl';

export type UserPnlApiInterval = '1d' | '1w' | '1m' | 'all';
export type UserPnlApiFidelity = '1h' | '3h' | '12h' | '1d';

export type UserPnlTimeseriesPoint = { t: number; p: number };

function parseTimeseriesPayload(data: unknown): UserPnlTimeseriesPoint[] {
  if (!Array.isArray(data)) return [];
  const out: UserPnlTimeseriesPoint[] = [];
  for (const row of data) {
    if (typeof row !== 'object' || row == null) continue;
    const r = row as Record<string, unknown>;
    const pRaw = r.p;
    const p = typeof pRaw === 'number' ? pRaw : Number(pRaw);
    let t: number | null = null;
    const tRaw = r.t;
    if (typeof tRaw === 'number' && Number.isFinite(tRaw)) {
      t = tRaw;
    } else if (typeof tRaw === 'string') {
      const ms = Date.parse(tRaw);
      if (!Number.isNaN(ms)) t = ms / 1000;
    }
    if (t == null || !Number.isFinite(t) || !Number.isFinite(p)) continue;
    out.push({ t, p });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * @param wallet 小写 0x 地址
 * @param interval API 窗口，与官网 query 一致
 */
export async function fetchUserPnlTimeseries(
  wallet: string,
  interval: UserPnlApiInterval,
  options?: { fidelity?: UserPnlApiFidelity; timeoutMs?: number }
): Promise<UserPnlTimeseriesPoint[]> {
  const fidelity = options?.fidelity ?? CONFIG.polymarketUserPnlFidelity;
  const timeoutMs = options?.timeoutMs ?? CONFIG.smartMoneyProfileTimeoutMs;
  const params = new URLSearchParams({
    user_address: wallet.trim().toLowerCase(),
    interval,
    fidelity,
  });

  let res: Response;
  try {
    res = await safeFetch(
      `${USER_PNL_API_URL}?${params}`,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
      polymarketApiSafeFetchOptions()
    );
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'AbortError' || name === 'TimeoutError') {
      throw new Error(`user-pnl-api timeout after ${timeoutMs}ms`);
    }
    throw err;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`user-pnl-api ${res.status}: ${text || res.statusText}`);
  }

  const json = (await res.json()) as unknown;
  return parseTimeseriesPayload(json);
}

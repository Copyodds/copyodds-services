import { CONFIG } from '../../config/env';
import {
  fetchPolymarketProfile,
  enrichPolymarketProfilePnlPeriods,
  type PolymarketProfileFetchResult,
} from '../polymarket/polymarketProfile';

/** Phase F：Light 抓取 — HTML-only 或边界区补 pnl-api */
export async function fetchPolymarketProfileForLight(
  wallet: string
): Promise<PolymarketProfileFetchResult> {
  if (!CONFIG.smartMoneyLightHtmlOnly) {
    return fetchPolymarketProfile(wallet, { pnlPeriods: ['1W', 'ALL'] });
  }

  // 官网 Profile 已迁移为 CSR/RSC 壳，不再包含 __NEXT_DATA__。继续走 HTML 会重复下载
  // /en/profile + /profile 两份大页面后才 fallback。Light 直接取精简 API 画像。
  let profile = await fetchPolymarketProfile(wallet, {
    skipPnlApi: true,
    lightweightApiFallback: true,
  });
  const minCurve = CONFIG.smartMoneyMinCurvePointCount;
  const borderlineFloor = Math.max(2, minCurve - CONFIG.smartMoneyLightBorderlineCurveGap);

  if (profile.curves.length >= minCurve) {
    return profile;
  }
  if (profile.curves.length >= borderlineFloor && profile.curves.length < minCurve) {
    profile = await enrichPolymarketProfilePnlPeriods(profile, ['1W', 'ALL']);
  }
  return profile;
}

export function shouldPersistProfileAfterLightPass(): boolean {
  /** 默认 false：Light 热路径不写库；Deep 无快照时 live 拉取 */
  return CONFIG.smartMoneyLightPersistSnapshot;
}

import { CONFIG } from '../../config/env';
import { TtlMemoryCache } from '../../utils/ttlMemoryCache';

/** 聪明钱前台读路径进程内缓存（不经 Redis；不影响管道写速度） */
export const smartMoneyCachedListCache = new TtlMemoryCache({
  ttlMs: CONFIG.smartMoneyListCacheTtlMs,
  maxEntries: CONFIG.smartMoneyListCacheMaxEntries,
});

export const smartMoneyProfileRiskCache = new TtlMemoryCache({
  ttlMs: CONFIG.smartMoneyProfileRiskCacheTtlMs,
  maxEntries: CONFIG.smartMoneyProfileRiskCacheMaxEntries,
});

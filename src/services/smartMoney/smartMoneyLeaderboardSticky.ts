export {
  smartMoneyCachedDisplayWhere,
  smartMoneyLeaderboardRankWhere,
  buildSmartMoneyCachedApiMeta,
} from './smartMoneyCachedQuery';

export async function listSmartMoneyStickyRankedWallets(): Promise<string[]> {
  // 单轨模式不再保护 sticky 排名钱包。
  return [];
}

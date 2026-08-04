export {
  buildSmartMoneyCachedApiMeta,
  smartMoneyCachedDisplayWhere,
} from './smartMoneyCachedQuery';

export type SmartMoneyDisplayMode = 'copy_pool';

/** @deprecated 单轨模式固定为 CopyPool。 */
export function getSmartMoneyDisplayMode(): SmartMoneyDisplayMode {
  return 'copy_pool';
}

/**
 * `eligibleOnly=true` 在管道模式下等价于 CopyPool 展示过滤。
 * 保留参数名仅为兼容旧客户端。
 */
export function resolveSmartMoneyCachedEligibleOnly(eligibleOnly: boolean): boolean {
  return eligibleOnly;
}

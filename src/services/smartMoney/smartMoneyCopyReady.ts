/**
 * 仿跟单「已算出 / 可上榜」判断（无 DB 依赖，供入池与展示门共用）。
 * 订阅跟单不使用此门：用户自选地址默认可跟（warn 策略）。
 */
import { CONFIG } from '../../config/env';

/** 仿跟单分已落库（含 0）：不再因「未算完」排队 Enrich */
export function isCopyabilityComputed(score: number | null | undefined): boolean {
  return score != null && Number.isFinite(Number(score));
}

/**
 * Enrich 完成判定：已算出即可（含 0），低分不再重复占 Enrich 队。
 * 未算出（null）→ COPY_NOT_READY。
 */
export function isCopyabilityReadyForPool(score: number | null | undefined): boolean {
  return isCopyabilityComputed(score);
}

/** 入池/展示统一门槛（默认 25；替代旧 >0） */
export function copyabilityPoolMinComposite(): number {
  return CONFIG.smartMoneyCopyPoolMinComposite;
}

/**
 * 入池 / 榜单展示：综合分须 ≥ MIN。
 * 未达线由 CopyPool/Deep 直接 ELIMINATED，不占 SCORED。
 */
export function isCopyabilityEligibleForPoolEnter(
  score: number | null | undefined
): boolean {
  if (!isCopyabilityComputed(score)) return false;
  return Number(score) >= copyabilityPoolMinComposite();
}

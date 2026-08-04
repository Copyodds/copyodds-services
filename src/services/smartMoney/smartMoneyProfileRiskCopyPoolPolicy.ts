export type ProfileRiskCopyPoolPolicy = 'off' | 'warn' | 'block';

export type ProfileRiskCopyPoolCheck = {
  allowed: boolean;
  policy: ProfileRiskCopyPoolPolicy;
  inCopyPool: boolean | null;
  notInCopyPool: boolean;
};

export function resolveProfileRiskCopyPoolCheck(
  policy: ProfileRiskCopyPoolPolicy,
  inCopyPool: boolean | null
): ProfileRiskCopyPoolCheck {
  if (policy === 'off') {
    return { allowed: true, policy, inCopyPool, notInCopyPool: false };
  }
  if (inCopyPool === true) {
    return { allowed: true, policy, inCopyPool: true, notInCopyPool: false };
  }
  if (policy === 'block') {
    return { allowed: false, policy, inCopyPool: false, notInCopyPool: true };
  }
  return { allowed: true, policy, inCopyPool: inCopyPool ?? false, notInCopyPool: true };
}

/** 已完成分析并落 ScoreCache 的地址允许查看详情；CopyPool policy 只约束跟单资格。 */
export function resolveAnalyzedProfileRiskCopyPoolCheck(
  policy: ProfileRiskCopyPoolPolicy,
  inCopyPool: boolean | null,
  hasScoreCache: boolean
): ProfileRiskCopyPoolCheck {
  const resolved = resolveProfileRiskCopyPoolCheck(policy, inCopyPool);
  if (!resolved.allowed && hasScoreCache) {
    return {
      allowed: true,
      policy,
      inCopyPool: false,
      notInCopyPool: true,
    };
  }
  return resolved;
}

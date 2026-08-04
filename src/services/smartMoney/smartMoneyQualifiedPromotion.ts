import { prisma } from '../../db';
import { CONFIG } from '../../config/env';

export async function countQualifiedActive(): Promise<number> {
  return prisma.smartMoneyRawAddress.count({
    where: { pipelineStage: 'QUALIFIED', dormant: false },
  });
}

/** QUALIFIED 池是否已满（H-L3：晋升前拦截，避免 cap 后踢浪费 Light） */
export async function isQualifiedPoolFull(): Promise<boolean> {
  const cap = CONFIG.smartMoneyQualifiedMaxActive;
  if (cap <= 0) return false;
  const active = await countQualifiedActive();
  return active >= cap;
}

export function getQualifiedFullHoldUntil(): Date {
  return new Date(Date.now() + CONFIG.smartMoneyQualifiedFullHoldMs);
}

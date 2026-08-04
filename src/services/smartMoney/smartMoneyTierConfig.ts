import { prisma } from '../../db';
import {
  applySmartMoneyTierThresholdOverrides,
  clearSmartMoneyTierThresholdOverrides,
  getSmartMoneyTierThresholds,
  pickSmartMoneyTierThresholds,
  type SmartMoneyTierThresholds,
} from './smartMoneyTierThresholds';

export type { SmartMoneyTierThresholds } from './smartMoneyTierThresholds';
export { getSmartMoneyTierThresholds } from './smartMoneyTierThresholds';

export type SmartMoneyTierConfigSnapshot = {
  version: 'v1';
  updatedAt: string;
  updatedBy?: string | null;
  thresholds: Partial<SmartMoneyTierThresholds>;
};

let cacheLoadedAt = 0;
const CACHE_TTL_MS = 60_000;

export async function refreshSmartMoneyTierConfigCache(force = false): Promise<SmartMoneyTierThresholds> {
  const now = Date.now();
  if (!force && now - cacheLoadedAt < CACHE_TTL_MS) {
    return getSmartMoneyTierThresholds();
  }

  const row = await prisma.smartMoneyTierConfig.findUnique({ where: { id: 1 } });
  const snapshot = row?.config as SmartMoneyTierConfigSnapshot | null;
  applySmartMoneyTierThresholdOverrides(
    pickSmartMoneyTierThresholds(snapshot?.thresholds ?? snapshot)
  );
  cacheLoadedAt = now;
  return getSmartMoneyTierThresholds();
}

export async function getSmartMoneyTierConfigSnapshot(): Promise<{
  effective: SmartMoneyTierThresholds;
  override: SmartMoneyTierConfigSnapshot | null;
}> {
  await refreshSmartMoneyTierConfigCache();
  const row = await prisma.smartMoneyTierConfig.findUnique({ where: { id: 1 } });
  const override =
    row?.config && typeof row.config === 'object'
      ? (row.config as SmartMoneyTierConfigSnapshot)
      : null;
  return {
    effective: getSmartMoneyTierThresholds(),
    override,
  };
}

export async function upsertSmartMoneyTierConfigSnapshot(input: {
  thresholds: Partial<SmartMoneyTierThresholds>;
  updatedBy?: string | null;
}): Promise<SmartMoneyTierConfigSnapshot> {
  const snapshot: SmartMoneyTierConfigSnapshot = {
    version: 'v1',
    updatedAt: new Date().toISOString(),
    updatedBy: input.updatedBy ?? null,
    thresholds: pickSmartMoneyTierThresholds(input.thresholds),
  };

  await prisma.smartMoneyTierConfig.upsert({
    where: { id: 1 },
    create: { id: 1, config: snapshot },
    update: { config: snapshot },
  });

  applySmartMoneyTierThresholdOverrides(snapshot.thresholds);
  cacheLoadedAt = Date.now();
  return snapshot;
}

export async function clearSmartMoneyTierConfigOverrides(): Promise<void> {
  await prisma.smartMoneyTierConfig.deleteMany({ where: { id: 1 } });
  clearSmartMoneyTierThresholdOverrides();
  cacheLoadedAt = Date.now();
}

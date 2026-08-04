/**
 * Builder Relayer slot 选择（纯函数，无 env 依赖）。
 */
export type BuilderSlotPreference = 'backup_first' | 'primary_only';

export type BuilderSlotPool = 'primary' | 'backup';

export type BuilderCredentialSlotLike = {
  id: string;
};

export type BuilderSlotSelection<T extends BuilderCredentialSlotLike> = {
  slots: T[];
  /** backup_first 时因无可用备用而退回 primary */
  fallbackToPrimary: boolean;
  skippedCooldownSlotIds: string[];
};

export function builderSlotPool(slotId: string): BuilderSlotPool {
  return slotId === 'primary' ? 'primary' : 'backup';
}

/**
 * - primary_only：仅 primary
 * - backup_first：先全部可用 backup；若无则退回可用 primary
 */
export function selectBuilderCredentialSlotsForPreference<T extends BuilderCredentialSlotLike>(
  allSlots: T[],
  preference: BuilderSlotPreference,
  isSlotAvailable: (slotId: string) => boolean
): BuilderSlotSelection<T> {
  const skippedCooldownSlotIds = allSlots.filter((s) => !isSlotAvailable(s.id)).map((s) => s.id);

  if (preference === 'primary_only') {
    return {
      slots: allSlots.filter((s) => s.id === 'primary' && isSlotAvailable(s.id)),
      fallbackToPrimary: false,
      skippedCooldownSlotIds,
    };
  }

  const backups = allSlots.filter((s) => s.id !== 'primary' && isSlotAvailable(s.id));
  if (backups.length > 0) {
    return { slots: backups, fallbackToPrimary: false, skippedCooldownSlotIds };
  }

  const primary = allSlots.filter((s) => s.id === 'primary' && isSlotAvailable(s.id));
  return {
    slots: primary,
    fallbackToPrimary: primary.length > 0,
    skippedCooldownSlotIds,
  };
}

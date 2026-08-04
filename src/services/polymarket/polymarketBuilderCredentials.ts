/**
 * Polymarket Builder API 凭证：主 key（POLYMARKET_BUILDER_*）+ 备选 JSON（POLYMARKET_BUILDER_BACKUP_CREDENTIALS）。
 * 配额冷却按 slot 维度记录；可按操作类型选择 primary_only / backup_first。
 */
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { CONFIG } from '../../config/env';
import { createConflictError } from '../../utils/appError';
import {
  builderSlotPool,
  selectBuilderCredentialSlotsForPreference,
  type BuilderSlotPreference,
  type BuilderSlotPool,
  type BuilderSlotSelection,
} from './polymarketBuilderSlotSelect';

export type { BuilderSlotPreference, BuilderSlotPool, BuilderSlotSelection };
export { builderSlotPool, selectBuilderCredentialSlotsForPreference };

export type BuilderCredentialSlot = {
  id: string;
  label: string;
  key: string;
  secret: string;
  passphrase: string;
};

const slotQuotaCooldownUntilMs = new Map<string, number>();

function isRelayerQuotaExceededMessage(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes('quota exceeded') ||
    m.includes('too many requests') ||
    m.includes('"status":429') ||
    m.includes('status":429') ||
    m.includes('error code: 1015')
  );
}

function parseRelayerQuotaResetMs(msg: string): number | null {
  const match = msg.match(/resets in (\d+) seconds/i);
  if (!match?.[1]) return null;
  const sec = Number.parseInt(match[1], 10);
  if (!Number.isFinite(sec) || sec <= 0) return null;
  return sec * 1000;
}

function sanitizeSlotLabel(raw: string | undefined, fallback: string): string {
  const label = (raw ?? '').trim();
  if (!label) return fallback;
  return label.slice(0, 64);
}

function slotIdFromLabel(label: string, index: number): string {
  const base = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || `backup-${index}`;
}

export function listBuilderCredentialSlots(): BuilderCredentialSlot[] {
  const slots: BuilderCredentialSlot[] = [];
  if (
    CONFIG.polymarketBuilderApiKey &&
    CONFIG.polymarketBuilderSecret &&
    CONFIG.polymarketBuilderPassphrase
  ) {
    slots.push({
      id: 'primary',
      label: 'primary',
      key: CONFIG.polymarketBuilderApiKey,
      secret: CONFIG.polymarketBuilderSecret,
      passphrase: CONFIG.polymarketBuilderPassphrase,
    });
  }

  for (let i = 0; i < CONFIG.polymarketBuilderBackupCredentials.length; i++) {
    const row = CONFIG.polymarketBuilderBackupCredentials[i]!;
    const label = sanitizeSlotLabel(row.label, `backup-${i + 1}`);
    const id = slotIdFromLabel(label, i + 1);
    if (slots.some((s) => s.id === id)) {
      slots.push({
        id: `${id}-${i + 1}`,
        label,
        key: row.key,
        secret: row.secret,
        passphrase: row.passphrase,
      });
    } else {
      slots.push({
        id,
        label,
        key: row.key,
        secret: row.secret,
        passphrase: row.passphrase,
      });
    }
  }
  return slots;
}

export function getAvailableBuilderCredentialSlots(): BuilderCredentialSlot[] {
  const now = Date.now();
  return listBuilderCredentialSlots().filter((slot) => (slotQuotaCooldownUntilMs.get(slot.id) ?? 0) <= now);
}

/**
 * 按偏好选出可用 slot（已过滤配额冷却）。
 * - primary_only：仅 primary
 * - backup_first：先全部可用 backup；若无则退回可用 primary
 */
export function getBuilderCredentialSlotsForPreference(
  preference: BuilderSlotPreference
): BuilderSlotSelection<BuilderCredentialSlot> {
  const now = Date.now();
  return selectBuilderCredentialSlotsForPreference(
    listBuilderCredentialSlots(),
    preference,
    (slotId) => (slotQuotaCooldownUntilMs.get(slotId) ?? 0) <= now
  );
}

export function isAnyBuilderSlotAvailable(): boolean {
  return getAvailableBuilderCredentialSlots().length > 0;
}

/** 单测用：清空配额冷却。 */
export function clearBuilderSlotQuotaCooldownsForTests(): void {
  slotQuotaCooldownUntilMs.clear();
}

export function getBuilderQuotaCooldownRemainingMs(): number {
  const slots = listBuilderCredentialSlots();
  if (!slots.length) return 0;
  const now = Date.now();
  if (getAvailableBuilderCredentialSlots().length > 0) return 0;

  let minRemaining = Number.POSITIVE_INFINITY;
  for (const slot of slots) {
    const until = slotQuotaCooldownUntilMs.get(slot.id) ?? 0;
    if (until > now) {
      minRemaining = Math.min(minRemaining, until - now);
    }
  }
  return Number.isFinite(minRemaining) ? minRemaining : 0;
}

export function noteBuilderSlotQuotaCooldown(slotId: string, msg: string): void {
  if (!isRelayerQuotaExceededMessage(msg)) return;
  const resetMs = parseRelayerQuotaResetMs(msg);
  const until = Date.now() + (resetMs ?? 15 * 60 * 1000);
  const prev = slotQuotaCooldownUntilMs.get(slotId) ?? 0;
  if (until > prev) {
    slotQuotaCooldownUntilMs.set(slotId, until);
    console.warn('[polymarket-builder] slot quota cooldown', {
      slotId,
      until: new Date(until).toISOString(),
      remainingSec: Math.ceil((until - Date.now()) / 1000),
    });
  }
}

export function createBuilderConfigForSlot(slot: BuilderCredentialSlot): BuilderConfig {
  const builderConfig = new BuilderConfig({
    localBuilderCreds: {
      key: slot.key,
      secret: slot.secret,
      passphrase: slot.passphrase,
    },
  });
  if (!builderConfig.isValid()) {
    throw createConflictError('Polymarket Builder 凭证无效', {
      reasonCode: 'POLYMARKET_CREDENTIALS_INVALID',
      slotId: slot.id,
      slotLabel: slot.label,
    });
  }
  return builderConfig;
}

/** 运维自检：各 slot 冷却状态（不含 secret）。 */
export function getBuilderCredentialSlotStatus(): Array<{
  id: string;
  label: string;
  keyPrefix: string;
  available: boolean;
  cooldownRemainingMs: number;
}> {
  const now = Date.now();
  return listBuilderCredentialSlots().map((slot) => {
    const until = slotQuotaCooldownUntilMs.get(slot.id) ?? 0;
    const cooldownRemainingMs = Math.max(0, until - now);
    return {
      id: slot.id,
      label: slot.label,
      keyPrefix: slot.key.slice(0, 8),
      available: cooldownRemainingMs <= 0,
      cooldownRemainingMs,
    };
  });
}

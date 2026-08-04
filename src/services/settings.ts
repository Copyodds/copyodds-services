import { prisma } from '../db';
import { CONFIG } from '../config/env';
import { getCachedCustodyUsdcBalanceForUser } from './custody/userBalanceCache';
import { USDC_E_ADDRESS } from './polymarket/web3';

type SettingsPatchInput = {
  preferences?: Partial<{
    displayPnlInUsd: boolean;
    showDemoData: boolean;
  }>;
  metadata?: {
    securityNoticeSeenAt?: Date | null;
  };
};

export type UserSettingsProfileDto = {
  preferences: {
    displayPnlInUsd: boolean;
    showDemoData: boolean;
  };
  subscription: {
    hasActivePlan: boolean;
    latestPurchase: {
      orderId: number;
      status: string;
      packageId: number;
      packageName: string | null;
      paidUsd: string;
      gasAmount: string;
      fulfilledAt: string | null;
    } | null;
    activeCopySubscriptions: number;
  };
  security: {
    email: string | null;
    fullName: string | null;
    termsAccepted: boolean;
    termsAcceptedAt: string | null;
    tradingBlocked: boolean;
    tradingDisabledReason: string | null;
    tradingDisabledUntil: string | null;
    activeSessionCount: number;
    currentSessionExpiresAt: string | null;
    connectedWalletCount: number;
    hasCustodialWallet: boolean;
    custodialWalletAddress: string | null;
    custodialWalletCount: number;
    onChainUsdcBalance: {
      address: string;
      chainId: number;
      tokenAddress: string;
      usdc: { raw: string; decimals: number; formatted: string };
      cachedAt: string;
      cacheExpiresAt: string | null;
    } | null;
    executionMode: string;
    provider: string | null;
    sessionStatus: 'active' | 'inactive';
    sessionValidUntil: string | null;
  };
  metadata: {
    updatedAt: string | null;
    securityNoticeSeenAt: string | null;
  };
};

const SETTINGS_PROFILE_CACHE_MS = 60_000;

const settingsProfileCache = new Map<
  number,
  { expiresAt: number; value: UserSettingsProfileDto }
>();

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function buildOnChainUsdcBalanceFromCache(
  walletAddress: string,
  cached: { formatted: string; cachedAt: Date }
) {
  return {
    address: walletAddress,
    chainId: CONFIG.chainId || 137,
    tokenAddress: USDC_E_ADDRESS,
    usdc: {
      raw: cached.formatted,
      decimals: 6,
      formatted: cached.formatted,
    },
    cachedAt: cached.cachedAt.toISOString(),
    cacheExpiresAt: null as string | null,
  };
}

function invalidateSettingsProfileCache(userId: number): void {
  settingsProfileCache.delete(userId);
}

async function ensureUserSettings(userId: number) {
  try {
    return await (prisma as any).userSettings.upsert({
      where: { userId },
      update: {},
      create: { userId },
    });
  } catch (err: any) {
    if (err?.code === 'P2002') {
      const existing = await (prisma as any).userSettings.findUnique({
        where: { userId },
      });
      if (existing) return existing;
    }
    throw err;
  }
}

async function buildUserSettingsProfile(
  userId: number,
  sessionId?: string
): Promise<UserSettingsProfileDto> {
  const now = new Date();

  const [user, activeSessionCount, wallets, latestPackageOrder, activeCopySubscriptions, cachedCustodyUsdc] =
    await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          email: true,
          firstName: true,
          lastName: true,
          termsAcceptedAt: true,
          tradingDisabled: true,
          tradingDisabledReason: true,
          tradingDisabledUntil: true,
          settings: {
            select: {
              displayPnlInUsd: true,
              showDemoData: true,
              updatedAt: true,
              securityNoticeSeenAt: true,
            },
          },
        },
      }),
      prisma.userSession.count({
        where: {
          userId,
          expiresAt: { gt: now },
        },
      }),
      prisma.wallet.findMany({
        where: { userId },
        select: { type: true, address: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.gasPackageOrder.findFirst({
        where: {
          userId,
          fulfilledAt: { not: null },
        },
        orderBy: [{ fulfilledAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          status: true,
          paidUsd: true,
          gasAmount: true,
          fulfilledAt: true,
          package: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      }),
      prisma.copySubscription.count({
        where: {
          userId,
          enabled: true,
        },
      }),
      getCachedCustodyUsdcBalanceForUser(userId),
    ]);

  if (!user) {
    throw new Error(`User ${userId} not found`);
  }

  const settings = user.settings;
  const custodialWallets = wallets.filter((w) => w.type === 'CUSTODIAL');
  const primaryWallet = custodialWallets[0] ?? null;
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();

  let currentSessionExpiresAt: string | null = null;
  if (sessionId) {
    const session = await prisma.userSession.findUnique({
      where: { id: sessionId },
      select: { expiresAt: true },
    });
    currentSessionExpiresAt = toIso(session?.expiresAt);
  }

  const onChainUsdcBalance =
    primaryWallet && cachedCustodyUsdc
      ? buildOnChainUsdcBalanceFromCache(primaryWallet.address, cachedCustodyUsdc)
      : null;

  return {
    preferences: {
      displayPnlInUsd: settings?.displayPnlInUsd ?? true,
      showDemoData: settings?.showDemoData ?? true,
    },
    subscription: {
      hasActivePlan: latestPackageOrder !== null,
      latestPurchase: latestPackageOrder
        ? {
            orderId: latestPackageOrder.id,
            status: latestPackageOrder.status,
            packageId: latestPackageOrder.package.id,
            packageName: latestPackageOrder.package.name ?? null,
            paidUsd: latestPackageOrder.paidUsd.toString(),
            gasAmount: latestPackageOrder.gasAmount.toString(),
            fulfilledAt: toIso(latestPackageOrder.fulfilledAt),
          }
        : null,
      activeCopySubscriptions,
    },
    security: {
      email: user.email ?? null,
      fullName: fullName || null,
      termsAccepted: user.termsAcceptedAt !== null,
      termsAcceptedAt: toIso(user.termsAcceptedAt),
      tradingBlocked: user.tradingDisabled,
      tradingDisabledReason: user.tradingDisabledReason ?? null,
      tradingDisabledUntil: toIso(user.tradingDisabledUntil),
      activeSessionCount,
      currentSessionExpiresAt,
      connectedWalletCount: wallets.length,
      hasCustodialWallet: primaryWallet !== null,
      custodialWalletAddress: primaryWallet?.address ?? null,
      custodialWalletCount: custodialWallets.length,
      onChainUsdcBalance,
      executionMode: 'demo_custodial',
      provider: null,
      sessionStatus: 'inactive',
      sessionValidUntil: null,
    },
    metadata: {
      updatedAt: toIso(settings?.updatedAt),
      securityNoticeSeenAt: toIso(settings?.securityNoticeSeenAt),
    },
  };
}

export async function getUserSettingsProfile(
  userId: number,
  sessionId?: string
): Promise<UserSettingsProfileDto> {
  const cached = settingsProfileCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const value = await buildUserSettingsProfile(userId, sessionId);
  settingsProfileCache.set(userId, {
    expiresAt: Date.now() + SETTINGS_PROFILE_CACHE_MS,
    value,
  });
  return value;
}

export async function updateUserSettingsProfile(
  userId: number,
  patch: SettingsPatchInput,
  sessionId?: string
) {
  invalidateSettingsProfileCache(userId);

  const updateData: Record<string, unknown> = {};
  if (
    patch.preferences?.displayPnlInUsd !== undefined ||
    patch.preferences?.showDemoData !== undefined ||
    (patch.metadata && 'securityNoticeSeenAt' in patch.metadata)
  ) {
    await ensureUserSettings(userId);
    if (patch.preferences?.displayPnlInUsd !== undefined) {
      updateData.displayPnlInUsd = patch.preferences.displayPnlInUsd;
    }
    if (patch.preferences?.showDemoData !== undefined) {
      updateData.showDemoData = patch.preferences.showDemoData;
    }
    if (patch.metadata && 'securityNoticeSeenAt' in patch.metadata) {
      updateData.securityNoticeSeenAt = patch.metadata.securityNoticeSeenAt ?? null;
    }
    if (Object.keys(updateData).length > 0) {
      await (prisma as any).userSettings.update({
        where: { userId },
        data: updateData,
      });
    }
  }

  return getUserSettingsProfile(userId, sessionId);
}

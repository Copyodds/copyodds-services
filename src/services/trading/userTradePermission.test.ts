import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  USER_TRADE_ERROR,
  UserTradePermissionError,
  checkUserTradePermission,
} from './userTradePermission';

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    userRiskLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops)),
  },
}));

vi.mock('../../db', () => ({
  prisma: prismaMock,
}));

describe('checkUserTradePermission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows NORMAL user', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: 1,
      tradeStatus: 'NORMAL',
      tradingDisabled: false,
      tradingDisabledReason: null,
      tradingDisabledUntil: null,
      frozenUntil: null,
      frozenRemark: null,
      frozenReason: null,
      riskReviewReason: null,
    });
    await expect(checkUserTradePermission(1)).resolves.toBeUndefined();
  });

  it('blocks FROZEN user', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: 1,
      tradeStatus: 'FROZEN',
      tradingDisabled: true,
      tradingDisabledReason: 'test',
      tradingDisabledUntil: null,
      frozenUntil: null,
      frozenRemark: 'frozen remark',
      frozenReason: 'ABNORMAL_TRADING',
      riskReviewReason: null,
    });
    await expect(checkUserTradePermission(1)).rejects.toMatchObject({
      errorCode: USER_TRADE_ERROR.FROZEN,
      tradeStatus: 'FROZEN',
    });
  });

  it('blocks REVIEW user', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: 1,
      tradeStatus: 'REVIEW',
      tradingDisabled: false,
      tradingDisabledReason: null,
      tradingDisabledUntil: null,
      frozenUntil: null,
      frozenRemark: null,
      frozenReason: null,
      riskReviewReason: 'needs review',
    });
    await expect(checkUserTradePermission(1)).rejects.toBeInstanceOf(UserTradePermissionError);
    await expect(checkUserTradePermission(1)).rejects.toMatchObject({
      errorCode: USER_TRADE_ERROR.REVIEW,
    });
  });

  it('auto-restores expired timed freeze', async () => {
    const past = new Date(Date.now() - 60_000);
    prismaMock.user.findUnique.mockResolvedValue({
      id: 1,
      tradeStatus: 'FROZEN',
      tradingDisabled: true,
      tradingDisabledReason: null,
      tradingDisabledUntil: past,
      frozenUntil: past,
      frozenRemark: null,
      frozenReason: null,
      riskReviewReason: null,
    });
    prismaMock.user.update.mockResolvedValue({});
    prismaMock.userRiskLog.create.mockResolvedValue({});
    await expect(checkUserTradePermission(1)).resolves.toBeUndefined();
    expect(prismaMock.$transaction).toHaveBeenCalled();
  });
});

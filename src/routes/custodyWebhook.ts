import type { NextFunction, Request, Response } from 'express';
import { Code, fail } from '../utils/response';

/**
 * POST /api/webhooks/custody-ledger-topup
 * 服务端支付回调：该 legacy 入口已下线（历史“站内余额”已移除）。
 * Header: X-Custody-Payment-Secret: <secret>
 */
export async function postCustodyLedgerTopupWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    fail(res, Code.GONE, 'Legacy internal-balance webhook is disabled', 410);
  } catch (err) {
    next(err);
  }
}

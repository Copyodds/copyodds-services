import {
  isRobotControlNatsEnabled,
  publishRobotControlJson,
} from '../events/natsRobotControlClient';
import {
  assertCopyTradingDispatchPayloadSafe,
  buildCopyTradingDispatchPayload,
} from './copyTradingPayload';
import { copyTradingSubject } from './copyTradingSubjects';
import type { PublishCopyTradingDispatchInput } from './copyTradingTypes';

export type PublishCopyTradingDispatchResult = {
  published: boolean;
  subject?: string;
  skippedReason?: string;
};

function isNatsUrlConfiguredInEnv(): boolean {
  return (process.env.NATS_URL ?? '').trim().length > 0;
}

/**
 * LeaderTrade 落库后发布 copy.trading.{leaderAddress}。
 * 失败仅记日志；由 DB replay/sweep 兜底。
 */
export async function publishCopyTradingDispatch(
  input: PublishCopyTradingDispatchInput
): Promise<PublishCopyTradingDispatchResult> {
  if (!isNatsUrlConfiguredInEnv()) {
    console.warn('[copy-trading-dispatch] publish skipped (NATS_URL unset)', {
      leaderTradeId: input.leaderTradeId,
      reason: input.reason,
    });
    return { published: false, skippedReason: 'nats_url_unset' };
  }

  if (!isRobotControlNatsEnabled()) {
    console.warn('[copy-trading-dispatch] publish skipped (NATS client disabled)', {
      leaderTradeId: input.leaderTradeId,
    });
    return { published: false, skippedReason: 'nats_client_disabled' };
  }

  const payload = buildCopyTradingDispatchPayload(input);
  assertCopyTradingDispatchPayloadSafe(payload);
  const subject = copyTradingSubject(input.leaderAddress);

  try {
    await publishRobotControlJson(subject, payload);
    console.log('[copy-trading-dispatch] published', {
      subject,
      leaderTradeId: input.leaderTradeId,
      leaderAddress: payload.leaderAddress,
      reason: input.reason,
    });
    return { published: true, subject };
  } catch (error) {
    console.error('[copy-trading-dispatch] publish failed', {
      subject,
      leaderTradeId: input.leaderTradeId,
      leaderAddress: payload.leaderAddress,
      reason: input.reason,
      error: error instanceof Error ? error.message : String(error),
    });
    return { published: false, subject, skippedReason: 'publish_error' };
  }
}

/** @deprecated 使用 publishCopyTradingDispatch */
export const shadowPublishCopyTradingDispatch = publishCopyTradingDispatch;

import {
  isRobotControlNatsEnabled,
  publishRobotControlJson,
} from './natsRobotControlClient';
import { assertRobotControlPayloadSafe, buildRobotControlPayload } from './robotControlPayload';
import { robotControlSubjectForEvent } from './robotControlSubjects';
import type { PublishRobotControlInput } from './robotControlTypes';

export { assertRobotControlPayloadSafe, buildRobotControlPayload } from './robotControlPayload';

export type PublishRobotControlResult = { published: boolean };

/**
 * Publish robot runtime control event after DB mutation succeeded.
 * Publish failure is logged only; never throws to callers for rollback.
 */
export async function publishRobotControlEvent(
  input: PublishRobotControlInput
): Promise<PublishRobotControlResult> {
  if (!isRobotControlNatsEnabled()) {
    console.warn('[robot-control] publish skipped (NATS disabled)', {
      event: input.event,
      subscriptionId: input.subscriptionId,
    });
    return { published: false };
  }

  const payload = buildRobotControlPayload(input);
  assertRobotControlPayloadSafe(payload);

  const subject = robotControlSubjectForEvent(input.event, input.subscriptionId);

  try {
    await publishRobotControlJson(subject, payload);
    console.log('[robot-control] published', {
      subject,
      event: input.event,
      subscriptionId: input.subscriptionId,
      userId: input.userId,
    });
    return { published: true };
  } catch (error) {
    console.error('[robot-control] publish failed (DB not rolled back)', {
      subject,
      subscriptionId: input.subscriptionId,
      event: input.event,
      userId: input.userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { published: false };
  }
}

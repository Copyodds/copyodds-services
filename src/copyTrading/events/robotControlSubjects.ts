export const ROBOT_CONTROL_EVENT_TYPES = ['modify', 'pause', 'resume', 'reload'] as const;
export type RobotControlEventType = (typeof ROBOT_CONTROL_EVENT_TYPES)[number];

/** NATS subscribe pattern: `robot.{event}.{subscriptionId}` (one token per segment). */
export const ROBOT_CONTROL_WILDCARD = 'robot.*.*';

export function robotModifySubject(subscriptionId: string): string {
  return `robot.modify.${subscriptionId}`;
}

export function robotPauseSubject(subscriptionId: string): string {
  return `robot.pause.${subscriptionId}`;
}

export function robotResumeSubject(subscriptionId: string): string {
  return `robot.resume.${subscriptionId}`;
}

export function robotReloadSubject(subscriptionId: string): string {
  return `robot.reload.${subscriptionId}`;
}

export function robotControlSubjectForEvent(
  event: RobotControlEventType,
  subscriptionId: string
): string {
  switch (event) {
    case 'modify':
      return robotModifySubject(subscriptionId);
    case 'pause':
      return robotPauseSubject(subscriptionId);
    case 'resume':
      return robotResumeSubject(subscriptionId);
    case 'reload':
      return robotReloadSubject(subscriptionId);
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

export function parseRobotControlSubject(
  subject: string
): { event: RobotControlEventType; subscriptionId: string } | null {
  const match = /^robot\.(modify|pause|resume|reload)\.(.+)$/.exec(subject.trim());
  if (!match) {
    return null;
  }
  const event = match[1] as RobotControlEventType;
  const subscriptionId = match[2];
  if (!subscriptionId) {
    return null;
  }
  return { event, subscriptionId };
}

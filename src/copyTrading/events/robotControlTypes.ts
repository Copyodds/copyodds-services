import type { RobotControlEventType } from './robotControlSubjects';

export type RobotControlEventPayload = {
  subscriptionId: string;
  event: RobotControlEventType;
  userId: number;
  leaderId: string;
  leaderAddress: string;
  occurredAt: string;
};

export type PublishRobotControlInput = {
  subscriptionId: string;
  event: RobotControlEventType;
  userId: number;
  leaderId: string;
  leaderAddress: string;
  occurredAt?: string;
};

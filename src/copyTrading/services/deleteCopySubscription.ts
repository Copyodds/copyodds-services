import { prisma } from '../../db';
import { publishRobotControlEvent } from '../events/publishRobotControlEvent';

export async function deleteCopySubscriptionForUser(params: {
  userId: number;
  leaderAddress: string;
}): Promise<{ subscriptionId: string; leaderAddress: string } | null> {
  const leaderAddress = params.leaderAddress.toLowerCase();

  const subscription = await prisma.copySubscription.findFirst({
    where: {
      userId: params.userId,
      deletedAt: null,
      leader: { address: leaderAddress },
    },
    include: { leader: true },
  });

  if (!subscription) {
    return null;
  }

  const now = new Date();

  await prisma.$transaction([
    prisma.copySubscription.update({
      where: { id: subscription.id },
      data: {
        enabled: false,
        deletedAt: now,
        pausedUntil: null,
        pauseReason: null,
        failStreakCount: 0,
        failStreakUpdatedAt: null,
        fundingPausedAt: null,
        fundingPausedCode: null,
        fundingPausedReason: null,
        fundingWarningAt: null,
        fundingWarningCode: null,
        fundingWarningReason: null,
      },
    }),
    prisma.copyRelation.deleteMany({
      where: {
        followerUserId: params.userId,
        leaderAddress,
      },
    }),
  ]);

  await publishRobotControlEvent({
    subscriptionId: subscription.id,
    event: 'pause',
    userId: params.userId,
    leaderId: subscription.leaderId,
    leaderAddress: subscription.leader.address,
  });

  return {
    subscriptionId: subscription.id,
    leaderAddress: subscription.leader.address,
  };
}

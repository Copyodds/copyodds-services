import { prisma } from '../db';

function utcDayStart(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export async function recordUserDailyActivity(userId: number, at = new Date()): Promise<void> {
  const day = utcDayStart(at);
  await prisma.userDailyActivity.upsert({
    where: { userId_activityDate: { userId, activityDate: day } },
    create: {
      userId,
      activityDate: day,
      lastActiveAt: at,
      activityCount: 1,
    },
    update: {
      lastActiveAt: at,
      activityCount: { increment: 1 },
    },
  });
}


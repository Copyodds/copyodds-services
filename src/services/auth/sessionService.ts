import { prisma } from '../../db';

/** Revoke all JWT sessions for a user (e.g. security incident or account lock). */
export async function revokeAllUserSessions(userId: number): Promise<void> {
  await prisma.userSession.deleteMany({ where: { userId } });
}

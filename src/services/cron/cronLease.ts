import { prisma } from '../../db';

type LeaseRow = {
  key: string;
  owner: string;
  expiresAt: Date;
};

export async function acquireCronLease(key: string, owner: string, ttlMs: number): Promise<boolean> {
  const expiresAt = new Date(Date.now() + ttlMs);
  const rows = await prisma.$queryRaw<LeaseRow[]>`
    INSERT INTO "CronLease" ("key", "owner", "expiresAt", "createdAt", "updatedAt")
    VALUES (${key}, ${owner}, ${expiresAt}, NOW(), NOW())
    ON CONFLICT ("key") DO UPDATE
    SET
      "owner" = EXCLUDED."owner",
      "expiresAt" = EXCLUDED."expiresAt",
      "updatedAt" = NOW()
    WHERE "CronLease"."expiresAt" <= NOW()
       OR "CronLease"."owner" = EXCLUDED."owner"
    RETURNING "key", "owner", "expiresAt"
  `;

  return rows.length > 0 && rows[0].owner === owner;
}

export async function releaseCronLease(key: string, owner: string): Promise<void> {
  await prisma.cronLease.deleteMany({
    where: {
      key,
      owner,
    },
  });
}

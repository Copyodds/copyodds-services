import '../src/loadEnv';
import { prisma } from '../src/db';
import { getSmartMoneyPipelineStats } from '../src/services/smartMoney/smartMoneyPipelineCron';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

type Snapshot = {
  capturedAt: string;
  pipeline: Awaited<ReturnType<typeof getSmartMoneyPipelineStats>>;
  l1FailTop: Array<{ failHead: string; count: number }>;
};

function parseArgs(): { out?: string; baseline?: string } {
  const args = process.argv.slice(2);
  const outArg = args.find((arg) => arg.startsWith('--out='));
  const baseArg = args.find((arg) => arg.startsWith('--baseline='));
  return {
    out: outArg ? outArg.slice('--out='.length) : undefined,
    baseline: baseArg ? baseArg.slice('--baseline='.length) : undefined,
  };
}

function readSnapshot(filePath: string): Snapshot {
  return JSON.parse(readFileSync(filePath, 'utf8')) as Snapshot;
}

function deltaNumber(current: number, baseline: number): string {
  const diff = current - baseline;
  const sign = diff > 0 ? '+' : '';
  return `${current} (${sign}${diff})`;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const [pipeline, l1FailRows] = await Promise.all([
    getSmartMoneyPipelineStats(),
    prisma.$queryRaw<Array<{ fail_head: string; cnt: bigint }>>`
      SELECT split_part("tierFailReason", '|', 1) AS fail_head, COUNT(*)::bigint AS cnt
      FROM "SmartMoneyRawAddress"
      WHERE "updatedAt" >= NOW() - INTERVAL '24 hours'
        AND "tierFailReason" IS NOT NULL
      GROUP BY 1
      ORDER BY cnt DESC
      LIMIT 10
    `,
  ]);

  const snapshot: Snapshot = {
    capturedAt: new Date().toISOString(),
    pipeline,
    l1FailTop: l1FailRows.map((row) => ({ failHead: row.fail_head, count: Number(row.cnt) })),
  };

  if (args.out) {
    const outputPath = resolve(process.cwd(), args.out);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, JSON.stringify(snapshot, null, 2), 'utf8');
    console.log('[smart-money-rollout] snapshot saved', { outputPath });
  }

  console.log('\n=== SmartMoney Rollout Snapshot ===');
  console.log(`capturedAt: ${snapshot.capturedAt}`);
  console.log(`qualifiedReadyRatio: ${snapshot.pipeline.qualifiedReadyRatio.toFixed(4)}`);
  console.log(`inCopyPoolNotRanked: ${snapshot.pipeline.inCopyPoolNotRankedCount}`);
  console.log(`copyPoolEntered24h: ${snapshot.pipeline.copyPoolEntered24h}`);
  console.log(`copyPoolExited24h: ${snapshot.pipeline.copyPoolExited24h}`);
  console.log(`rankFlushLagSec: ${snapshot.pipeline.rankFlushLagSec}`);
  console.log('topL1FailReasons:', snapshot.l1FailTop);

  if (args.baseline) {
    const baseline = readSnapshot(resolve(process.cwd(), args.baseline));
    console.log('\n=== Delta vs Baseline ===');
    console.log(`qualifiedReadyRatio: ${snapshot.pipeline.qualifiedReadyRatio.toFixed(4)} (${(snapshot.pipeline.qualifiedReadyRatio - baseline.pipeline.qualifiedReadyRatio).toFixed(4)})`);
    console.log(
      `inCopyPoolNotRanked: ${deltaNumber(
        snapshot.pipeline.inCopyPoolNotRankedCount,
        baseline.pipeline.inCopyPoolNotRankedCount
      )}`
    );
    console.log(
      `copyPoolEntered24h: ${deltaNumber(
        snapshot.pipeline.copyPoolEntered24h,
        baseline.pipeline.copyPoolEntered24h
      )}`
    );
    console.log(
      `copyPoolExited24h: ${deltaNumber(
        snapshot.pipeline.copyPoolExited24h,
        baseline.pipeline.copyPoolExited24h
      )}`
    );
  }

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error('[smart-money-rollout] failed', error);
  await prisma.$disconnect();
  process.exit(1);
});

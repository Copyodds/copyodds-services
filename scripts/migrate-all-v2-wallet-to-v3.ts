/**
 * 批量将 v2_hd 托管钱包迁移到 v3_refer_pass。
 *
 * 演练：  npm run migrate:all-v2-wallet-v3:dev
 * 执行：  npm run migrate:all-v2-wallet-v3:dev -- --execute
 * 跳过有余额用户：加 --skip-if-balance
 * 限制数量：    --limit=10
 * 指定用户：    --user-ids=2,3,5
 *
 * Production:
 *   npm run migrate:all-v2-wallet-v3 -- --execute
 */
import '../src/loadEnv';
import { prisma } from '../src/db';
import { isGoWalletCustodyConfigured } from '../src/services/walletApi/goWalletClient';
import {
  listV2HdCustodialUserIds,
  migrateV2WalletToV3ForUser,
  type MigrateV2WalletToV3Result,
} from '../src/services/custody/migrateV2WalletToV3';

function parseArgs(): {
  execute: boolean;
  skipIfBalance: boolean;
  limit: number | null;
  userIds: number[] | null;
  gapMs: number;
} {
  const args = process.argv.slice(2);
  let execute = false;
  let skipIfBalance = false;
  let limit: number | null = null;
  let userIds: number[] | null = null;
  let gapMs = 200;

  for (const arg of args) {
    if (arg === '--execute' || arg === '--execute=true') {
      execute = true;
      continue;
    }
    if (arg === '--skip-if-balance') {
      skipIfBalance = true;
      continue;
    }
    if (arg.startsWith('--limit=')) {
      const parsed = Number(arg.slice('--limit='.length));
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error(`Invalid --limit=${arg.slice('--limit='.length)}`);
      }
      limit = Math.floor(parsed);
      continue;
    }
    if (arg.startsWith('--user-ids=')) {
      const raw = arg.slice('--user-ids='.length);
      const parsed = raw
        .split(',')
        .map((part) => Number(part.trim()))
        .filter((id) => Number.isFinite(id) && id > 0);
      if (parsed.length === 0) {
        throw new Error(`Invalid --user-ids=${raw}`);
      }
      userIds = parsed;
      continue;
    }
    if (arg.startsWith('--gap-ms=')) {
      const parsed = Number(arg.slice('--gap-ms='.length));
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`Invalid --gap-ms=${arg.slice('--gap-ms='.length)}`);
      }
      gapMs = Math.floor(parsed);
    }
  }

  if (process.env.MIGRATE_EXECUTE === '1' || process.env.MIGRATE_EXECUTE === 'true') {
    execute = true;
  }

  return { execute, skipIfBalance, limit, userIds, gapMs };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarize(results: MigrateV2WalletToV3Result[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const result of results) {
    counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
  }
  return counts;
}

async function main(): Promise<void> {
  if (!isGoWalletCustodyConfigured()) {
    throw new Error(
      'Go wallet env not fully configured (GO_WALLET_SERVICE_URL, GO_WALLET_APP_KEY, GO_WALLET_APP_TOKEN)'
    );
  }

  const { execute, skipIfBalance, limit, userIds, gapMs } = parseArgs();
  let targets = userIds ?? (await listV2HdCustodialUserIds());
  if (limit != null) {
    targets = targets.slice(0, limit);
  }

  console.log('[migrate-all-v2-v3] plan', {
    execute,
    skipIfBalance,
    targetCount: targets.length,
    gapMs,
  });

  if (targets.length === 0) {
    console.log('[migrate-all-v2-v3] no v2_hd custodial wallets found');
    return;
  }

  const results: MigrateV2WalletToV3Result[] = [];
  for (const [index, userId] of targets.entries()) {
    const result = await migrateV2WalletToV3ForUser({
      userId,
      execute,
      skipIfBalance,
    });
    results.push(result);

    if (result.outcome === 'dry_run' || result.outcome === 'applied') {
      console.log('[migrate-all-v2-v3] user', {
        index: index + 1,
        total: targets.length,
        ...result,
      });
      if (result.addressChanged) {
        console.warn(
          `[migrate-all-v2-v3] userId=${userId} address changed — user must fund NEW deposit after re-open/authorize`
        );
      }
    } else if (result.outcome === 'failed') {
      console.error('[migrate-all-v2-v3] user failed', result);
    } else {
      console.log('[migrate-all-v2-v3] user skipped', result);
    }

    if (gapMs > 0 && index + 1 < targets.length) {
      await sleep(gapMs);
    }
  }

  console.log('[migrate-all-v2-v3] summary', summarize(results));
  if (!execute) {
    console.log('[migrate-all-v2-v3] dry run only. Re-run with --execute or MIGRATE_EXECUTE=1 to apply.');
  }
}

main()
  .catch((error) => {
    console.error('[migrate-all-v2-v3] fatal', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });

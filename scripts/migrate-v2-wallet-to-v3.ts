/**
 * v2_hd → v3_refer_pass：用用户 inviteCode + encryptedWalletPassword 在 Go 重新 createWallet，
 * 更新 Wallet 地址/派生方案，清空 Polymarket 凭证以便重新授权。
 *
 * 适用：Go wallet-api 已升到 v3，存量 v2_hd 用户跟单/下单报 refer_code required。
 * 建议先提现/清空旧 deposit 与 custodial 余额后再执行（地址通常会变）。
 *
 * 演练：  MIGRATE_USER_ID=3 npx tsx scripts/migrate-v2-wallet-to-v3.ts
 * 执行：  MIGRATE_USER_ID=3 MIGRATE_EXECUTE=1 npx tsx scripts/migrate-v2-wallet-to-v3.ts
 * 批量：  npm run migrate:all-v2-wallet-v3:dev -- --execute
 * 强制：  MIGRATE_FORCE=1（derivationScheme 不是 v2_hd 时也允许）
 */
import '../src/loadEnv';
import { prisma } from '../src/db';
import { isGoWalletCustodyConfigured } from '../src/services/walletApi/goWalletClient';
import { migrateV2WalletToV3ForUser } from '../src/services/custody/migrateV2WalletToV3';

async function main() {
  const userId = Number(process.env.MIGRATE_USER_ID ?? '');
  if (!Number.isFinite(userId) || userId <= 0) {
    throw new Error('Set MIGRATE_USER_ID to a positive integer');
  }
  if (!isGoWalletCustodyConfigured()) {
    throw new Error(
      'Go wallet env not fully configured (GO_WALLET_SERVICE_URL, GO_WALLET_APP_KEY, GO_WALLET_APP_TOKEN)'
    );
  }

  const execute = process.env.MIGRATE_EXECUTE === '1' || process.env.MIGRATE_EXECUTE === 'true';
  const force = process.env.MIGRATE_FORCE === '1' || process.env.MIGRATE_FORCE === 'true';
  const skipIfBalance =
    process.env.MIGRATE_SKIP_IF_BALANCE === '1' || process.env.MIGRATE_SKIP_IF_BALANCE === 'true';

  const result = await migrateV2WalletToV3ForUser({
    userId,
    execute,
    force,
    skipIfBalance,
  });

  console.log(result);

  if (result.outcome === 'dry_run') {
    console.log('Dry run only. Set MIGRATE_EXECUTE=1 to apply DB updates + delete ApiCredential.');
    return;
  }
  if (result.outcome === 'applied') {
    console.log('Migration applied.');
    console.log('Next steps for user:');
    console.log('  1. POST /api/custody/open (or login to trigger open flow)');
    console.log('  2. POST /api/custody/authorize-polymarket if needed');
    console.log('  3. Fund the new Polymarket deposit address');
    console.log('  4. Reset copy subscription fail_streak if paused');
    return;
  }
  if (result.outcome === 'failed') {
    throw new Error(result.error ?? 'migration failed');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });

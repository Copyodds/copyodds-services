const fs = require('node:fs/promises');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const deployDir = path.join(rootDir, 'deploy');

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function copyIfExists(from, to) {
  try {
    await fs.access(from);
  } catch {
    return false;
  }

  await ensureDir(path.dirname(to));
  await fs.copyFile(from, to);
  return true;
}

async function main() {
  const packageJsonPath = path.join(rootDir, 'package.json');
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));

  const deployPackageJson = {
    name: packageJson.name,
    version: packageJson.version,
    private: true,
    type: packageJson.type,
    main: 'dist/src/server.js',
    scripts: {
      start: 'node dist/src/server.js',
      /** 与 PM2 / 运维里 `npm run start:copy-worker` 对齐；需单独起进程 */
      'start:copy-worker': 'node dist/src/entry/copyWorker.js',
      /** 聪明钱管道独立 worker；API 侧 SMART_MONEY_CRONS_IN_API=false 时必起 */
      'start:smart-money-worker': 'node --env-file=.env dist/src/entry/smartMoneyWorker.js',
      'migrate:deploy': 'prisma migrate deploy',
      /** 创建/更新管理后台账号并输出 Authenticator 密钥；需 .env 中 DATABASE_URL、TOTP_SECRET_ENCRYPTION_KEY */
      'seed:admin': 'node --env-file=.env dist/scripts/seedAdmin.js',
      /** 运维：核对赎回 tx 链上入账；用法 npm run verify:user-redeem -- <userId> */
      'verify:user-redeem': 'node dist/scripts/verify-user-redeem-proceeds.js',
      /** 运维：把 manual_expired 账本修正为 auto_redeem；用法 npm run reconcile:user-redeem -- <userId> */
      'reconcile:user-redeem': 'node dist/scripts/reconcile-user-redeem-ledger.js',
      /** 运维：重算跟单结算盈亏并重建累计收益；用法 npm run repair:copy-settlement-pnl -- <userId> [--dry-run] */
      'repair:copy-settlement-pnl': 'node --env-file=.env dist/scripts/repair-copy-settlement-pnl.js',
      /** 运维：从 lot_close 重建 UserSettings 盈亏缓存；用法 BACKFILL_USER_IDS=3 npm run backfill:copy-pnl-ledger */
      'backfill:copy-pnl-ledger': 'node --env-file=.env dist/scripts/backfill-copy-pnl-ledger.js',
      /** 运维：重爬+重评 Top2000 榜单池；`npm run rescore:smart-money:top`；仅本地重算加 `:fast` */
      'rescore:smart-money': 'node --env-file=.env dist/scripts/rescore-smart-money.js',
      'rescore:smart-money:fast':
        'node --env-file=.env dist/scripts/rescore-smart-money.js --fast --scope=display',
      'rescore:smart-money:top': 'node --env-file=.env dist/scripts/rescore-smart-money.js --scope=top',
      'rescore:smart-money:strict':
        'node --env-file=.env dist/scripts/rescore-smart-money.js --scope=top --strict --concurrency=3',
      'rescore:smart-money:top:fast':
        'node --env-file=.env dist/scripts/rescore-smart-money.js --fast --scope=top',
      /** 运维：批量恢复聪明钱入榜并重算排名（v2.3 误踢后）；用法 npm run restore:smart-money */
      'restore:smart-money': 'node --env-file=.env dist/scripts/restore-smart-money-leaderboard.js',
      'recompute:smart-money': 'node --env-file=.env dist/scripts/recompute-smart-money-ranks.js',
      /** 运维：聪明钱榜漏斗诊断（UI total 偏少时）；用法 npm run diagnose:smart-money */
      'diagnose:smart-money': 'node --env-file=.env dist/scripts/diagnose-smart-money.js',
      'reset:smart-money-pipeline':
        'CONFIRM_RESET=YES node --env-file=.env dist/scripts/reset-smart-money-leaderboard-pipeline.js',
      'backfill:smart-money-copyability': 'node --env-file=.env dist/scripts/backfill-smart-money-copyability.js',
      'backfill:smart-money-rank': 'node --env-file=.env dist/scripts/backfill-smart-money-rank.js',
      'backfill:smart-money-trader-columns':
        'node --env-file=.env dist/scripts/backfill-smart-money-trader-columns.js',
      /** 运维：重放 LeaderTrade 派发；可加 -- --unprocessed-only */
      'replay:leader-trades': 'node --env-file=.env dist/src/scripts/replayLeaderTrades.js',
      /** 运维：删除未发 CLOB 的资金/Gas 不足 skipped 跟单行；可加 -- --dry-run --user-id=1 */
      'cleanup:funding-skipped-copy-trades':
        'node --env-file=.env dist/scripts/cleanup-funding-skipped-copy-trades.js',
      /** 运维：撤销误触发的 manual_expired（链上仍有价值时）；用法 npm run revert:false-manual-expired -- <userId> <tokenPrefix> */
      'revert:false-manual-expired':
        'node --env-file=.env dist/scripts/revert-false-manual-expired.js',
      /** 运维：批量撤销误触发 manual_expired；用法 npm run revert:false-manual-expired:all -- <userId> [--dry-run] */
      'revert:false-manual-expired:all':
        'node --env-file=.env dist/scripts/revert-all-false-manual-expired.js',
      /** 运维：Polymarket deposit WALLET-CREATE / wrap 分步诊断；用法 npm run diagnose:deposit-relayer -- 9 --wallet-create-only */
      'diagnose:deposit-relayer':
        'node --env-file=.env dist/scripts/diagnose-deposit-relayer-register.js',
      /** 运维：查询 Builder tier / 日配额 / 用量；用法 npm run check:builder-profile */
      'check:builder-profile': 'node --env-file=.env dist/scripts/check-builder-profile.js',
      /** 运维：纠正误写 Beacon 的 polymarketFunderAddress；用法 npm run backfill:polymarket-funder-repair -- 17 */
      'backfill:polymarket-funder-repair':
        'node --env-file=.env dist/scripts/backfill-polymarket-deposit-funder-repair.js',
      /** 运维：v2_hd → v3_refer_pass 钱包迁移；用法 MIGRATE_USER_ID=3 npm run migrate:v2-wallet-v3 */
      'migrate:v2-wallet-v3': 'node --env-file=.env dist/scripts/migrate-v2-wallet-to-v3.js',
      /** 运维：批量 v2_hd → v3；用法 npm run migrate:all-v2-wallet-v3 -- --execute */
      'migrate:all-v2-wallet-v3': 'node --env-file=.env dist/scripts/migrate-all-v2-wallet-to-v3.js',
      /** 回填 Node WalletDerivationCredential；默认演练，MIGRATE_EXECUTE=1 写库 */
      'migrate:wallet-derivation-credentials':
        'node --env-file=.env dist/scripts/migrate-wallet-derivation-credentials.js',
    },
    dependencies: {
      ...packageJson.dependencies,
    },
  };

  await fs.rm(deployDir, { recursive: true, force: true });
  await ensureDir(deployDir);

  await fs.cp(path.join(rootDir, 'dist'), path.join(deployDir, 'dist'), { recursive: true });

  const requiredOpsScripts = [
    'dist/scripts/verify-user-redeem-proceeds.js',
    'dist/scripts/reconcile-user-redeem-ledger.js',
    'dist/scripts/repair-copy-settlement-pnl.js',
    'dist/scripts/backfill-copy-pnl-ledger.js',
    'dist/scripts/rescore-smart-money.js',
    'dist/scripts/restore-smart-money-leaderboard.js',
    'dist/scripts/recompute-smart-money-ranks.js',
    'dist/scripts/diagnose-smart-money.js',
    'dist/scripts/reset-smart-money-leaderboard-pipeline.js',
    'dist/scripts/backfill-smart-money-copyability.js',
    'dist/scripts/backfill-smart-money-rank.js',
    'dist/scripts/backfill-smart-money-trader-columns.js',
    'dist/scripts/seedAdmin.js',
    'dist/scripts/cleanup-funding-skipped-copy-trades.js',
    'dist/scripts/revert-false-manual-expired.js',
    'dist/scripts/revert-all-false-manual-expired.js',
    'dist/scripts/reconcile-user-copy-vs-chain.js',
    'dist/scripts/diagnose-deposit-relayer-register.js',
    'dist/scripts/check-builder-profile.js',
    'dist/scripts/backfill-polymarket-deposit-funder-repair.js',
    'dist/scripts/migrate-v2-wallet-to-v3.js',
    'dist/scripts/migrate-all-v2-wallet-to-v3.js',
    'dist/scripts/migrate-wallet-derivation-credentials.js',
    'dist/src/scripts/replayLeaderTrades.js',
  ];
  for (const relPath of requiredOpsScripts) {
    try {
      await fs.access(path.join(deployDir, relPath));
    } catch {
      throw new Error(`Deploy bundle missing required ops script: ${relPath} (run npm run build first)`);
    }
  }
  await fs.cp(path.join(rootDir, 'prisma'), path.join(deployDir, 'prisma'), { recursive: true });
  await fs.cp(
    path.join(rootDir, 'observability'),
    path.join(deployDir, 'observability'),
    { recursive: true },
  );
  await copyIfExists(path.join(rootDir, 'prisma.config.ts'), path.join(deployDir, 'prisma.config.ts'));
  await copyIfExists(path.join(rootDir, '.env.example'), path.join(deployDir, '.env.example'));
  await copyIfExists(path.join(rootDir, '.npmrc'), path.join(deployDir, '.npmrc'));
  await copyIfExists(path.join(rootDir, 'package-lock.json'), path.join(deployDir, 'package-lock.json'));
  await ensureDir(path.join(deployDir, 'scripts'));
  await copyIfExists(
    path.join(rootDir, 'scripts/patch-smart-money-s15-env.sh'),
    path.join(deployDir, 'scripts/patch-smart-money-s15-env.sh')
  );
  await copyIfExists(
    path.join(rootDir, 'scripts/patch-smart-money-phase-h-bootstrap-env.sh'),
    path.join(deployDir, 'scripts/patch-smart-money-phase-h-bootstrap-env.sh')
  );
  await copyIfExists(
    path.join(rootDir, 'scripts/patch-smart-money-phase-h-steady-env.sh'),
    path.join(deployDir, 'scripts/patch-smart-money-phase-h-steady-env.sh')
  );
  await copyIfExists(
    path.join(rootDir, 'scripts/patch-smart-money-p0-env.sh'),
    path.join(deployDir, 'scripts/patch-smart-money-p0-env.sh')
  );
  await copyIfExists(
    path.join(rootDir, 'scripts/patch-smart-money-l1-usd-dd-env.sh'),
    path.join(deployDir, 'scripts/patch-smart-money-l1-usd-dd-env.sh')
  );
  await copyIfExists(
    path.join(rootDir, 'scripts/patch-smart-money-dual-channel-env.sh'),
    path.join(deployDir, 'scripts/patch-smart-money-dual-channel-env.sh')
  );
  await copyIfExists(
    path.join(rootDir, 'scripts/patch-smart-money-light-fast-env.sh'),
    path.join(deployDir, 'scripts/patch-smart-money-light-fast-env.sh')
  );
  await copyIfExists(
    path.join(rootDir, 'scripts/apply-dual-channel-test-release.sh'),
    path.join(deployDir, 'scripts/apply-dual-channel-test-release.sh')
  );
  await copyIfExists(
    path.join(rootDir, 'scripts/apply-light-fast-test-release.sh'),
    path.join(deployDir, 'scripts/apply-light-fast-test-release.sh')
  );
  // Windows 打包常见 CRLF，POSIX sh 会报 set: Illegal option -
  for (const shName of [
    'patch-smart-money-dual-channel-env.sh',
    'patch-smart-money-light-fast-env.sh',
    'apply-dual-channel-test-release.sh',
    'apply-light-fast-test-release.sh',
    'patch-smart-money-s15-env.sh',
    'patch-smart-money-phase-h-bootstrap-env.sh',
    'patch-smart-money-phase-h-steady-env.sh',
    'patch-smart-money-p0-env.sh',
    'patch-smart-money-l1-usd-dd-env.sh',
    'verify-l1-usd-dd.sh',
  ]) {
    const p = path.join(deployDir, 'scripts', shName);
    try {
      const raw = await fs.readFile(p);
      const text = raw.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      await fs.writeFile(p, text, 'utf8');
    } catch {
      // optional
    }
  }
  await copyIfExists(
    path.join(rootDir, 'scripts/diagnose-top100-rescore.sql'),
    path.join(deployDir, 'scripts/diagnose-top100-rescore.sql')
  );
  await copyIfExists(
    path.join(rootDir, 'aidocs-release-dual-channel-test.md'),
    path.join(deployDir, 'RELEASE-dual-channel-test.md')
  );
  await copyIfExists(
    path.join(rootDir, 'scripts/verify-l1-usd-dd.sh'),
    path.join(deployDir, 'scripts/verify-l1-usd-dd.sh')
  );

  const systemdSrc = path.join(rootDir, 'deploy', 'systemd');
  try {
    await fs.access(systemdSrc);
    await fs.cp(systemdSrc, path.join(deployDir, 'systemd'), { recursive: true });
  } catch {
    // optional
  }

  await fs.writeFile(
    path.join(deployDir, 'package.json'),
    `${JSON.stringify(deployPackageJson, null, 2)}\n`,
    'utf8',
  );

  await fs.writeFile(
    path.join(deployDir, 'README.md'),
    [
      '# 后端发布目录',
      '',
      '这个目录由 `npm run build:deploy` 自动生成。',
      '',
      '## 部署步骤',
      '',
      '1. 把整个 `deploy/` 目录上传到服务器。',
      '2. 将 `.env.example` 复制为 `.env` 并填写生产环境变量，或者由托管平台注入环境变量。',
      '3. 执行 `npm install --omit=dev`。',
      '4. 如需数据库迁移，直接运行 `npm run migrate:deploy`（本目录已包含 `prisma.config.ts` 和 `prisma/migrations/`）。',
      '5. 创建管理后台账号：`ADMIN_SEED_EMAIL=... ADMIN_SEED_PASSWORD=... npm run seed:admin`（输出 Authenticator 手动密钥）。',
      '6. 使用 `npm start` 启动 API 服务；生产推荐 systemd（见 `systemd/README.md`），Go wallet 密钥用 LoadCredential，勿写入 `.env`。',
      '7. 跟单派发需另起进程：`npm run start:copy-worker`（例如 PM2 单独一条）。',
      '8. 赎回排查：`npm run verify:user-redeem -- <userId>`；账本修正：`npm run reconcile:user-redeem -- <userId>`（需 `.env` 或 `--env-file`）。',
      '9. 跟单盈亏修复：`npm run repair:copy-settlement-pnl -- <userId>`；预览加 `--dry-run`。',
      '10. 跟单重放：`npm run replay:leader-trades`。',
      '11. 清理未发单的资金不足 skipped 行：`npm run cleanup:funding-skipped-copy-trades -- --dry-run`（确认后去掉 `--dry-run`）。',
      '12. 撤销误触发归零：`npm run revert:false-manual-expired -- <userId> <tokenPrefix>`（链上仍有价值时）。',
      '13. 聪明钱漏斗诊断：`npm run diagnose:smart-money`（定位 cached total 偏少）。',
      '14. 聪明钱严格清榜：`npm run rescore:smart-money:strict`（重爬 Top2000，不达标下榜）；普通重爬 `npm run rescore:smart-money:top`。',
      '15. 聪明钱批量恢复入榜：`npm run restore:smart-money`（v2.3 误踢后；预览 `node --env-file=.env dist/scripts/restore-smart-money-leaderboard.js` 前可先 `diagnose:smart-money`）。',
      '16. v2 钱包迁 v3（单用户）：`MIGRATE_USER_ID=3 npm run migrate:v2-wallet-v3`（演练）；加 `MIGRATE_EXECUTE=1` 写库。',
      '17. v2 钱包批量迁 v3：`npm run migrate:all-v2-wallet-v3 -- --execute`（先不加 --execute 预览；可加 `--skip-if-balance`）。',
      '18. 回填派生凭据：`npm run migrate:wallet-derivation-credentials` 演练；确认后加 `MIGRATE_EXECUTE=1`，默认事务内清空旧钱包密码。',
      '',
    ].join('\n'),
    'utf8',
  );

  console.log(`Deploy bundle ready: ${deployDir}`);
}

main().catch((error) => {
  console.error('Failed to build deploy bundle.');
  console.error(error);
  process.exit(1);
});

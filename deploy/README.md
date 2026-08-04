# 后端发布目录

这个目录由 `npm run build:deploy` 自动生成。

## 部署步骤

1. 把整个 `deploy/` 目录上传到服务器。
2. 将 `.env.example` 复制为 `.env` 并填写生产环境变量，或者由托管平台注入环境变量。
3. 执行 `npm install --omit=dev`。
4. 如需数据库迁移，直接运行 `npm run migrate:deploy`（本目录已包含 `prisma.config.ts` 和 `prisma/migrations/`）。
5. 创建管理后台账号：`ADMIN_SEED_EMAIL=... ADMIN_SEED_PASSWORD=... npm run seed:admin`（输出 Authenticator 手动密钥）。
6. 使用 `npm start` 启动 API 服务；生产推荐 systemd（见 `systemd/README.md`），Go wallet 密钥用 LoadCredential，勿写入 `.env`。
7. 跟单派发需另起进程：`npm run start:copy-worker`（例如 PM2 单独一条）。
8. 赎回排查：`npm run verify:user-redeem -- <userId>`；账本修正：`npm run reconcile:user-redeem -- <userId>`（需 `.env` 或 `--env-file`）。
9. 跟单盈亏修复：`npm run repair:copy-settlement-pnl -- <userId>`；预览加 `--dry-run`。
10. 跟单重放：`npm run replay:leader-trades`。
11. 清理未发单的资金不足 skipped 行：`npm run cleanup:funding-skipped-copy-trades -- --dry-run`（确认后去掉 `--dry-run`）。
12. 撤销误触发归零：`npm run revert:false-manual-expired -- <userId> <tokenPrefix>`（链上仍有价值时）。
13. 聪明钱漏斗诊断：`npm run diagnose:smart-money`（定位 cached total 偏少）。
14. 聪明钱严格清榜：`npm run rescore:smart-money:strict`（重爬 Top2000，不达标下榜）；普通重爬 `npm run rescore:smart-money:top`。
15. 聪明钱批量恢复入榜：`npm run restore:smart-money`（v2.3 误踢后；预览 `node --env-file=.env dist/scripts/restore-smart-money-leaderboard.js` 前可先 `diagnose:smart-money`）。
16. v2 钱包迁 v3（单用户）：`MIGRATE_USER_ID=3 npm run migrate:v2-wallet-v3`（演练）；加 `MIGRATE_EXECUTE=1` 写库。
17. v2 钱包批量迁 v3：`npm run migrate:all-v2-wallet-v3 -- --execute`（先不加 --execute 预览；可加 `--skip-if-balance`）。
18. 回填派生凭据：`npm run migrate:wallet-derivation-credentials` 演练；确认后加 `MIGRATE_EXECUTE=1`，默认事务内清空旧钱包密码。

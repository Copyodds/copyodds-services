import { Router } from 'express';
import { prisma } from '../db';
import { adminAuth } from '../middlewares/adminAuth';
import { buildAdminDashboardPayload } from '../services/adminDashboard/adminDashboardService';
import { success } from '../utils/response';

const router = Router();

router.use(adminAuth);

router.get('/dashboard', async (_req, res, next) => {
  try {
    const data = await buildAdminDashboardPayload();
    success(res, data);
  } catch (err) {
    next(err);
  }
});

router.get('/dashboard/overview', async (_req, res, next) => {
  try {
    const data = await buildAdminDashboardPayload();
    success(res, data.overview);
  } catch (err) {
    next(err);
  }
});

router.get('/dashboard/system-status', async (_req, res, next) => {
  try {
    const data = await buildAdminDashboardPayload();
    success(res, { system: data.system, sync: data.sync });
  } catch (err) {
    next(err);
  }
});

router.get('/dashboard/alerts', async (_req, res, next) => {
  try {
    const data = await buildAdminDashboardPayload();
    success(res, data.alerts);
  } catch (err) {
    next(err);
  }
});

router.get('/dashboard/activities', async (_req, res, next) => {
  try {
    const data = await buildAdminDashboardPayload();
    success(res, { items: data.activities });
  } catch (err) {
    next(err);
  }
});

router.get('/dashboard/top-leaders', async (_req, res, next) => {
  try {
    const data = await buildAdminDashboardPayload();
    success(res, { items: data.topLeaders });
  } catch (err) {
    next(err);
  }
});

router.get('/dashboard/daily-stats', async (_req, res, next) => {
  try {
    const rows = await prisma.adminDailyStat.findMany({
      orderBy: { statDate: 'desc' },
      take: 30,
    });
    success(res, {
      items: rows.map((r: (typeof rows)[number]) => ({
        statDate: r.statDate.toISOString().slice(0, 10),
        registeredUsers: r.registeredUsers,
        walletBoundUsers: r.walletBoundUsers,
        activeCopyTraders: r.activeCopyTraders,
        copySuccessCount: r.copySuccessCount,
        copyFailedCount: r.copyFailedCount,
        riskBlockCount: r.riskBlockCount,
        gasOrderCount: r.gasOrderCount,
        observedTradersTotal: r.observedTradersTotal,
        uptimePercent: Number(r.uptimePercent),
        commissionUsdt: r.commissionUsdt.toString(),
      })),
    });
  } catch (err) {
    next(err);
  }
});

export const adminDashboardRouter = router;

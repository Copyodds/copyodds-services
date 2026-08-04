import { NextFunction, Router } from 'express';
import { success } from '../../utils/response';
import { getSmartMoneyPipelineStats } from '../../services/smartMoney/smartMoneyPipelineCron';

export const internalSmartMoneyPipelineStatsRouter = Router();

internalSmartMoneyPipelineStatsRouter.get('/pipeline/stats', async (_req, res, next: NextFunction) => {
  try {
    const stats = await getSmartMoneyPipelineStats();
    success(res, stats);
  } catch (error) {
    next(error);
  }
});

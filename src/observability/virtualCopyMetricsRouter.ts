import { Router, type RequestHandler } from 'express';
import { collectVirtualCopyHealth } from './virtualCopyHealth';
import { virtualCopyMetricsRegistry } from './virtualCopyMetrics';

export const virtualCopyMetricsHandler: RequestHandler = async (_req, res, next) => {
  try {
    await collectVirtualCopyHealth();
    res.setHeader('Content-Type', virtualCopyMetricsRegistry.contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(await virtualCopyMetricsRegistry.metrics());
  } catch (error) {
    next(error);
  }
};

export const virtualCopyHealthHandler: RequestHandler = async (_req, res, next) => {
  try {
    const summary = await collectVirtualCopyHealth();
    res.setHeader('Cache-Control', 'no-store');
    res.status(summary.status === 'unhealthy' ? 503 : 200).json(summary);
  } catch (error) {
    next(error);
  }
};

/**
 * Deliberately not mounted here. The parent application can register this router
 * behind its preferred internal authentication and network policy.
 */
export const virtualCopyObservabilityRouter = Router();
virtualCopyObservabilityRouter.get('/metrics', virtualCopyMetricsHandler);
virtualCopyObservabilityRouter.get('/health', virtualCopyHealthHandler);

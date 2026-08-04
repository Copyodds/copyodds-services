import { Router } from 'express';
import { z } from 'zod';
import { jwtAuth } from '../middlewares/jwtAuth';
import { Code, fail, success } from '../utils/response';
import { isAppError } from '../utils/appError';
import { logApiRouteMetrics, startApiRouteMetrics } from '../utils/apiRouteMetrics';
import {
  getUserSettingsProfile,
  updateUserSettingsProfile,
} from '../services/settings';

const router = Router();

const preferencesPatchSchema = z
  .object({
    displayPnlInUsd: z.boolean().optional(),
    showDemoData: z.boolean().optional(),
  })
  .partial()
  .optional();

const patchBodySchema = z.object({
  preferences: preferencesPatchSchema,
  metadata: z
    .object({
      securityNoticeSeenAt: z
        .union([z.string().datetime(), z.null()])
        .optional(),
    })
    .partial()
    .optional(),
});

router.get('/me', jwtAuth, async (req, res, next) => {
  const metrics = startApiRouteMetrics();
  const userId = Number(req.user?.userId);
  try {
    if (!Number.isInteger(userId) || userId <= 0) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }

    const data = await getUserSettingsProfile(userId, req.sessionId);
    logApiRouteMetrics('/api/settings/me', userId, metrics.startedAt, metrics.heapAtStart);
    success(res, data);
  } catch (err) {
    logApiRouteMetrics('/api/settings/me', userId, metrics.startedAt, metrics.heapAtStart, {
      error: err instanceof Error ? err.message : String(err),
    });
    next(err);
  }
});

router.patch('/me', jwtAuth, async (req, res, next) => {
  try {
    const userId = Number(req.user?.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      fail(res, Code.UNAUTHORIZED, 'Unauthorized', 401);
      return;
    }

    const parsed = patchBodySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, Code.VALIDATION_FAILED, 'Validation failed', 400, {
        details: parsed.error.flatten(),
      });
      return;
    }

    const data = await updateUserSettingsProfile(
      userId,
      {
        preferences: parsed.data.preferences,
        metadata: parsed.data.metadata
          ? {
              securityNoticeSeenAt:
                parsed.data.metadata.securityNoticeSeenAt === undefined
                  ? undefined
                  : parsed.data.metadata.securityNoticeSeenAt === null
                    ? null
                    : new Date(parsed.data.metadata.securityNoticeSeenAt),
            }
          : undefined,
      },
      req.sessionId,
    );

    success(res, data);
  } catch (err) {
    if (isAppError(err)) {
      fail(res, err.code, err.message, err.httpStatus, err.details as Record<string, unknown>);
      return;
    }
    next(err);
  }
});

export const settingsRouter = router;

import type { Subscription } from 'nats';
import { CONFIG } from '../../config/env';
import type { RobotRuntimeManager } from '../runtime/RobotRuntimeManager';
import {
  computeReconnectDelayMs,
  DEFAULT_NATS_RECONNECT_OPTIONS,
  sleepUnlessStopped,
  startNatsStatusLogger,
} from './natsReconnect';
import {
  closeRobotControlNats,
  decodeRobotControlJson,
  getRobotControlNatsConnection,
  isRobotControlNatsEnabled,
  resetRobotControlNatsConnection,
} from './natsRobotControlClient';
import { handleRobotControlEvent } from './robotControlHandler';
import { ROBOT_CONTROL_WILDCARD } from './robotControlSubjects';

const LOG_PREFIX = '[robot-control]';

let activeSubscription: Subscription | null = null;
let consumeAbort: (() => void) | null = null;
let subscriberStopping = false;
let subscriberLoopStarted = false;
let reconnectAttempt = 0;

async function consumeRobotControlMessages(
  runtime: RobotRuntimeManager,
  sub: Subscription,
  signal: { aborted: boolean }
): Promise<void> {
  for await (const msg of sub) {
    if (signal.aborted || subscriberStopping) {
      break;
    }

    const sizeBefore = runtime.size();
    let result;
    try {
      const rawPayload = decodeRobotControlJson(msg.data);
      result = await handleRobotControlEvent(runtime, {
        subject: msg.subject,
        rawPayload,
      });
    } catch (error) {
      result = {
        ok: false,
        action: 'handler_throw',
        subscriptionId: msg.subject,
        event: 'unknown' as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const sizeAfter = runtime.size();
    const logPayload = {
      subject: msg.subject,
      event: result.event,
      subscriptionId: result.subscriptionId || undefined,
      action: result.action,
      runtimeSizeBefore: sizeBefore,
      runtimeSizeAfter: sizeAfter,
      success: result.ok,
      ignored: result.ignored,
      reloadResult: result.reloadResult,
      error: result.error,
    };

    if (result.ok) {
      console.log(`${LOG_PREFIX} event handled`, logPayload);
    } else {
      console.error(`${LOG_PREFIX} event failed`, logPayload);
    }
  }
}

async function runRobotControlSession(runtime: RobotRuntimeManager): Promise<void> {
  const signal = { aborted: false };
  consumeAbort = () => {
    signal.aborted = true;
  };

  const nc = await getRobotControlNatsConnection();
  console.log(`${LOG_PREFIX} nats connected`, {
    servers: CONFIG.natsUrl,
    clientName: CONFIG.natsClientName,
  });

  const statusLogger = startNatsStatusLogger(nc, LOG_PREFIX, () => subscriberStopping);
  const sub = nc.subscribe(ROBOT_CONTROL_WILDCARD);
  activeSubscription = sub;

  try {
    console.log(`${LOG_PREFIX} subscribed`, {
      pattern: ROBOT_CONTROL_WILDCARD,
      natsUrl: CONFIG.natsUrl,
    });
    reconnectAttempt = 0;
    await consumeRobotControlMessages(runtime, sub, signal);
  } finally {
    statusLogger.stop();
    try {
      sub.unsubscribe();
    } catch (unsubErr) {
      console.warn(`${LOG_PREFIX} unsubscribe error`, {
        error: unsubErr instanceof Error ? unsubErr.message : String(unsubErr),
      });
    }
    activeSubscription = null;
    consumeAbort = null;
  }

  if (!subscriberStopping) {
    console.warn(`${LOG_PREFIX} subscription ended`, { pattern: ROBOT_CONTROL_WILDCARD });
  }
}

async function runRobotControlResilientLoop(runtime: RobotRuntimeManager): Promise<void> {
  while (!subscriberStopping) {
    const isRetry = reconnectAttempt > 0;
    try {
      resetRobotControlNatsConnection();
      console.log(`${LOG_PREFIX} nats connect start`, {
        servers: CONFIG.natsUrl,
        ...(isRetry ? { reconnectAttempt } : {}),
      });
      await runRobotControlSession(runtime);
      if (isRetry && !subscriberStopping) {
        console.log(`${LOG_PREFIX} reconnect success`);
      }
    } catch (error) {
      if (!subscriberStopping) {
        console.error(`${LOG_PREFIX} consume session failed`, {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      }
    }

    if (subscriberStopping) {
      break;
    }

    try {
      await closeRobotControlNats();
    } catch (closeErr) {
      console.warn(`${LOG_PREFIX} close nats before reconnect`, {
        error: closeErr instanceof Error ? closeErr.message : String(closeErr),
      });
      resetRobotControlNatsConnection();
    }

    const delayMs = computeReconnectDelayMs(reconnectAttempt, DEFAULT_NATS_RECONNECT_OPTIONS);
    reconnectAttempt += 1;
    console.warn(`${LOG_PREFIX} reconnect scheduled`, {
      delayMs,
      attempt: reconnectAttempt,
    });
    await sleepUnlessStopped(delayMs, () => subscriberStopping);
  }

  console.log(`${LOG_PREFIX} shutdown`, { subscriberStopping: true });
}

export function startRobotControlSubscriber(runtime: RobotRuntimeManager): {
  started: boolean;
} {
  if (!isRobotControlNatsEnabled()) {
    console.warn(`${LOG_PREFIX} NATS disabled; subscriber not started`, {
      pattern: ROBOT_CONTROL_WILDCARD,
      robotControlNatsEnabled: CONFIG.robotControlNatsEnabled,
      natsUrl: CONFIG.natsUrl,
      hint: 'Set NATS_URL and COPY_ROBOT_CONTROL_NATS_ENABLED=true in .env (same broker as copytrade-messaging), then pm2 restart copy-worker backend',
    });
    return { started: false };
  }

  if (subscriberLoopStarted) {
    return { started: true };
  }

  subscriberStopping = false;
  subscriberLoopStarted = true;
  reconnectAttempt = 0;

  void runRobotControlResilientLoop(runtime);

  return { started: true };
}

export async function stopRobotControlSubscriber(): Promise<void> {
  subscriberStopping = true;
  consumeAbort?.();
  consumeAbort = null;

  const sub = activeSubscription;
  activeSubscription = null;
  sub?.unsubscribe();

  try {
    await closeRobotControlNats();
  } catch (e) {
    console.warn(`${LOG_PREFIX} shutdown close nats`, {
      error: e instanceof Error ? e.message : String(e),
    });
    resetRobotControlNatsConnection();
  }

  console.log(`${LOG_PREFIX} subscriber stopped`);
}

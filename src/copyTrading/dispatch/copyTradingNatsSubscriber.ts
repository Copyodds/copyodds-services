import type { Subscription } from 'nats';
import { CONFIG } from '../../config/env';
import {
  decodeRobotControlJson,
  getRobotControlNatsConnection,
  isRobotControlNatsEnabled,
  resetRobotControlNatsConnection,
} from '../events/natsRobotControlClient';
import {
  computeReconnectDelayMs,
  DEFAULT_NATS_RECONNECT_OPTIONS,
  sleepUnlessStopped,
  startNatsStatusLogger,
} from '../events/natsReconnect';
import { COPY_TRADING_QUEUE_GROUP } from './copyTradingConstants';
import { handleCopyTradingNatsMessage } from './copyTradingNatsHandler';
import { COPY_TRADING_WILDCARD } from './copyTradingSubjects';

const LOG_PREFIX = '[copy-trading-nats]';

let activeSubscription: Subscription | null = null;
let consumeAbort: (() => void) | null = null;
let subscriberStopping = false;
let subscriberLoopStarted = false;
let subscriberLoopPromise: Promise<void> | null = null;
let reconnectAttempt = 0;

class LocalDispatchQueue {
  private readonly pending: Array<() => Promise<void>> = [];
  private inFlight = 0;
  private idleResolvers: Array<() => void> = [];

  constructor(
    private readonly concurrency: number,
    private readonly maxQueued: number
  ) {}

  enqueue(task: () => Promise<void>): boolean {
    if (this.pending.length + this.inFlight >= this.maxQueued) {
      return false;
    }
    this.pending.push(task);
    this.pump();
    return true;
  }

  stats() {
    return {
      pending: this.pending.length,
      inFlight: this.inFlight,
      concurrency: this.concurrency,
      maxQueued: this.maxQueued,
    };
  }

  async waitForIdle(): Promise<void> {
    if (this.pending.length === 0 && this.inFlight === 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  private pump(): void {
    while (this.inFlight < this.concurrency && this.pending.length > 0) {
      const task = this.pending.shift();
      if (!task) break;
      this.inFlight++;
      void task()
        .catch((error) => {
          console.error(`${LOG_PREFIX} queued task failed`, {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });
        })
        .finally(() => {
          this.inFlight--;
          this.pump();
          if (this.pending.length === 0 && this.inFlight === 0) {
            const resolvers = this.idleResolvers.splice(0);
            for (const resolve of resolvers) resolve();
          }
        });
    }
  }
}

const dispatchQueue = new LocalDispatchQueue(
  CONFIG.copyDispatchWorkerConcurrency,
  CONFIG.copyDispatchWorkerQueueMax
);

async function handleQueuedCopyTradingMessage(params: {
  subject: string;
  data: Uint8Array;
  signal: { aborted: boolean };
}): Promise<void> {
  if (params.signal.aborted || subscriberStopping) {
    return;
  }

  let result;
  try {
    const rawPayload = decodeRobotControlJson(params.data);
    result = await handleCopyTradingNatsMessage({
      subject: params.subject,
      rawPayload,
    });
  } catch (error) {
    result = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (result.ok) {
    console.log(`${LOG_PREFIX} message handled`, {
      subject: params.subject,
      leaderTradeId: result.leaderTradeId,
      ignored: result.ignored,
      queue: dispatchQueue.stats(),
    });
  } else {
    console.error(`${LOG_PREFIX} message failed`, {
      subject: params.subject,
      leaderTradeId: result.leaderTradeId,
      error: result.error,
      queue: dispatchQueue.stats(),
    });
  }
}

async function consumeCopyTradingMessages(
  sub: Subscription,
  signal: { aborted: boolean }
): Promise<void> {
  for await (const msg of sub) {
    if (signal.aborted || subscriberStopping) {
      break;
    }

    console.log(`${LOG_PREFIX} received`, { subject: msg.subject });

    const accepted = dispatchQueue.enqueue(() =>
      handleQueuedCopyTradingMessage({
        subject: msg.subject,
        data: msg.data,
        signal,
      })
    );
    if (!accepted) {
      console.error(`${LOG_PREFIX} local queue full; message left for DB replay`, {
        subject: msg.subject,
        queue: dispatchQueue.stats(),
      });
    }
  }
}

async function runCopyTradingNatsSession(): Promise<void> {
  const signal = { aborted: false };
  consumeAbort = () => {
    signal.aborted = true;
  };

  const nc = await getRobotControlNatsConnection();
  const statusLogger = startNatsStatusLogger(nc, LOG_PREFIX, () => subscriberStopping);
  const sub = nc.subscribe(COPY_TRADING_WILDCARD, { queue: COPY_TRADING_QUEUE_GROUP });
  activeSubscription = sub;

  try {
    console.log(`${LOG_PREFIX} subscriber started`, {
      pattern: COPY_TRADING_WILDCARD,
      queue: COPY_TRADING_QUEUE_GROUP,
      natsUrl: CONFIG.natsUrl,
      dispatchQueue: dispatchQueue.stats(),
    });
    reconnectAttempt = 0;
    await consumeCopyTradingMessages(sub, signal);
  } finally {
    await dispatchQueue.waitForIdle();
    statusLogger.stop();
    try {
      sub.unsubscribe();
    } catch (error) {
      console.warn(`${LOG_PREFIX} unsubscribe error`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (activeSubscription === sub) {
      activeSubscription = null;
    }
    if (consumeAbort && signal.aborted) {
      consumeAbort = null;
    }
  }

  if (!subscriberStopping) {
    console.warn(`${LOG_PREFIX} subscription ended`, {
      pattern: COPY_TRADING_WILDCARD,
      queue: COPY_TRADING_QUEUE_GROUP,
    });
  }
}

async function runCopyTradingNatsResilientLoop(): Promise<void> {
  while (!subscriberStopping) {
    const isRetry = reconnectAttempt > 0;
    try {
      console.log(`${LOG_PREFIX} subscribe session start`, {
        pattern: COPY_TRADING_WILDCARD,
        queue: COPY_TRADING_QUEUE_GROUP,
        ...(isRetry ? { reconnectAttempt } : {}),
      });
      await runCopyTradingNatsSession();
      if (isRetry && !subscriberStopping) {
        console.log(`${LOG_PREFIX} reconnect success`);
      }
    } catch (error) {
      if (!subscriberStopping) {
        console.error(`${LOG_PREFIX} consume session failed`, {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        resetRobotControlNatsConnection();
      }
    }

    if (subscriberStopping) {
      break;
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

export function startCopyTradingNatsSubscriber(): { started: boolean } {
  if (!isRobotControlNatsEnabled()) {
    console.warn(`${LOG_PREFIX} NATS disabled; subscriber not started`, {
      pattern: COPY_TRADING_WILDCARD,
      queue: COPY_TRADING_QUEUE_GROUP,
      natsUrl: CONFIG.natsUrl,
    });
    return { started: false };
  }

  if (subscriberLoopStarted) {
    return { started: true };
  }

  subscriberStopping = false;
  subscriberLoopStarted = true;
  reconnectAttempt = 0;
  subscriberLoopPromise = runCopyTradingNatsResilientLoop().finally(() => {
    subscriberLoopStarted = false;
    subscriberLoopPromise = null;
  });

  return { started: true };
}

export async function stopCopyTradingNatsSubscriber(): Promise<void> {
  subscriberStopping = true;
  consumeAbort?.();
  consumeAbort = null;

  const sub = activeSubscription;
  activeSubscription = null;
  sub?.unsubscribe();

  await subscriberLoopPromise;
  console.log(`${LOG_PREFIX} subscriber stopped`);
}

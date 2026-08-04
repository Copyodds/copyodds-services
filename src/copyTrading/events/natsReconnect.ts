import { Events, type NatsConnection } from 'nats';

export type NatsReconnectOptions = {
  initialDelayMs: number;
  maxDelayMs: number;
  jitterMs: number;
};

export const DEFAULT_NATS_RECONNECT_OPTIONS: NatsReconnectOptions = {
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
  jitterMs: 500,
};

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sleepUnlessStopped(
  ms: number,
  shouldStop: () => boolean
): Promise<void> {
  if (ms <= 0 || shouldStop()) {
    return;
  }
  const end = Date.now() + ms;
  while (!shouldStop() && Date.now() < end) {
    await sleep(Math.min(250, end - Date.now()));
  }
}

export function computeReconnectDelayMs(attempt: number, options: NatsReconnectOptions): number {
  const n = Math.max(0, Math.floor(attempt));
  const base = Math.max(0, options.initialDelayMs);
  const max = Math.max(base, options.maxDelayMs);
  if (base <= 0) return 0;
  const exp = Math.min(max, base * 2 ** n);
  const jitter =
    options.jitterMs > 0 ? Math.floor(Math.random() * (options.jitterMs + 1)) : 0;
  return Math.min(max, exp + jitter);
}

const LOGGED_STATUS_TYPES = new Set<string>([
  Events.Disconnect,
  Events.Reconnect,
  Events.Error,
  'close',
]);

export function startNatsStatusLogger(
  nc: NatsConnection,
  logPrefix: string,
  isStopping: () => boolean
): { stop: () => void } {
  let stopped = false;

  void (async () => {
    try {
      for await (const status of nc.status()) {
        if (stopped || isStopping()) {
          break;
        }
        const type = String(status.type);
        if (!LOGGED_STATUS_TYPES.has(type)) {
          continue;
        }
        const data =
          status.data !== undefined && status.data !== null
            ? String(status.data)
            : undefined;
        console.log(`${logPrefix} nats status`, {
          type,
          ...(data ? { data: data.slice(0, 200) } : {}),
        });
      }
    } catch (error) {
      if (!stopped && !isStopping()) {
        console.warn(`${logPrefix} nats status listener error`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  })();

  return {
    stop: () => {
      stopped = true;
    },
  };
}

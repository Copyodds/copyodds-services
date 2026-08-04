import { connect, JSONCodec, type NatsConnection } from 'nats';
import { CONFIG } from '../../config/env';

const codec = JSONCodec<unknown>();

let connPromise: Promise<NatsConnection> | null = null;
let closePromise: Promise<void> | null = null;

export function resetRobotControlNatsConnection(): void {
  connPromise = null;
}

export function isRobotControlNatsEnabled(): boolean {
  return CONFIG.robotControlNatsEnabled && CONFIG.natsUrl.trim().length > 0;
}

export async function getRobotControlNatsConnection(): Promise<NatsConnection> {
  if (!isRobotControlNatsEnabled()) {
    throw new Error('[robot-control-nats] disabled (COPY_ROBOT_CONTROL_NATS_ENABLED=false or empty NATS_URL)');
  }
  if (!connPromise) {
    connPromise = connect({
      servers: CONFIG.natsUrl.split(',').map((s) => s.trim()).filter(Boolean),
      name: CONFIG.natsClientName,
    });
  }
  return connPromise;
}

export async function publishRobotControlJson(subject: string, payload: unknown): Promise<void> {
  const nc = await getRobotControlNatsConnection();
  nc.publish(subject, codec.encode(payload));
}

export function decodeRobotControlJson(data: Uint8Array): unknown {
  return codec.decode(data);
}

export async function closeRobotControlNats(): Promise<void> {
  if (closePromise) {
    await closePromise;
    return;
  }
  const pending = connPromise;
  if (!pending) {
    return;
  }

  closePromise = (async () => {
    try {
      const nc = await pending;
      connPromise = null;
      await nc.drain();
    } catch (e: unknown) {
      const code =
        e !== null && typeof e === 'object' && 'code' in e
          ? String((e as { code: unknown }).code)
          : '';
      if (code === 'CONNECTION_DRAINING') {
        return;
      }
      throw e;
    } finally {
      connPromise = null;
      closePromise = null;
    }
  })();

  await closePromise;
}

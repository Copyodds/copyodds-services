import '../loadEnv';
import { startCopyDispatchLoops } from '../copyTrading/dispatch/copyDispatchLoops';
import { startCopyTradingNatsSubscriber, stopCopyTradingNatsSubscriber } from '../copyTrading/dispatch/copyTradingNatsSubscriber';
import {
  startRobotControlSubscriber,
  stopRobotControlSubscriber,
} from '../copyTrading/events/robotControlSubscriber';
import { getRobotRuntimeManager } from '../copyTrading/runtime/robotRuntimeSingleton';
import { startVirtualCopyWorkerLoops } from '../virtualCopyTrading/virtualCopyWorker';

async function main() {
  const runtime = getRobotRuntimeManager();
  let shuttingDown = false;

  try {
    const { loaded } = await runtime.loadAllEnabledFromDb();
    console.log('[copy-worker] runtime loaded', { loaded, ...runtime.stats() });
  } catch (error) {
    console.error('[copy-worker] runtime loadAllEnabledFromDb failed (continuing without runtime index)', {
      error: error instanceof Error ? error.message : String(error),
    });
    runtime.clear();
    console.warn('[copy-worker] runtime empty; parity checks may report runtimeCount=0 until reload');
  }

  const robotSub = startRobotControlSubscriber(runtime);
  console.log('[copy-worker] robot control subscriber', { started: robotSub.started });

  const tradingSub = startCopyTradingNatsSubscriber();
  console.log('[copy-worker] copy trading NATS subscriber', { started: tradingSub.started });

  const dispatchLoops = startCopyDispatchLoops();
  const virtualCopyLoops = startVirtualCopyWorkerLoops();
  console.log('[copy-worker] dispatch replay + retry sweep loops started');

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      console.warn('[copy-worker] shutdown already in progress', { signal });
      return;
    }
    shuttingDown = true;
    console.log('[copy-worker] shutdown start', { signal });
    try {
      await dispatchLoops.stop();
      virtualCopyLoops.stop();
      await stopCopyTradingNatsSubscriber();
      await stopRobotControlSubscriber();
      runtime.clear();
      console.log('[copy-worker] runtime cleared');
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

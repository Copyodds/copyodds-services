import '../loadEnv';
import { registerSmartMoneyCronsStandalone } from '../jobs/registerServerCrons';
import { refreshSmartMoneyTierConfigCache } from '../services/smartMoney/smartMoneyTierConfig';
import { reconcileCopyPoolPipelineState } from '../services/smartMoney/smartMoneyCopyPoolConsistency';

async function main() {
  console.log('[smart-money-worker] starting', {
    pid: process.pid,
    cronsInApi: process.env.SMART_MONEY_CRONS_IN_API ?? '(default)',
  });

  await refreshSmartMoneyTierConfigCache(true);
  const consistency = await reconcileCopyPoolPipelineState({ force: true }).catch((error) => {
    console.error('[smart-money-worker] copy pool consistency check failed', { error });
    return null;
  });
  if (consistency) {
    console.log('[smart-money-worker] copy pool consistency checked', consistency);
  }
  const controller = registerSmartMoneyCronsStandalone();
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      console.warn('[smart-money-worker] shutdown already in progress', { signal });
      return;
    }
    shuttingDown = true;
    console.log('[smart-money-worker] shutdown start', { signal });
    try {
      controller.stop();
      console.log('[smart-money-worker] crons stopped');
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error('[smart-money-worker] fatal', e);
  process.exit(1);
});

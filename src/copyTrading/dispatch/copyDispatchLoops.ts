import { replayUnprocessedLeaderTrades } from './replayUnprocessedLeaderTrades';
import { sweepRetryableCopyTrades } from '../services/retrySweep';
import { CONFIG } from '../../config/env';

export type CopyDispatchLoopsHandle = {
  stop: () => Promise<void>;
};

export function startCopyDispatchLoops(): CopyDispatchLoopsHandle {
  let closing = false;
  let replayTimer: NodeJS.Timeout | null = null;
  let sweepTimer: NodeJS.Timeout | null = null;
  let replayInFlight: Promise<void> | null = null;
  let sweepInFlight: Promise<void> | null = null;

  const runReplay = (label: 'startup' | 'scheduled') => {
    replayInFlight = (async () => {
      try {
        await replayUnprocessedLeaderTrades();
      } catch (e) {
        console.error(`[copy-dispatch-replay] ${label}`, e);
      } finally {
        replayInFlight = null;
        scheduleReplay();
      }
    })();
  };

  const scheduleReplay = () => {
    if (closing || replayTimer) {
      return;
    }
    replayTimer = setTimeout(() => {
      replayTimer = null;
      if (closing || replayInFlight) {
        scheduleReplay();
        return;
      }
      runReplay('scheduled');
    }, CONFIG.copyDispatchReplayIntervalMs);
  };

  const scheduleSweep = () => {
    if (closing || sweepTimer) {
      return;
    }
    sweepTimer = setTimeout(() => {
      sweepTimer = null;
      if (closing || sweepInFlight) {
        scheduleSweep();
        return;
      }
      sweepInFlight = (async () => {
        try {
          const retried = await sweepRetryableCopyTrades();
          if (retried > 0) {
            console.log('[copy-retry-sweep] requeued failed trades', { count: retried });
          }
        } catch (e) {
          console.error('[copy-retry-sweep]', e);
        } finally {
          sweepInFlight = null;
          scheduleSweep();
        }
      })();
    }, CONFIG.copyRetrySweepIntervalMs);
  };

  runReplay('startup');
  scheduleSweep();

  return {
    stop: async () => {
      closing = true;
      if (replayTimer) {
        clearTimeout(replayTimer);
        replayTimer = null;
      }
      if (sweepTimer) {
        clearTimeout(sweepTimer);
        sweepTimer = null;
      }
      await replayInFlight;
      await sweepInFlight;
    },
  };
}

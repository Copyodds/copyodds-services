import { CONFIG } from '../config/env';
import { virtualCopyMetrics } from '../observability/virtualCopyMetrics';
import { processVirtualAccountLifecycle } from './virtualCopyLifecycle';
import {
  replayPendingVirtualCopyExecutions,
  runDueVirtualCopyExecutions,
} from './virtualCopyExecutionService';
import { reconcileVirtualCopyAccounts } from './virtualCopyReconciliation';

export function startVirtualCopyWorkerLoops(): { stop: () => void } {
  if (!CONFIG.virtualCopyAccountsEnabled) return { stop() {} };
  let executionRunning = false;
  let lifecycleRunning = false;
  let reconciliationRunning = false;
  const executionTimer = setInterval(() => {
    if (
      !CONFIG.virtualCopyExecutionEnabled
      || !CONFIG.virtualCopyOrderBookFillEnabled
      || executionRunning
    ) return;
    executionRunning = true;
    void replayPendingVirtualCopyExecutions()
      .then(() => runDueVirtualCopyExecutions())
      .then(() => {
        virtualCopyMetrics.workerSweeps.labels('execution', 'success').inc();
        virtualCopyMetrics.workerLastSuccessTimestamp.labels('execution').setToCurrentTime();
      })
      .catch((error) => {
        virtualCopyMetrics.workerSweeps.labels('execution', 'error').inc();
        console.error('[virtual-copy-worker] execution sweep failed', error);
      })
      .finally(() => { executionRunning = false; });
  }, CONFIG.virtualCopyExecutionIntervalMs);
  const lifecycleTimer = setInterval(() => {
    if (lifecycleRunning) return;
    lifecycleRunning = true;
    void processVirtualAccountLifecycle(new Date(), {
      settleMarkets: CONFIG.virtualCopySettlementEnabled,
    })
      .then(() => {
        virtualCopyMetrics.workerSweeps.labels('lifecycle', 'success').inc();
        virtualCopyMetrics.workerLastSuccessTimestamp.labels('lifecycle').setToCurrentTime();
      })
      .catch((error) => {
        virtualCopyMetrics.workerSweeps.labels('lifecycle', 'error').inc();
        console.error('[virtual-copy-worker] lifecycle sweep failed', error);
      })
      .finally(() => { lifecycleRunning = false; });
  }, CONFIG.virtualCopyLifecycleIntervalMs);
  const reconciliationTimer = setInterval(() => {
    if (reconciliationRunning) return;
    reconciliationRunning = true;
    void reconcileVirtualCopyAccounts({ pauseOnDrift: true })
      .then((result) => {
        virtualCopyMetrics.workerSweeps.labels('reconciliation', 'success').inc();
        virtualCopyMetrics.workerLastSuccessTimestamp.labels('reconciliation').setToCurrentTime();
        if (result.issues.length > 0) {
          console.error('[virtual-copy-worker] reconciliation drift detected; BUY paused', result);
        }
      })
      .catch((error) => {
        virtualCopyMetrics.workerSweeps.labels('reconciliation', 'error').inc();
        console.error('[virtual-copy-worker] reconciliation sweep failed', error);
      })
      .finally(() => { reconciliationRunning = false; });
  }, CONFIG.virtualCopyReconciliationIntervalMs);
  executionTimer.unref();
  lifecycleTimer.unref();
  reconciliationTimer.unref();
  return {
    stop() {
      clearInterval(executionTimer);
      clearInterval(lifecycleTimer);
      clearInterval(reconciliationTimer);
    },
  };
}

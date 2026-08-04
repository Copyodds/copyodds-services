/**
 * orphan copyability requeue / stranded promote 条件（无 DB）。
 * 跑：npx tsx src/services/smartMoney/smartMoneyCopyabilityOrphanRequeue.test.ts
 */
import assert from 'node:assert/strict';

function isCopyabilityComputed(score: number | null | undefined): boolean {
  return score != null && Number.isFinite(Number(score));
}

function poolScore(traderScore: number | null, score: number): number {
  return traderScore != null && Number.isFinite(traderScore) ? traderScore : score;
}

function shouldRequeueOrphanCopyability(input: {
  pipelineStage: string;
  inCopyPool: boolean;
  enrichPending: boolean;
  copyabilityScore: number | null;
  traderScore: number | null;
  score: number;
  enterScore: number;
  copyReadyRequired: boolean;
}): boolean {
  if (!input.copyReadyRequired) return false;
  if (input.inCopyPool) return false;
  if (input.enrichPending) return false;
  if (input.pipelineStage !== 'SCORED') return false;
  if (isCopyabilityComputed(input.copyabilityScore)) return false;
  return poolScore(input.traderScore, input.score) >= input.enterScore;
}

/** copy 已算好的干净搁浅：应直接 promote，不再只靠 enrichPending */
function shouldPromoteStrandedCopyReady(input: {
  inCopyPool: boolean;
  copyabilityScore: number | null;
  traderScore: number | null;
  score: number;
  enterScore: number;
  hasHardFlag: boolean;
  copyReadyRequired: boolean;
}): boolean {
  if (!input.copyReadyRequired) return false;
  if (input.inCopyPool) return false;
  if (!isCopyabilityComputed(input.copyabilityScore)) return false;
  if (input.hasHardFlag) return false;
  return poolScore(input.traderScore, input.score) >= input.enterScore;
}

function shouldClearEnrichPendingAfterTryEnter(input: {
  entered: boolean;
  reason: string;
  belowEnter: boolean;
  allowPoolEnter: boolean;
  hardReason: string | null;
  exitedCopyPool: boolean;
}): boolean {
  if (input.exitedCopyPool) return false; // 尊重 removeFromCopyPool
  if (!input.allowPoolEnter) return true;
  if (input.hardReason != null) return true;
  if (input.entered) return true;
  if (input.belowEnter || input.reason === 'SCORE_BELOW') return true;
  if (input.reason === 'DISABLED' || input.reason === 'ALREADY_IN_POOL') return true;
  return false; // 达线仍未进 → 保持 pending
}

assert.equal(
  shouldRequeueOrphanCopyability({
    pipelineStage: 'SCORED',
    inCopyPool: false,
    enrichPending: false,
    copyabilityScore: null,
    traderScore: 55,
    score: 40,
    enterScore: 50,
    copyReadyRequired: true,
  }),
  true
);

assert.equal(
  shouldRequeueOrphanCopyability({
    pipelineStage: 'SCORED',
    inCopyPool: false,
    enrichPending: false,
    copyabilityScore: 0,
    traderScore: 55,
    score: 40,
    enterScore: 50,
    copyReadyRequired: true,
  }),
  false
);

assert.equal(
  shouldPromoteStrandedCopyReady({
    inCopyPool: false,
    copyabilityScore: 0,
    traderScore: 55,
    score: 40,
    enterScore: 50,
    hasHardFlag: false,
    copyReadyRequired: true,
  }),
  true
);

assert.equal(
  shouldPromoteStrandedCopyReady({
    inCopyPool: false,
    copyabilityScore: 55,
    traderScore: 35,
    score: 35,
    enterScore: 50,
    hasHardFlag: false,
    copyReadyRequired: true,
  }),
  false
);

assert.equal(
  shouldClearEnrichPendingAfterTryEnter({
    entered: false,
    reason: 'HARD_FLAG',
    belowEnter: false,
    allowPoolEnter: true,
    hardReason: null,
    exitedCopyPool: false,
  }),
  false
);

assert.equal(
  shouldClearEnrichPendingAfterTryEnter({
    entered: false,
    reason: 'SCORE_BELOW',
    belowEnter: true,
    allowPoolEnter: true,
    hardReason: null,
    exitedCopyPool: false,
  }),
  true
);

assert.equal(
  shouldRequeueOrphanCopyability({
    pipelineStage: 'ELIMINATED',
    inCopyPool: false,
    enrichPending: false,
    copyabilityScore: null,
    traderScore: 80,
    score: 80,
    enterScore: 50,
    copyReadyRequired: true,
  }),
  false
);

console.log('smartMoneyCopyabilityOrphanRequeue.test.ts: ok');

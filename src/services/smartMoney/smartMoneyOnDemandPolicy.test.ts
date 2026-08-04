import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  canAcceptSmartMoneyAnalyzeJob,
  decideSmartMoneyAnalyzeAction,
} from './smartMoneyOnDemandPolicy';

const completeFresh = {
  exists: true,
  coreComplete: true,
  curvesComplete: true,
  fatalDataMissing: false,
  fresh: true,
};

assert.equal(decideSmartMoneyAnalyzeAction(completeFresh), 'skip');
assert.equal(
  decideSmartMoneyAnalyzeAction({ ...completeFresh, curvesComplete: false }),
  'enrich_only'
);
assert.equal(decideSmartMoneyAnalyzeAction({ ...completeFresh, fresh: false }), 'deep');
assert.equal(decideSmartMoneyAnalyzeAction({ ...completeFresh, exists: false }), 'deep');
assert.equal(decideSmartMoneyAnalyzeAction({ ...completeFresh, coreComplete: false }), 'deep');
assert.equal(decideSmartMoneyAnalyzeAction({ ...completeFresh, fatalDataMissing: true }), 'deep');

assert.equal(canAcceptSmartMoneyAnalyzeJob(0, 5), true);
assert.equal(canAcceptSmartMoneyAnalyzeJob(4, 5), true);
assert.equal(canAcceptSmartMoneyAnalyzeJob(5, 5), false);
assert.equal(canAcceptSmartMoneyAnalyzeJob(6, 5), false);

// 防回归：按需编排不得重新引入批处理淘汰或 stage 改写。
const runnerSource = readFileSync(join(__dirname, 'smartMoneyOnDemandAnalyze.ts'), 'utf8');
assert.equal(runnerSource.includes('moveToEliminated'), false);
assert.equal(runnerSource.includes('transitionPipelineStage'), false);
assert.equal(runnerSource.includes('allowElimination: false'), true);
assert.equal(runnerSource.includes('mutatePipelineStage: false'), true);

const queueSource = readFileSync(join(__dirname, 'smartMoneyAnalyzeQueue.ts'), 'utf8');
assert.equal(queueSource.includes("status: { in: ['PENDING', 'RUNNING'] }"), true);
assert.equal(queueSource.includes('smart-money-on-demand-analysis'), true);
assert.equal(queueSource.includes('isLeaderboardWorkBusy'), true);
assert.equal(queueSource.includes("next.action === 'ENRICH_ONLY'"), true);

const migrationSource = readFileSync(
  join(
    __dirname,
    '../../../prisma/migrations/20260730113000_smart_money_analyze_job/migration.sql'
  ),
  'utf8'
);
assert.equal(migrationSource.includes('SmartMoneyAnalyzeJob_activeKey_key'), true);
assert.equal(migrationSource.includes('CREATE UNIQUE INDEX'), true);

console.log('smartMoneyOnDemandPolicy.test.ts: ok');

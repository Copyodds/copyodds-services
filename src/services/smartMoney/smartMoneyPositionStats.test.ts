import assert from 'node:assert/strict';
import {
  buildClosedMarketReturnDistribution,
  findMaxInvestedClosedMarket,
  summarizeClosedPositionPnlStats,
} from './smartMoneyPositionStats';

{
  const stats = summarizeClosedPositionPnlStats([
    { conditionId: 'm1', realizedPnl: 100 },
    { conditionId: 'm2', realizedPnl: 50 },
  ] as never[]);
  assert.equal(stats.profitFactor, null, 'no losing markets => unbounded PF is null, not a sentinel');
  assert.equal(stats.profitFactorNoLoss, true);
  assert.equal(stats.winningMarkets, 2);
  assert.equal(stats.losingMarkets, 0);
}

{
  const stats = summarizeClosedPositionPnlStats([
    { conditionId: 'm1', realizedPnl: 100 },
    { conditionId: 'm2', realizedPnl: -40 },
  ] as never[]);
  assert.equal(stats.profitFactor, 2.5);
  assert.equal(stats.profitFactorNoLoss, false);
  assert.equal(stats.winningMarkets, 1);
  assert.equal(stats.losingMarkets, 1);
}

{
  const nowMs = Date.UTC(2026, 6, 25);
  const within = Math.floor(nowMs / 1000) - 10 * 24 * 60 * 60;
  const result = findMaxInvestedClosedMarket(
    [
      {
        conditionId: 'c-small',
        avgPrice: 0.5,
        totalBought: 100,
        realizedPnl: 20,
        title: 'Small stake',
        timestamp: within,
      },
      {
        conditionId: 'c-large',
        avgPrice: 0.4,
        totalBought: 1000,
        realizedPnl: -80,
        title: 'Large stake',
        timestamp: within,
      },
      {
        // same market as c-large → costs/pnl should aggregate
        conditionId: 'c-large',
        avgPrice: 0.6,
        totalBought: 200,
        realizedPnl: 10,
        timestamp: within,
      },
      {
        conditionId: 'c-mid',
        initialValue: 250,
        realizedPnl: 5,
        title: 'Mid',
        timestamp: within,
      },
    ] as never[],
    365,
    nowMs
  );
  assert.ok(result);
  // c-large: 1000*0.4 + 200*0.6 = 400 + 120 = 520
  assert.equal(result!.costBasisUsd, 520);
  assert.equal(result!.realizedPnl, -70);
  assert.equal(result!.conditionId, 'c-large');
  assert.equal(result!.title, 'Large stake');
  assert.equal(result!.sampleSize, 3);
}

{
  assert.equal(findMaxInvestedClosedMarket([]), null);
}

{
  // 仅有收益率 + 盈亏（无 initialValue / totalBought）也应能反推最大投入
  const nowMs = Date.UTC(2026, 6, 25);
  const within = Math.floor(nowMs / 1000) - 5 * 24 * 60 * 60;
  const result = findMaxInvestedClosedMarket(
    [
      {
        conditionId: 'pct-small',
        realizedPnl: 50,
        percentRealizedPnl: 0.25, // cost = 200
        timestamp: within,
        title: 'Small',
      },
      {
        conditionId: 'pct-large',
        realizedPnl: 100,
        percentRealizedPnl: 10, // 10% → ratio 0.1 → cost = 1000
        timestamp: within,
        title: 'Large by pct',
      },
    ] as never[],
    365,
    nowMs
  );
  assert.ok(result);
  assert.equal(result!.costBasisUsd, 1000);
  assert.equal(result!.conditionId, 'pct-large');
  assert.equal(result!.realizedPnl, 100);
}

{
  // 总盈利率 = Σpnl/Σcost；平均 = 事件等权（小单高倍率不绑架总分母）
  const nowMs = Date.UTC(2026, 6, 25);
  const within = Math.floor(nowMs / 1000) - 3 * 24 * 60 * 60;
  const dist = buildClosedMarketReturnDistribution(
    [
      {
        conditionId: 'big',
        initialValue: 1000,
        realizedPnl: 100, // +10%
        timestamp: within,
      },
      {
        conditionId: 'tiny-lottery',
        initialValue: 10,
        realizedPnl: 90, // +900%
        timestamp: within,
      },
      {
        // 同一市场两行应先合并再算收益率
        conditionId: 'merged',
        initialValue: 200,
        realizedPnl: 20,
        timestamp: within,
      },
      {
        conditionId: 'merged',
        initialValue: 300,
        realizedPnl: 30,
        timestamp: within,
      },
    ] as never[],
    365,
    nowMs
  );
  assert.ok(dist);
  assert.equal(dist!.sampledMarketCount, 3);
  // Σpnl=100+90+50=240，Σcost=1000+10+500=1510 → ~15.89%
  assert.ok(
    dist!.totalReturnRatio != null && Math.abs(dist!.totalReturnRatio - 240 / 1510) < 1e-4,
    `expected total ~${240 / 1510}, got ${dist!.totalReturnRatio}`
  );
  // 等权平均：(0.1 + 9 + 0.1) / 3 = 3.066...
  assert.ok(
    dist!.meanReturn != null && Math.abs(dist!.meanReturn - (0.1 + 9 + 0.1) / 3) < 1e-4,
    `expected equal-weight mean, got ${dist!.meanReturn}`
  );
  assert.ok(dist!.meanReturn! > (dist!.totalReturnRatio ?? 0));
}

console.log('smartMoneyPositionStats.test.ts: ok');

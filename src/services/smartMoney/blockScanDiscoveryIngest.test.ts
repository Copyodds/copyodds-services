import assert from 'node:assert/strict';
import { Prisma } from '../../generated/prisma/client';

async function main() {
  const { BLOCK_SCAN_DISCOVERY, BLOCK_SCAN_DISCOVERY_STATUS, blockScanDiscoveryLogic } =
    await import('./blockScanDiscoveryIngest');

  // 门槛走环境变量；未配置时保持历史默认值
  assert.equal(BLOCK_SCAN_DISCOVERY.MIN_FILLS, Number(process.env.SMART_MONEY_BLOCK_SCAN_MIN_FILLS ?? 5));
  assert.equal(
    BLOCK_SCAN_DISCOVERY.MIN_NOTIONAL_USD,
    Number(process.env.SMART_MONEY_BLOCK_SCAN_MIN_NOTIONAL_USD ?? 500)
  );
  assert.equal(
    BLOCK_SCAN_DISCOVERY.INGEST_MAX_WALLETS,
    Number(process.env.SMART_MONEY_BLOCK_SCAN_INGEST_MAX ?? 500)
  );
  assert.equal(
    BLOCK_SCAN_DISCOVERY.FETCH_PRIORITY_SLOTS,
    Number(process.env.SMART_MONEY_BLOCK_SCAN_FETCH_PRIORITY_SLOTS ?? 5)
  );

  assert.equal(
    blockScanDiscoveryLogic.normalizeWallet('0x1111111111111111111111111111111111111111'),
    '0x1111111111111111111111111111111111111111'
  );
  assert.equal(blockScanDiscoveryLogic.normalizeWallet('bad'), null);

  assert.equal(
    blockScanDiscoveryLogic.isQualified(5, new Prisma.Decimal(1)),
    true,
    'window fill threshold qualifies'
  );
  assert.equal(
    blockScanDiscoveryLogic.isQualified(1, new Prisma.Decimal(600)),
    true,
    'notional threshold qualifies'
  );
  assert.equal(
    blockScanDiscoveryLogic.isQualified(1, new Prisma.Decimal(10)),
    false,
    'below both thresholds'
  );

  assert.deepEqual(
    blockScanDiscoveryLogic.applyWindow(null, 50, 2),
    { windowStartBlock: 50, windowFillCount: 2 }
  );
  assert.deepEqual(
    blockScanDiscoveryLogic.applyWindow({ windowStartBlock: 10, windowFillCount: 2 }, 20, 1),
    { windowStartBlock: 10, windowFillCount: 3 }
  );
  assert.deepEqual(
    blockScanDiscoveryLogic.applyWindow(
      { windowStartBlock: 10, windowFillCount: 99, status: BLOCK_SCAN_DISCOVERY_STATUS.SCORED },
      20,
      1
    ),
    { windowStartBlock: 20, windowFillCount: 1 },
    'scored row resets window on re-ingest without re-qualifying'
  );

  // 超上限时按名义金额降序截断，而不是插入序
  const mkRow = (suffix: string, fillCount: number, maxNotional: string) => ({
    wallet: `0x${suffix.repeat(40).slice(0, 40)}`,
    fillCount,
    maxNotional,
    lastBlock: 1,
  });
  const topSelected = blockScanDiscoveryLogic.selectTopWalletsByNotional(
    [mkRow('1', 1, '50'), mkRow('2', 3, '5000'), mkRow('3', 2, '300'), mkRow('4', 9, '300')],
    2
  );
  assert.deepEqual(
    topSelected.map((row) => row.maxNotional),
    ['5000', '300'],
    'keeps highest notional rows'
  );
  assert.equal(topSelected[1]?.fillCount, 9, 'notional tie broken by fillCount');
  assert.equal(
    blockScanDiscoveryLogic.selectTopWalletsByNotional([mkRow('1', 1, '50')], 2).length,
    1,
    'under limit passes through untouched'
  );

  console.log('blockScanDiscoveryIngest.test.ts: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

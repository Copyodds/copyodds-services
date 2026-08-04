import assert from 'node:assert/strict';
import { getPnlDayWindowStartUtc, zonedDateTimeToUtc } from './pnlDayWindow';

const TZ = 'Asia/Shanghai';

// 2026-05-27 10:00 CST → 窗口自 2026-05-27 08:00 CST
const may27_10_cst = zonedDateTimeToUtc(2026, 5, 27, 10, 0, 0, TZ);
const may27_8_cst = getPnlDayWindowStartUtc(may27_10_cst, TZ, 8);
assert.equal(
  may27_8_cst.toISOString(),
  zonedDateTimeToUtc(2026, 5, 27, 8, 0, 0, TZ).toISOString()
);

// 2026-05-27 07:00 CST → 窗口自 2026-05-26 08:00 CST
const may27_7_cst = zonedDateTimeToUtc(2026, 5, 27, 7, 0, 0, TZ);
const may26_8_cst = getPnlDayWindowStartUtc(may27_7_cst, TZ, 8);
assert.equal(
  may26_8_cst.toISOString(),
  zonedDateTimeToUtc(2026, 5, 26, 8, 0, 0, TZ).toISOString()
);

// 恰好在 08:00 CST
const may27_8_exact = zonedDateTimeToUtc(2026, 5, 27, 8, 0, 0, TZ);
assert.equal(
  getPnlDayWindowStartUtc(may27_8_exact, TZ, 8).toISOString(),
  may27_8_exact.toISOString()
);

console.log('pnlDayWindow.test.ts: ok');

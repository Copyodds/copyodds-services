import assert from 'node:assert/strict';
import { parseLeaderAmountAsClobSize } from './leaderFillAmount';

// 链上整数 micro-shares：与价格无关，始终 /1e6
assert.equal(parseLeaderAmountAsClobSize('1035176', 0.966), 1.035176);
assert.equal(parseLeaderAmountAsClobSize('1035176', 0.034), 1.035176);
assert.equal(parseLeaderAmountAsClobSize('500000', 0.96), 0.5);

// 已人类可读的十进制字符串
assert.equal(parseLeaderAmountAsClobSize('1.035176', 0.966), 1.035176);

// 旧逻辑在低价时会漏除 1e6；修复后不再放大到百万份
assert.ok(parseLeaderAmountAsClobSize('180456625', 0.003) < 200);

console.log('leaderFillAmount.test.ts: ok');

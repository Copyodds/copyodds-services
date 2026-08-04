import assert from 'node:assert/strict';
import { encodeEventTopics, encodeAbiParameters, parseAbiParameters, getAddress } from 'viem';
import { sumUsdcETransferInToRecipient, USDC_E_ADDRESS } from './redeemProceedsFromChainParse';

const recipient = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
const ctf = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

function usdcTransferLog(params: { from: string; to: string; value: bigint }) {
  const topics = encodeEventTopics({
    abi: [
      {
        type: 'event',
        name: 'Transfer',
        inputs: [
          { name: 'from', type: 'address', indexed: true },
          { name: 'to', type: 'address', indexed: true },
          { name: 'value', type: 'uint256', indexed: false },
        ],
      },
    ],
    eventName: 'Transfer',
    args: {
      from: getAddress(params.from as `0x${string}`),
      to: getAddress(params.to as `0x${string}`),
    },
  });
  const data = encodeAbiParameters(parseAbiParameters('uint256 value'), [params.value]);
  return {
    address: USDC_E_ADDRESS,
    topics,
    data,
  };
}

const logs = [
  usdcTransferLog({ from: ctf, to: recipient, value: 5_000_000n }),
  usdcTransferLog({ from: ctf, to: other, value: 1_000_000n }),
  usdcTransferLog({ from: ctf, to: recipient, value: 500_000n }),
];

assert.equal(sumUsdcETransferInToRecipient(logs, recipient), 5_500_000n);
assert.equal(sumUsdcETransferInToRecipient(logs, other), 1_000_000n);
assert.equal(sumUsdcETransferInToRecipient([], recipient), 0n);

console.log('redeemProceedsFromChain.test.ts ok');

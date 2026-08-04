import { decodeEventLog, getAddress, parseAbiItem, type Log } from 'viem';

export const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as const;

const transferEvent = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

export function sumUsdcETransferInToRecipient(
  logs: ReadonlyArray<Pick<Log, 'address' | 'topics' | 'data'>>,
  recipient: string,
  tokenAddress: string = USDC_E_ADDRESS,
): bigint {
  const recipientNorm = getAddress(recipient as `0x${string}`).toLowerCase();
  const tokenNorm = tokenAddress.toLowerCase();
  let sum = 0n;

  for (const log of logs) {
    if (log.address.toLowerCase() !== tokenNorm) continue;
    if (!log.topics?.length) continue;

    try {
      const decoded = decodeEventLog({
        abi: [transferEvent],
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
      if (decoded.eventName !== 'Transfer') continue;

      const to = getAddress(decoded.args.to as `0x${string}`).toLowerCase();
      if (to !== recipientNorm) continue;
      sum += decoded.args.value as bigint;
    } catch {
      continue;
    }
  }

  return sum;
}

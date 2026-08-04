/** PR2: copy-worker 将订阅此通配；PR1 仅用于 shadow publish */
export const COPY_TRADING_WILDCARD = 'copy.trading.*';

export function copyTradingSubject(leaderAddress: string): string {
  return `copy.trading.${leaderAddress.trim().toLowerCase()}`;
}

export function parseCopyTradingSubject(subject: string): { leaderAddress: string } | null {
  const match = /^copy\.trading\.(0x[a-f0-9]{40})$/.exec(subject.trim());
  if (!match) {
    return null;
  }
  return { leaderAddress: match[1] };
}

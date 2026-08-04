/** RAW 地址发现源分类（Phase H） */

export function isLeaderboardSource(source: string): boolean {
  return source.trim().toUpperCase().includes('LEADERBOARD');
}

export function hasLeaderboardSource(sources: string[] | null | undefined): boolean {
  return (sources ?? []).some((source) => isLeaderboardSource(source));
}

export function hasBlockScanSource(sources: string[] | null | undefined): boolean {
  return (sources ?? []).some((source) => source.trim().toUpperCase().includes('BLOCK_SCAN'));
}

export function isFastTrackSource(sources: string[] | null | undefined): boolean {
  if (!sources?.length) return false;
  return sources.some((source) => {
    const upper = source.trim().toUpperCase();
    return (
      upper.includes('LEADERBOARD') ||
      upper.includes('BLOCK_SCAN') ||
      upper.includes('ADMIN') ||
      upper.includes('MANUAL')
    );
  });
}

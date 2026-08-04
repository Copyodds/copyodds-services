/** Reserved negative user ids for discoverable-login challenge rows (never real users). */
export function discoverableChallengeUserId(requestId: string): number {
  let hash = 0;
  for (let i = 0; i < requestId.length; i += 1) {
    hash = ((hash << 5) - hash + requestId.charCodeAt(i)) | 0;
  }
  const bucket = (Math.abs(hash) % 1_000_000_000) + 1;
  return -bucket;
}

export function isDiscoverableChallengeUserId(userId: number): boolean {
  return userId < 0;
}

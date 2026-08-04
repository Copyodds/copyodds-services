/** Pure helpers for /copy-trade/feed leader address resolution (unit-tested). */

export type FeedSubscriptionRow = {
  id: string;
  leader: { address: string };
};

/**
 * Resolve which leader addresses to include in the feed query.
 * `subscriptions` should be the caller's non-deleted subscriptions (including paused).
 * Returns empty array when filter is invalid or leader is not subscribed.
 */
export function resolveFeedLeaderAddresses(params: {
  subscriptions: FeedSubscriptionRow[];
  subscriptionId?: string;
  leaderAddress?: string;
}): string[] {
  const addressSet = new Set(
    params.subscriptions.map((s) => s.leader.address.toLowerCase()).filter(Boolean)
  );
  const allAddresses = Array.from(addressSet);

  if (params.subscriptionId) {
    const sub = params.subscriptions.find((s) => s.id === params.subscriptionId);
    if (!sub) return [];
    const addr = sub.leader.address.toLowerCase();
    return addressSet.has(addr) ? [addr] : [];
  }

  if (params.leaderAddress) {
    const addr = params.leaderAddress.toLowerCase();
    return addressSet.has(addr) ? [addr] : [];
  }

  return allAddresses;
}

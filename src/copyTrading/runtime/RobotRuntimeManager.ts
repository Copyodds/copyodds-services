import { prisma } from '../../db';
import { normalizeLeaderAddress } from './normalizeLeaderAddress';
import { mapSubscriptionToRuntimeState } from './subscriptionMapper';
import { loadWalletSnapshotsForUserIds } from './walletSnapshotLoader';
import type { RobotRuntimeState, RobotRuntimeStats } from './types';

const TOP_LEADERS_LIMIT = 10;

export class RobotRuntimeManager {
  private readonly bySubscriptionId = new Map<string, RobotRuntimeState>();
  private readonly byLeaderAddress = new Map<string, Set<string>>();

  async loadAllEnabledFromDb(): Promise<{ loaded: number }> {
    this.clear();

    const rows = await prisma.copySubscription.findMany({
      where: { enabled: true, deletedAt: null, leader: { enabled: true } },
      include: {
        leader: { select: { address: true } },
      },
    });

    const walletByUser = await loadWalletSnapshotsForUserIds(rows.map((r) => r.userId));
    const loadedAt = new Date().toISOString();

    for (const row of rows) {
      const wallet = walletByUser.get(row.userId) ?? null;
      this.upsert(mapSubscriptionToRuntimeState(row, wallet, loadedAt));
    }

    return { loaded: this.bySubscriptionId.size };
  }

  async reloadSubscriptionFromDb(subscriptionId: string): Promise<'upsert' | 'remove' | 'missing'> {
    const row = await prisma.copySubscription.findUnique({
      where: { id: subscriptionId },
      include: { leader: { select: { address: true, enabled: true } } },
    });

    if (!row || !row.enabled || row.deletedAt != null || !row.leader.enabled) {
      const had = this.bySubscriptionId.has(subscriptionId);
      this.remove(subscriptionId);
      return had ? 'remove' : 'missing';
    }

    const walletByUser = await loadWalletSnapshotsForUserIds([row.userId]);
    const wallet = walletByUser.get(row.userId) ?? null;
    this.upsert(mapSubscriptionToRuntimeState(row, wallet));
    return 'upsert';
  }

  upsert(state: RobotRuntimeState): void {
    const id = state.subscriptionId;
    const leaderKey = normalizeLeaderAddress(state.leaderAddress);

    const previous = this.bySubscriptionId.get(id);
    if (previous && previous.leaderAddress !== leaderKey) {
      this.detachFromLeaderIndex(previous.leaderAddress, id);
    }

    const normalized: RobotRuntimeState = {
      ...state,
      robotId: id,
      subscriptionId: id,
      leaderAddress: leaderKey,
      enabled: true,
    };

    this.bySubscriptionId.set(id, normalized);
    this.attachToLeaderIndex(leaderKey, id);
  }

  remove(subscriptionId: string): boolean {
    const existing = this.bySubscriptionId.get(subscriptionId);
    if (!existing) {
      return false;
    }
    this.detachFromLeaderIndex(existing.leaderAddress, subscriptionId);
    this.bySubscriptionId.delete(subscriptionId);
    return true;
  }

  getByLeaderAddress(leaderAddress: string): RobotRuntimeState[] {
    const key = normalizeLeaderAddress(leaderAddress);
    const ids = this.byLeaderAddress.get(key);
    if (!ids?.size) {
      return [];
    }
    const out: RobotRuntimeState[] = [];
    for (const id of ids) {
      const state = this.bySubscriptionId.get(id);
      if (state) {
        out.push(state);
      }
    }
    return out;
  }

  getBySubscriptionId(subscriptionId: string): RobotRuntimeState | undefined {
    return this.bySubscriptionId.get(subscriptionId);
  }

  size(): number {
    return this.bySubscriptionId.size;
  }

  stats(): RobotRuntimeStats {
    const totalRobots = this.bySubscriptionId.size;
    const leaderCount = this.byLeaderAddress.size;
    const users = new Set<number>();
    const leaderCounts: Array<{ leaderAddress: string; robotCount: number }> = [];

    for (const state of this.bySubscriptionId.values()) {
      users.add(state.userId);
    }

    for (const [leaderAddress, ids] of this.byLeaderAddress.entries()) {
      leaderCounts.push({ leaderAddress, robotCount: ids.size });
    }

    leaderCounts.sort((a, b) => b.robotCount - a.robotCount || a.leaderAddress.localeCompare(b.leaderAddress));

    return {
      totalRobots,
      leaderCount,
      uniqueUserCount: users.size,
      topLeaders: leaderCounts.slice(0, TOP_LEADERS_LIMIT),
    };
  }

  clear(): void {
    this.bySubscriptionId.clear();
    this.byLeaderAddress.clear();
  }

  private attachToLeaderIndex(leaderAddress: string, subscriptionId: string): void {
    const key = normalizeLeaderAddress(leaderAddress);
    let set = this.byLeaderAddress.get(key);
    if (!set) {
      set = new Set();
      this.byLeaderAddress.set(key, set);
    }
    set.add(subscriptionId);
  }

  private detachFromLeaderIndex(leaderAddress: string, subscriptionId: string): void {
    const key = normalizeLeaderAddress(leaderAddress);
    const set = this.byLeaderAddress.get(key);
    if (!set) {
      return;
    }
    set.delete(subscriptionId);
    if (set.size === 0) {
      this.byLeaderAddress.delete(key);
    }
  }
}

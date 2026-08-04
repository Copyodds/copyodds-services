/**
 * 进程内 TTL 缓存（单机、不依赖 Redis）。
 * - 命中直接返回
 * - 未命中时同一 key 单飞（singleflight），避免惊群打库
 */

export type TtlMemoryCacheOptions = {
  /** 条目存活时间 */
  ttlMs: number;
  /** 最大条目数；超出时删最旧 */
  maxEntries?: number;
};

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

export type TtlMemoryCacheStats = {
  hits: number;
  misses: number;
  size: number;
};

export class TtlMemoryCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly store = new Map<string, CacheEntry<unknown>>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private hits = 0;
  private misses = 0;

  constructor(options: TtlMemoryCacheOptions) {
    this.ttlMs = Math.max(0, options.ttlMs);
    this.maxEntries = Math.max(1, options.maxEntries ?? 256);
  }

  get stats(): TtlMemoryCacheStats {
    return { hits: this.hits, misses: this.misses, size: this.store.size };
  }

  peek<T>(key: string): T | undefined {
    if (this.ttlMs <= 0) return undefined;
    const entry = this.store.get(key) as CacheEntry<T> | undefined;
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    // Map 迭代顺序：重新 set 以近似 LRU
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set<T>(key: string, value: T): void {
    if (this.ttlMs <= 0) return;
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      const oldest = this.store.keys().next().value as string | undefined;
      if (oldest != null) this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
    this.inflight.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * 获取或加载。并发同 key 共用一次 loader。
   */
  async getOrSet<T>(key: string, loader: () => Promise<T>): Promise<{ value: T; hit: boolean }> {
    if (this.ttlMs <= 0) {
      this.misses += 1;
      return { value: await loader(), hit: false };
    }

    const cached = this.peek<T>(key);
    if (cached !== undefined) {
      this.hits += 1;
      return { value: cached, hit: true };
    }

    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) {
      const value = await existing;
      this.hits += 1;
      return { value, hit: true };
    }

    this.misses += 1;
    const task = (async () => {
      const value = await loader();
      this.set(key, value);
      return value;
    })();
    this.inflight.set(key, task);
    try {
      const value = await task;
      return { value, hit: false };
    } finally {
      this.inflight.delete(key);
    }
  }
}

/** 稳定序列化对象为缓存 key（键排序） */
export function stableCacheKey(input: unknown): string {
  return JSON.stringify(sortKeysDeep(input));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value != null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortKeysDeep(obj[key]);
    }
    return out;
  }
  return value;
}

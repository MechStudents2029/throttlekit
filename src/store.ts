/**
 * Shared counter backend for `createDistributedLimiter`.
 * `transact` applies one pure update atomically so two callers cannot
 * oversubscribe the same key. The in-memory store is the default.
 * Redis is optional and lives in `createRedisStore`.
 */
export type StoreMutation<T> = {
  /** Next raw value. `null` deletes the key. */
  next: string | null;
  /**
   * Milliseconds until the key may expire.
   * Omit or use a non-positive value to keep the key until it is replaced.
   * Ignored when `next` is null.
   */
  ttlMs?: number;
  result: T;
};

export type LimiterStore = {
  transact<T>(
    key: string,
    update: (current: string | null) => StoreMutation<T>,
  ): Promise<T>;
};

type MemoryRecord = {
  value: string;
  expiresAt: number | null;
};

/**
 * Process-local store. Updates run to completion before the next one starts,
 * so callers that share this store and a key share one counter.
 * `now` is used only for key expiry. The limiter clock still decides refill
 * and window age.
 */
export function createMemoryStore(now: () => number = Date.now): LimiterStore {
  const records = new Map<string, MemoryRecord>();

  function read(key: string): string | null {
    const record = records.get(key);
    if (!record) {
      return null;
    }
    if (record.expiresAt !== null && now() >= record.expiresAt) {
      records.delete(key);
      return null;
    }
    return record.value;
  }

  return {
    transact<T>(
      key: string,
      update: (current: string | null) => StoreMutation<T>,
    ): Promise<T> {
      const current = read(key);
      const mutation = update(current);
      if (mutation.next === null) {
        records.delete(key);
      } else {
        const ttlMs = mutation.ttlMs;
        const expiresAt =
          ttlMs !== undefined && ttlMs > 0 ? now() + ttlMs : null;
        records.set(key, { value: mutation.next, expiresAt });
      }
      return Promise.resolve(mutation.result);
    },
  };
}

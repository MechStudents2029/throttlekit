import { describe, expect, it } from "vitest";
import {
  createDistributedLimiter,
  createLimiter,
  createMemoryStore,
  type Clock,
} from "../src/index.js";

type FakeClock = Clock & {
  advance(ms: number): void;
  pending(): number;
};

function createFakeClock(start = 0): FakeClock {
  let now = start;
  const waiters: Array<{ resumeAt: number; resolve: () => void }> = [];

  return {
    now(): number {
      return now;
    },
    sleep(ms: number): Promise<void> {
      if (ms <= 0) {
        return Promise.resolve();
      }
      const resumeAt = now + ms;
      return new Promise((resolve) => {
        waiters.push({ resumeAt, resolve });
      });
    },
    advance(ms: number): void {
      if (ms < 0) {
        throw new Error("fake clock cannot move backwards");
      }
      now += ms;
      const ready: Array<{ resolve: () => void }> = [];
      const pending: typeof waiters = [];
      for (const waiter of waiters) {
        if (waiter.resumeAt <= now) {
          ready.push(waiter);
        } else {
          pending.push(waiter);
        }
      }
      waiters.length = 0;
      waiters.push(...pending);
      for (const waiter of ready) {
        waiter.resolve();
      }
    },
    pending(): number {
      return waiters.length;
    },
  };
}

async function flushMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

describe("memory store", () => {
  it("shares a value across transactions and deletes on null", async () => {
    const store = createMemoryStore(() => 0);
    await store.transact("k", (current) => {
      expect(current).toBeNull();
      return { next: "a", result: "wrote" };
    });
    const second = await store.transact("k", (current) => {
      expect(current).toBe("a");
      return { next: null, result: "deleted" };
    });
    const third = await store.transact("k", (current) => {
      expect(current).toBeNull();
      return { next: current, result: current };
    });
    expect(second).toBe("deleted");
    expect(third).toBeNull();
  });

  it("drops a key once its ttl has elapsed on the store clock", async () => {
    let now = 0;
    const store = createMemoryStore(() => now);
    await store.transact("k", () => ({ next: "a", ttlMs: 10, result: true }));

    now = 9;
    await store.transact("k", (current) => {
      expect(current).toBe("a");
      return { next: current, ttlMs: 1, result: true };
    });

    now = 10;
    await store.transact("k", (current) => {
      expect(current).toBeNull();
      return { next: null, result: true };
    });
  });
});

describe("distributed token bucket", () => {
  it("matches the in-memory limiter on the same clock", async () => {
    let now = 0;
    const clock = { now: () => now };
    const sync = createLimiter({ capacity: 5, refillPerSecond: 2, clock });
    const shared = createDistributedLimiter({
      store: createMemoryStore(),
      key: "parity",
      capacity: 5,
      refillPerSecond: 2,
      clock,
    });
    const steps = [
      { at: 0, n: 1 },
      { at: 0, n: 2 },
      { at: 100, n: 1 },
      { at: 250, n: 3 },
      { at: 1_000, n: 5 },
      { at: 1_000, n: 1 },
      { at: 1_500, n: 2 },
      { at: 1_500, n: 4 },
    ];

    for (const step of steps) {
      now = step.at;
      const left = sync.tryTake(step.n);
      const right = await shared.tryTake(step.n);
      expect(right).toEqual(left);
    }
  });

  it("shares one counter across limiters and keeps other keys apart", async () => {
    const store = createMemoryStore();
    const clock = { now: () => 0 };
    const first = createDistributedLimiter({
      store,
      key: "api",
      capacity: 2,
      refillPerSecond: 1,
      clock,
    });
    const second = createDistributedLimiter({
      store,
      key: "api",
      capacity: 2,
      refillPerSecond: 1,
      clock,
    });
    const other = createDistributedLimiter({
      store,
      key: "other",
      capacity: 2,
      refillPerSecond: 1,
      clock,
    });

    expect(await first.tryTake()).toEqual({ ok: true, remaining: 1, retryAfterMs: 0 });
    expect(await second.tryTake()).toEqual({ ok: true, remaining: 0, retryAfterMs: 0 });
    expect(await first.tryTake()).toEqual({
      ok: false,
      remaining: 0,
      retryAfterMs: 1_000,
    });
    expect(await other.tryTake(2)).toEqual({ ok: true, remaining: 0, retryAfterMs: 0 });
  });

  it("does not grant more than capacity when takes run together", async () => {
    const store = createMemoryStore();
    const left = createDistributedLimiter({
      store,
      key: "burst",
      capacity: 5,
      refillPerSecond: 0,
    });
    const right = createDistributedLimiter({
      store,
      key: "burst",
      capacity: 5,
      refillPerSecond: 0,
    });
    const results = await Promise.all([
      ...Array.from({ length: 5 }, () => left.tryTake()),
      ...Array.from({ length: 5 }, () => right.tryTake()),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(5);
    expect(results.filter((result) => !result.ok).every((result) => result.remaining === 0)).toBe(
      true,
    );
  });

  it("resolves wait only after the shared bucket refills", async () => {
    const clock = createFakeClock(0);
    const limiter = createDistributedLimiter({
      store: createMemoryStore(),
      key: "wait",
      capacity: 1,
      refillPerSecond: 1,
      clock,
    });

    expect((await limiter.tryTake()).ok).toBe(true);
    const denied = await limiter.tryTake();
    expect(denied.ok).toBe(false);

    let settled = false;
    const pending = limiter.wait().then(() => {
      settled = true;
    });

    await flushMicrotasks();
    expect(settled).toBe(false);
    expect(clock.pending()).toBe(1);

    clock.advance(denied.retryAfterMs - 1);
    await flushMicrotasks();
    expect(settled).toBe(false);

    clock.advance(1);
    await pending;
    expect(settled).toBe(true);
    expect((await limiter.tryTake()).ok).toBe(false);
  });

  it("rejects a take that can never fit and leaves the bucket unused", async () => {
    const limiter = createDistributedLimiter({
      store: createMemoryStore(),
      key: "fit",
      capacity: 2,
      refillPerSecond: 1,
      clock: { now: () => 0 },
    });

    await expect(limiter.tryTake(3)).rejects.toThrow(/capacity/);
    expect(await limiter.tryTake(2)).toEqual({ ok: true, remaining: 0, retryAfterMs: 0 });
    expect(() =>
      createDistributedLimiter({
        store: createMemoryStore(),
        key: "fit",
        capacity: 0,
        refillPerSecond: 1,
      }),
    ).toThrow(/capacity/);
    expect(() =>
      createDistributedLimiter({
        store: createMemoryStore(),
        key: "  ",
        capacity: 1,
        refillPerSecond: 1,
      }),
    ).toThrow(/key/);
  });
});

describe("distributed sliding window", () => {
  it("matches the in-memory limiter on the same clock", async () => {
    let now = 0;
    const clock = { now: () => now };
    const sync = createLimiter({
      strategy: "sliding-window",
      windowMs: 1_000,
      max: 3,
      clock,
    });
    const shared = createDistributedLimiter({
      store: createMemoryStore(),
      key: "window-parity",
      strategy: "sliding-window",
      windowMs: 1_000,
      max: 3,
      clock,
    });
    const steps = [
      { at: 0, n: 1 },
      { at: 100, n: 1 },
      { at: 200, n: 1 },
      { at: 200, n: 1 },
      { at: 1_000, n: 1 },
      { at: 1_000, n: 2 },
      { at: 1_100, n: 1 },
      { at: 1_200, n: 2 },
    ];

    for (const step of steps) {
      now = step.at;
      expect(await shared.tryTake(step.n)).toEqual(sync.tryTake(step.n));
    }
  });

  it("shares the window across limiters, including aged-out hits", async () => {
    let now = 0;
    const clock = { now: () => now };
    const store = createMemoryStore();
    const first = createDistributedLimiter({
      store,
      key: "window",
      strategy: "sliding-window",
      windowMs: 1_000,
      max: 1,
      clock,
    });
    const second = createDistributedLimiter({
      store,
      key: "window",
      strategy: "sliding-window",
      windowMs: 1_000,
      max: 1,
      clock,
    });

    expect(await first.tryTake()).toEqual({ ok: true, remaining: 0, retryAfterMs: 0 });
    now = 999;
    expect(await second.tryTake()).toEqual({ ok: false, remaining: 0, retryAfterMs: 1 });
    now = 1_000;
    expect(await second.tryTake()).toEqual({ ok: true, remaining: 0, retryAfterMs: 0 });
  });

  it("resolves wait when the blocking request ages out", async () => {
    const clock = createFakeClock(0);
    const limiter = createDistributedLimiter({
      store: createMemoryStore(),
      key: "window-wait",
      strategy: "sliding-window",
      windowMs: 1_000,
      max: 1,
      clock,
    });

    expect((await limiter.tryTake()).ok).toBe(true);
    const denied = await limiter.tryTake();
    expect(denied).toEqual({ ok: false, remaining: 0, retryAfterMs: 1_000 });

    let settled = false;
    const pending = limiter.wait().then(() => {
      settled = true;
    });

    await flushMicrotasks();
    expect(settled).toBe(false);
    expect(clock.pending()).toBe(1);

    clock.advance(denied.retryAfterMs - 1);
    await flushMicrotasks();
    expect(settled).toBe(false);

    clock.advance(1);
    await pending;
    expect(settled).toBe(true);
    expect((await limiter.tryTake()).ok).toBe(false);
  });

  it("rejects invalid options and a mismatched strategy on the same key", async () => {
    expect(() =>
      createDistributedLimiter({
        store: createMemoryStore(),
        key: "bad",
        strategy: "sliding-window",
        windowMs: 0,
        max: 1,
      }),
    ).toThrow(/windowMs/);
    expect(() =>
      createDistributedLimiter({
        store: createMemoryStore(),
        key: "bad",
        strategy: "nope" as "token-bucket",
        capacity: 1,
        refillPerSecond: 1,
      }),
    ).toThrow(/strategy/);

    const store = createMemoryStore();
    const bucket = createDistributedLimiter({
      store,
      key: "shared-kind",
      capacity: 1,
      refillPerSecond: 1,
      clock: { now: () => 0 },
    });
    expect((await bucket.tryTake()).ok).toBe(true);
    const window = createDistributedLimiter({
      store,
      key: "shared-kind",
      strategy: "sliding-window",
      windowMs: 1_000,
      max: 1,
      clock: { now: () => 0 },
    });
    await expect(window.tryTake()).rejects.toThrow(/token-bucket/);
  });
});

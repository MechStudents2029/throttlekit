import { describe, expect, it } from "vitest";
import { createLimiter, type Clock } from "../src/index.js";

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

describe("createLimiter", () => {
  it("starts full and takes tokens within capacity", () => {
    const limiter = createLimiter({
      capacity: 3,
      refillPerSecond: 1,
      clock: { now: () => 0 },
    });

    expect(limiter.tryTake()).toEqual({
      ok: true,
      remaining: 2,
      retryAfterMs: 0,
    });
    expect(limiter.tryTake(2)).toEqual({
      ok: true,
      remaining: 0,
      retryAfterMs: 0,
    });
  });

  it("denies a take when the bucket is empty", () => {
    const limiter = createLimiter({
      capacity: 1,
      refillPerSecond: 1,
      clock: { now: () => 0 },
    });

    expect(limiter.tryTake().ok).toBe(true);
    expect(limiter.tryTake()).toEqual({
      ok: false,
      remaining: 0,
      retryAfterMs: 1000,
    });
  });

  it("refills continuously over time and does not exceed capacity", () => {
    let now = 0;
    const limiter = createLimiter({
      capacity: 2,
      refillPerSecond: 4,
      clock: { now: () => now },
    });

    expect(limiter.tryTake(2)).toMatchObject({ ok: true, remaining: 0 });

    now = 125;
    const partial = limiter.tryTake(1);
    expect(partial.ok).toBe(false);
    expect(partial.remaining).toBeCloseTo(0.5);
    expect(partial.retryAfterMs).toBe(125);

    now = 250;
    expect(limiter.tryTake(1)).toEqual({
      ok: true,
      remaining: 0,
      retryAfterMs: 0,
    });

    now = 10_000;
    expect(limiter.tryTake(1)).toEqual({
      ok: true,
      remaining: 1,
      retryAfterMs: 0,
    });
  });

  it("resolves wait only after the bucket refills", async () => {
    const clock = createFakeClock(0);
    const limiter = createLimiter({
      capacity: 1,
      refillPerSecond: 1,
      clock,
    });

    expect(limiter.tryTake().ok).toBe(true);
    const denied = limiter.tryTake();
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
    expect(limiter.tryTake().ok).toBe(false);
  });

  it("resolves wait immediately when tokens are already available", async () => {
    const clock = createFakeClock(0);
    const limiter = createLimiter({
      capacity: 2,
      refillPerSecond: 1,
      clock,
    });

    await limiter.wait(2);
    expect(clock.pending()).toBe(0);
    expect(limiter.tryTake().ok).toBe(false);
  });

  it("does not oversubscribe when many tryTake calls share one bucket", () => {
    const limiter = createLimiter({
      capacity: 5,
      refillPerSecond: 10,
      clock: { now: () => 1_000 },
    });

    const requests = [2, 2, 2, 1, 3, 1];
    const results = requests.map((n) => limiter.tryTake(n));
    const granted = results.reduce(
      (sum, result, index) => sum + (result.ok ? requests[index]! : 0),
      0,
    );

    expect(granted).toBe(5);
    expect(results.map((result) => result.ok)).toEqual([
      true,
      true,
      false,
      true,
      false,
      false,
    ]);
    expect(results[0]).toMatchObject({ remaining: 3, retryAfterMs: 0 });
    expect(results[2]).toMatchObject({ ok: false, remaining: 1, retryAfterMs: 100 });
    expect(results.at(-1)).toMatchObject({ ok: false, remaining: 0 });
    for (const result of results) {
      expect(result.remaining).toBeGreaterThanOrEqual(0);
      expect(result.remaining).toBeLessThanOrEqual(5);
    }
  });

  it("rejects a take that can never fit in the bucket", () => {
    const limiter = createLimiter({
      capacity: 2,
      refillPerSecond: 1,
      clock: { now: () => 0 },
    });

    expect(() => limiter.tryTake(3)).toThrow(/capacity/);
    expect(() =>
      createLimiter({ capacity: 0, refillPerSecond: 1, clock: { now: () => 0 } }),
    ).toThrow(/capacity/);
  });
});

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

describe("sliding-window limiter", () => {
  it("admits requests up to max and reports remaining slots", () => {
    const limiter = createLimiter({
      strategy: "sliding-window",
      windowMs: 1_000,
      max: 3,
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
    expect(limiter.tryTake()).toEqual({
      ok: false,
      remaining: 0,
      retryAfterMs: 1_000,
    });
  });

  it("keeps a request until the window boundary, then frees it", () => {
    let now = 0;
    const limiter = createLimiter({
      strategy: "sliding-window",
      windowMs: 1_000,
      max: 1,
      clock: { now: () => now },
    });

    expect(limiter.tryTake()).toEqual({
      ok: true,
      remaining: 0,
      retryAfterMs: 0,
    });

    now = 999;
    expect(limiter.tryTake()).toEqual({
      ok: false,
      remaining: 0,
      retryAfterMs: 1,
    });

    now = 1_000;
    expect(limiter.tryTake()).toEqual({
      ok: true,
      remaining: 0,
      retryAfterMs: 0,
    });
  });

  it("frees only the requests that have aged out of the window", () => {
    let now = 0;
    const limiter = createLimiter({
      strategy: "sliding-window",
      windowMs: 1_000,
      max: 3,
      clock: { now: () => now },
    });

    expect(limiter.tryTake()).toEqual({ ok: true, remaining: 2, retryAfterMs: 0 });
    now = 100;
    expect(limiter.tryTake()).toEqual({ ok: true, remaining: 1, retryAfterMs: 0 });
    now = 200;
    expect(limiter.tryTake()).toEqual({ ok: true, remaining: 0, retryAfterMs: 0 });

    expect(limiter.tryTake()).toEqual({
      ok: false,
      remaining: 0,
      retryAfterMs: 800,
    });

    now = 1_000;
    expect(limiter.tryTake()).toEqual({
      ok: true,
      remaining: 0,
      retryAfterMs: 0,
    });
    expect(limiter.tryTake()).toEqual({
      ok: false,
      remaining: 0,
      retryAfterMs: 100,
    });
  });

  it("charges n units and waits until enough weight ages out", () => {
    let now = 0;
    const limiter = createLimiter({
      strategy: "sliding-window",
      windowMs: 1_000,
      max: 5,
      clock: { now: () => now },
    });

    expect(limiter.tryTake(3)).toEqual({
      ok: true,
      remaining: 2,
      retryAfterMs: 0,
    });
    now = 400;
    expect(limiter.tryTake(2)).toEqual({
      ok: true,
      remaining: 0,
      retryAfterMs: 0,
    });
    expect(limiter.tryTake(2)).toEqual({
      ok: false,
      remaining: 0,
      retryAfterMs: 600,
    });

    now = 999;
    expect(limiter.tryTake(2)).toEqual({
      ok: false,
      remaining: 0,
      retryAfterMs: 1,
    });

    now = 1_000;
    expect(limiter.tryTake(2)).toEqual({
      ok: true,
      remaining: 1,
      retryAfterMs: 0,
    });
    expect(limiter.tryTake(3)).toEqual({
      ok: false,
      remaining: 1,
      retryAfterMs: 400,
    });
  });

  it("reports remaining when n does not fit even though smaller takes would", () => {
    const limiter = createLimiter({
      strategy: "sliding-window",
      windowMs: 1_000,
      max: 3,
      clock: { now: () => 50 },
    });

    expect(limiter.tryTake()).toEqual({ ok: true, remaining: 2, retryAfterMs: 0 });
    expect(limiter.tryTake(3)).toEqual({
      ok: false,
      remaining: 2,
      retryAfterMs: 1_000,
    });
    expect(limiter.tryTake(2)).toEqual({
      ok: true,
      remaining: 0,
      retryAfterMs: 0,
    });
  });

  it("resolves wait when the blocking request ages out", async () => {
    const clock = createFakeClock(0);
    const limiter = createLimiter({
      strategy: "sliding-window",
      windowMs: 1_000,
      max: 1,
      clock,
    });

    expect(limiter.tryTake().ok).toBe(true);
    const denied = limiter.tryTake();
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
    expect(limiter.tryTake().ok).toBe(false);
  });

  it("resolves wait(n) only after enough units have aged out", async () => {
    const clock = createFakeClock(0);
    const limiter = createLimiter({
      strategy: "sliding-window",
      windowMs: 1_000,
      max: 2,
      clock,
    });

    expect(limiter.tryTake().ok).toBe(true);
    clock.advance(100);
    expect(limiter.tryTake().ok).toBe(true);
    expect(limiter.tryTake(2)).toEqual({
      ok: false,
      remaining: 0,
      retryAfterMs: 1_000,
    });

    let settled = false;
    const pending = limiter.wait(2).then(() => {
      settled = true;
    });

    await flushMicrotasks();
    clock.advance(999);
    await flushMicrotasks();
    expect(settled).toBe(false);

    clock.advance(1);
    await pending;
    expect(settled).toBe(true);
    expect(limiter.tryTake().ok).toBe(false);
  });

  it("resolves wait immediately when the window has room", async () => {
    const clock = createFakeClock(0);
    const limiter = createLimiter({
      strategy: "sliding-window",
      windowMs: 1_000,
      max: 2,
      clock,
    });

    await limiter.wait(2);
    expect(clock.pending()).toBe(0);
    expect(limiter.tryTake()).toEqual({
      ok: false,
      remaining: 0,
      retryAfterMs: 1_000,
    });
  });

  it("rejects invalid options and costs that can never fit", () => {
    expect(() =>
      createLimiter({ strategy: "sliding-window", windowMs: 0, max: 1 }),
    ).toThrow(/windowMs/);
    expect(() =>
      createLimiter({ strategy: "sliding-window", windowMs: -10, max: 1 }),
    ).toThrow(/windowMs/);
    expect(() =>
      createLimiter({
        strategy: "sliding-window",
        windowMs: Number.POSITIVE_INFINITY,
        max: 1,
      }),
    ).toThrow(/windowMs/);
    expect(() =>
      createLimiter({ strategy: "sliding-window", windowMs: 1_000, max: 0 }),
    ).toThrow(/max/);
    expect(() =>
      createLimiter({ strategy: "sliding-window", windowMs: 1_000, max: 1.5 }),
    ).toThrow(/max/);
    expect(() =>
      createLimiter({
        strategy: "nope" as "token-bucket",
        capacity: 1,
        refillPerSecond: 1,
      }),
    ).toThrow(/strategy/);

    const limiter = createLimiter({
      strategy: "sliding-window",
      windowMs: 1_000,
      max: 2,
      clock: { now: () => 0 },
    });
    expect(() => limiter.tryTake(3)).toThrow(/max/);
    expect(() => limiter.tryTake(0)).toThrow(/n/);
    expect(() => limiter.tryTake(1.5)).toThrow(/n/);
    expect(limiter.tryTake()).toEqual({
      ok: true,
      remaining: 1,
      retryAfterMs: 0,
    });
  });

  it("keeps the token bucket when strategy is omitted or token-bucket", () => {
    let now = 0;
    const clock = { now: () => now };
    const omitted = createLimiter({
      capacity: 1,
      refillPerSecond: 1,
      clock,
    });
    const explicit = createLimiter({
      strategy: "token-bucket",
      capacity: 1,
      refillPerSecond: 1,
      clock,
    });
    const sliding = createLimiter({
      strategy: "sliding-window",
      windowMs: 1_000,
      max: 1,
      clock,
    });

    expect(omitted.tryTake()).toMatchObject({ ok: true, remaining: 0 });
    expect(explicit.tryTake()).toMatchObject({ ok: true, remaining: 0 });
    expect(sliding.tryTake()).toMatchObject({ ok: true, remaining: 0 });

    now = 500;
    expect(omitted.tryTake()).toMatchObject({
      ok: false,
      remaining: 0.5,
      retryAfterMs: 500,
    });
    expect(explicit.tryTake()).toMatchObject({
      ok: false,
      remaining: 0.5,
      retryAfterMs: 500,
    });
    expect(sliding.tryTake()).toEqual({
      ok: false,
      remaining: 0,
      retryAfterMs: 500,
    });
  });
});

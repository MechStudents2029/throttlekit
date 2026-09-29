import { bench } from "vitest";
import {
  createDistributedLimiter,
  createLimiter,
  createMemoryStore,
  rateLimitHeaders,
  type TakeResult,
} from "../src/index.js";

/**
 * In-memory microbench. Clocks are stepped by a fixed amount so every
 * `tryTake` stays on the allowed path. No sleeps, Redis, or network.
 */
let sink = 0;

const HEADER_NOW_MS = 1_700_000_000_000;

function assertAllowed(label: string, decision: TakeResult): void {
  if (!decision.ok) {
    throw new Error(`${label} bench left the allowed path`);
  }
  sink = decision.remaining;
}

function tokenBucketAllowed(): () => void {
  const capacity = 10;
  const refillPerSecond = 1_000;
  let nowMs = 0;
  const limiter = createLimiter({
    capacity,
    refillPerSecond,
    clock: { now: () => nowMs },
  });

  return () => {
    nowMs += 1;
    assertAllowed("token-bucket", limiter.tryTake());
  };
}

function slidingWindowAllowed(): () => void {
  const windowMs = 1_000;
  const max = 8;
  const stepMs = windowMs / max;
  let nowMs = 0;
  const limiter = createLimiter({
    strategy: "sliding-window",
    windowMs,
    max,
    clock: { now: () => nowMs },
  });

  return () => {
    nowMs += stepMs;
    assertAllowed("sliding-window", limiter.tryTake());
  };
}

function headersOnDecision(): () => void {
  const decision = createLimiter({
    capacity: 10,
    refillPerSecond: 2,
    clock: { now: () => HEADER_NOW_MS },
  }).tryTake();
  const meta = { limit: 10, nowMs: HEADER_NOW_MS };

  return () => {
    const headers = rateLimitHeaders(decision, meta);
    sink = headers["X-RateLimit-Remaining"].length;
  };
}

function distributedMemoryAllowed(): () => Promise<void> {
  const capacity = 10;
  const refillPerSecond = 1_000;
  let nowMs = 0;
  const limiter = createDistributedLimiter({
    store: createMemoryStore(),
    key: "bench-token-bucket",
    capacity,
    refillPerSecond,
    clock: { now: () => nowMs },
  });

  return async () => {
    nowMs += 1;
    assertAllowed("distributed memory", await limiter.tryTake());
  };
}

bench("token-bucket tryTake allowed", tokenBucketAllowed());
bench("sliding-window tryTake allowed", slidingWindowAllowed());
bench("rateLimitHeaders on an allowed decision", headersOnDecision());
bench("createDistributedLimiter memory tryTake allowed", distributedMemoryAllowed());

/** Milliseconds. `now()` is monotonic for a given limiter only if the clock is. */
export type Clock = {
  now(): number;
  /**
   * Suspend until `ms` has elapsed on this clock.
   * Tests inject this so `wait` does not use real timers.
   * Defaults to `setTimeout` when omitted.
   */
  sleep?(ms: number): Promise<void>;
};

export type LimiterStrategy = "token-bucket" | "sliding-window";

export type TokenBucketOptions = {
  /** Omit to keep the Day 1 token bucket. */
  strategy?: "token-bucket";
  /** Maximum tokens stored in the bucket. The bucket starts full. */
  capacity: number;
  /** Tokens added per second. Refill is continuous; fractional tokens are kept. */
  refillPerSecond: number;
  /** Injectable time source. Defaults to `Date.now` and `setTimeout`. */
  clock?: Clock;
};

export type SlidingWindowOptions = {
  strategy: "sliding-window";
  /** Rolling window length in milliseconds. A hit ages out at `at + windowMs`. */
  windowMs: number;
  /** Maximum request units allowed inside the window. */
  max: number;
  /** Injectable time source. Defaults to `Date.now` and `setTimeout`. */
  clock?: Clock;
};

export type LimiterOptions = TokenBucketOptions | SlidingWindowOptions;

export type TakeResult = {
  /** True when `n` units were admitted. */
  ok: boolean;
  /**
   * Capacity left after this call.
   * Token bucket: tokens remaining (may be fractional).
   * Sliding window: how many more request units fit in the current window.
   */
  remaining: number;
  /**
   * Milliseconds until `tryTake(n)` could succeed.
   * `0` when `ok` is true. `Infinity` when this limiter can never admit `n`.
   */
  retryAfterMs: number;
};

export type Limiter = {
  tryTake(n?: number): TakeResult;
  /** Resolve once `n` tokens have been taken. Uses `clock.sleep` while waiting. */
  wait(n?: number): Promise<void>;
};

const TOKEN_EPSILON = 1e-9;

function assertFiniteNumber(name: string, value: number): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
}

function assertPositive(name: string, value: number): void {
  assertFiniteNumber(name, value);
  if (value <= 0) {
    throw new Error(`${name} must be greater than 0`);
  }
}

function assertNonNegative(name: string, value: number): void {
  assertFiniteNumber(name, value);
  if (value < 0) {
    throw new Error(`${name} must be greater than or equal to 0`);
  }
}

/** Snap binary dust so an exact token count stays an exact integer. */
function normalizeTokens(value: number): number {
  if (value <= TOKEN_EPSILON) {
    return 0;
  }
  const nearest = Math.round(value);
  if (Math.abs(value - nearest) <= TOKEN_EPSILON) {
    return nearest;
  }
  return value;
}

function systemSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Rate limiter. `strategy` defaults to the Day 1 token bucket.
 * `"sliding-window"` counts request units over a rolling window.
 * Each `tryTake` is atomic: concurrent callers cannot oversubscribe one limiter.
 */
export function createLimiter(options: LimiterOptions): Limiter {
  switch (options.strategy) {
    case "sliding-window":
      return createSlidingWindowLimiter(options);
    case "token-bucket":
    case undefined:
      return createTokenBucketLimiter(options);
    default:
      return rejectStrategy(options);
  }
}

function rejectStrategy(options: LimiterOptions): never {
  const strategy = (options as { strategy?: unknown }).strategy;
  throw new Error(
    `strategy must be "token-bucket" or "sliding-window" (received ${JSON.stringify(strategy)})`,
  );
}

/**
 * Token bucket. Tokens refill continuously up to `capacity`.
 * Each `tryTake` is atomic: concurrent callers cannot oversubscribe the bucket.
 */
function createTokenBucketLimiter(options: TokenBucketOptions): Limiter {
  assertPositive("capacity", options.capacity);
  assertNonNegative("refillPerSecond", options.refillPerSecond);

  const capacity = options.capacity;
  const refillPerSecond = options.refillPerSecond;
  const clock = options.clock;
  const now = clock?.now ?? Date.now;
  const sleep = clock?.sleep ?? systemSleep;

  let tokens = capacity;
  let updatedAt = now();

  function refill(at: number): void {
    const elapsedMs = at - updatedAt;
    if (elapsedMs <= 0) {
      return;
    }
    updatedAt = at;
    if (refillPerSecond === 0 || tokens >= capacity) {
      return;
    }
    const added = (elapsedMs / 1000) * refillPerSecond;
    tokens = normalizeTokens(Math.min(capacity, tokens + added));
  }

  function retryAfterMs(n: number): number {
    if (refillPerSecond === 0) {
      return Number.POSITIVE_INFINITY;
    }
    const deficit = n - tokens;
    if (deficit <= TOKEN_EPSILON) {
      return 0;
    }
    const ms = (deficit / refillPerSecond) * 1000;
    return Math.max(1, Math.ceil(ms - TOKEN_EPSILON));
  }

  function takeCount(n: number | undefined): number {
    const count = n ?? 1;
    assertPositive("n", count);
    if (count > capacity) {
      throw new Error(`n (${count}) exceeds capacity (${capacity})`);
    }
    return count;
  }

  function tryTake(n?: number): TakeResult {
    const count = takeCount(n);
    refill(now());
    if (tokens + TOKEN_EPSILON >= count) {
      tokens = normalizeTokens(tokens - count);
      return { ok: true, remaining: tokens, retryAfterMs: 0 };
    }
    return {
      ok: false,
      remaining: tokens,
      retryAfterMs: retryAfterMs(count),
    };
  }

  async function wait(n?: number): Promise<void> {
    for (;;) {
      const decision = tryTake(n);
      if (decision.ok) {
        return;
      }
      if (!Number.isFinite(decision.retryAfterMs)) {
        throw new Error(
          "cannot wait for tokens: refillPerSecond is 0 and the bucket is short",
        );
      }
      await sleep(decision.retryAfterMs);
    }
  }

  return { tryTake, wait };
}

type WindowHit = {
  at: number;
  weight: number;
};

function assertPositiveInteger(name: string, value: number): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

/**
 * Exact sliding window. Each admitted take records its timestamp and cost.
 * A hit at time `at` counts while `now - at < windowMs` and ages out at `at + windowMs`.
 */
function createSlidingWindowLimiter(options: SlidingWindowOptions): Limiter {
  assertPositive("windowMs", options.windowMs);
  assertPositiveInteger("max", options.max);

  const windowMs = options.windowMs;
  const max = options.max;
  const clock = options.clock;
  const now = clock?.now ?? Date.now;
  const sleep = clock?.sleep ?? systemSleep;

  const hits: WindowHit[] = [];

  function takeCount(n: number | undefined): number {
    const count = n ?? 1;
    assertPositiveInteger("n", count);
    if (count > max) {
      throw new Error(`n (${count}) exceeds max (${max})`);
    }
    return count;
  }

  function prune(at: number): void {
    const oldestKept = at - windowMs;
    let write = 0;
    for (let read = 0; read < hits.length; read += 1) {
      const hit = hits[read]!;
      if (hit.at > oldestKept) {
        hits[write] = hit;
        write += 1;
      }
    }
    hits.length = write;
    hits.sort((left, right) => left.at - right.at);
  }

  function occupied(): number {
    let used = 0;
    for (const hit of hits) {
      used += hit.weight;
    }
    return used;
  }

  function msUntilFit(count: number, at: number): number {
    let need = occupied() + count - max;
    if (need <= 0) {
      return 0;
    }
    for (const hit of hits) {
      need -= hit.weight;
      if (need <= 0) {
        const ms = hit.at + windowMs - at;
        return Math.max(1, Math.ceil(ms - TOKEN_EPSILON));
      }
    }
    return Number.POSITIVE_INFINITY;
  }

  function tryTake(n?: number): TakeResult {
    const count = takeCount(n);
    const at = now();
    prune(at);
    const used = occupied();
    if (used + count <= max) {
      hits.push({ at, weight: count });
      hits.sort((left, right) => left.at - right.at);
      return { ok: true, remaining: max - used - count, retryAfterMs: 0 };
    }
    return {
      ok: false,
      remaining: max - used,
      retryAfterMs: msUntilFit(count, at),
    };
  }

  async function wait(n?: number): Promise<void> {
    for (;;) {
      const decision = tryTake(n);
      if (decision.ok) {
        return;
      }
      if (!Number.isFinite(decision.retryAfterMs)) {
        throw new Error("cannot wait: the sliding window cannot admit this take");
      }
      await sleep(decision.retryAfterMs);
    }
  }

  return { tryTake, wait };
}

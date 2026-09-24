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

export type LimiterOptions = {
  /** Maximum tokens stored in the bucket. The bucket starts full. */
  capacity: number;
  /** Tokens added per second. Refill is continuous; fractional tokens are kept. */
  refillPerSecond: number;
  /** Injectable time source. Defaults to `Date.now` and `setTimeout`. */
  clock?: Clock;
};

export type TakeResult = {
  /** True when `n` tokens were removed from the bucket. */
  ok: boolean;
  /** Tokens left after this call (after refill). May be fractional. */
  remaining: number;
  /**
   * Milliseconds until `tryTake(n)` could succeed.
   * `0` when `ok` is true. `Infinity` when the bucket cannot refill.
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
 * Token bucket. Tokens refill continuously up to `capacity`.
 * Each `tryTake` is atomic: concurrent callers cannot oversubscribe the bucket.
 */
export function createLimiter(options: LimiterOptions): Limiter {
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

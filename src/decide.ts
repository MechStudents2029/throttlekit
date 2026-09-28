/**
 * Pure token-bucket and sliding-window decisions.
 * `createLimiter` and `createDistributedLimiter` both use these so a shared
 * store applies the same rules as the in-memory limiter.
 */

type Decision = {
  ok: boolean;
  remaining: number;
  retryAfterMs: number;
};

const TOKEN_EPSILON = 1e-9;

export type BucketState = {
  tokens: number;
  updatedAt: number;
};

export type WindowHit = {
  at: number;
  weight: number;
};

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

/**
 * Refill `state` up to `at`, then admit `count` or leave the bucket unchanged.
 * A denied take still keeps the refilled balance and timestamp.
 */
export function applyBucketTake(
  state: BucketState,
  count: number,
  at: number,
  capacity: number,
  refillPerSecond: number,
): { state: BucketState; result: Decision } {
  let tokens = state.tokens;
  let updatedAt = state.updatedAt;

  const elapsedMs = at - updatedAt;
  if (elapsedMs > 0) {
    updatedAt = at;
    if (refillPerSecond !== 0 && tokens < capacity) {
      const added = (elapsedMs / 1000) * refillPerSecond;
      tokens = normalizeTokens(Math.min(capacity, tokens + added));
    }
  }

  if (tokens + TOKEN_EPSILON >= count) {
    tokens = normalizeTokens(tokens - count);
    return {
      state: { tokens, updatedAt },
      result: { ok: true, remaining: tokens, retryAfterMs: 0 },
    };
  }

  let retryAfterMs: number;
  if (refillPerSecond === 0) {
    retryAfterMs = Number.POSITIVE_INFINITY;
  } else {
    const deficit = count - tokens;
    if (deficit <= TOKEN_EPSILON) {
      retryAfterMs = 0;
    } else {
      const ms = (deficit / refillPerSecond) * 1000;
      retryAfterMs = Math.max(1, Math.ceil(ms - TOKEN_EPSILON));
    }
  }

  return {
    state: { tokens, updatedAt },
    result: { ok: false, remaining: tokens, retryAfterMs },
  };
}

/**
 * Drop hits that are `windowMs` old, then admit `count` or report when it fits.
 * A hit at time `at` counts while `now - at < windowMs`.
 */
export function applyWindowTake(
  hits: readonly WindowHit[],
  count: number,
  at: number,
  windowMs: number,
  max: number,
): { hits: WindowHit[]; result: Decision } {
  const oldestKept = at - windowMs;
  const kept: WindowHit[] = [];
  for (const hit of hits) {
    if (hit.at > oldestKept) {
      kept.push(hit);
    }
  }
  kept.sort((left, right) => left.at - right.at);

  let used = 0;
  for (const hit of kept) {
    used += hit.weight;
  }

  if (used + count <= max) {
    const next = kept.concat({ at, weight: count });
    next.sort((left, right) => left.at - right.at);
    return {
      hits: next,
      result: { ok: true, remaining: max - used - count, retryAfterMs: 0 },
    };
  }

  let need = used + count - max;
  let retryAfterMs = Number.POSITIVE_INFINITY;
  for (const hit of kept) {
    need -= hit.weight;
    if (need <= 0) {
      const ms = hit.at + windowMs - at;
      retryAfterMs = Math.max(1, Math.ceil(ms - TOKEN_EPSILON));
      break;
    }
  }

  return {
    hits: kept,
    result: { ok: false, remaining: max - used, retryAfterMs },
  };
}

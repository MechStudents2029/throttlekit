import type { TakeResult } from "./limiter.js";

/**
 * `X-RateLimit-*` and `Retry-After` values produced from one limiter decision.
 * Header values are strings, ready for `writeHead` or `setHeader`.
 * `Retry-After` is present only when the take was denied and a finite wait exists.
 * `X-RateLimit-Reset` is omitted when that wait is not finite.
 */
export type RateLimitHeaders = {
  "X-RateLimit-Limit": string;
  "X-RateLimit-Remaining": string;
  "X-RateLimit-Reset"?: string;
  "Retry-After"?: string;
};

/** Limit advertised beside a `TakeResult`. */
export type RateLimitHeaderMeta = {
  /**
   * Configured maximum: token-bucket `capacity` or sliding-window `max`.
   * Fractional values are floored so the header counts whole request units.
   */
  limit: number;
  /**
   * Unix epoch milliseconds when the decision was made.
   * Defaults to `Date.now()`. Tests pass a fixed clock.
   * `X-RateLimit-Reset` is this instant, plus `retryAfterMs` when the take was denied.
   */
  nowMs?: number;
};

function wholeUnits(name: string, value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite number greater than or equal to 0`);
  }
  const whole = Math.floor(value);
  if (!Number.isSafeInteger(whole)) {
    throw new Error(`${name} is too large to encode as a header`);
  }
  return whole;
}

function assertRetryAfter(value: number): void {
  if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
    throw new Error("retryAfterMs must be a non-negative number or Infinity");
  }
}

function unixSeconds(ms: number): string {
  if (!Number.isFinite(ms)) {
    throw new Error("reset time must be finite");
  }
  const seconds = Math.ceil(ms / 1000);
  if (!Number.isSafeInteger(seconds)) {
    throw new Error("reset time is too large to encode as a header");
  }
  return String(seconds);
}

function retryAfterSeconds(retryAfterMs: number): string {
  const seconds = Math.ceil(retryAfterMs / 1000);
  if (!Number.isSafeInteger(seconds)) {
    throw new Error("retryAfterMs is too large to encode as a header");
  }
  return String(seconds);
}

/**
 * Map a `tryTake` decision onto the de facto rate-limit response headers.
 *
 * - `X-RateLimit-Limit` is `meta.limit`, floored to a whole unit.
 * - `X-RateLimit-Remaining` is `decision.remaining`, floored so a partial token
 *   is not advertised as another request.
 * - `X-RateLimit-Reset` is Unix epoch seconds when the same take could succeed:
 *   `nowMs` when `ok` is true, otherwise `nowMs + retryAfterMs`. Seconds are
 *   rounded up so the timestamp is not earlier than the wait.
 * - `Retry-After` is that wait in delay-seconds (RFC 9110), only when the take
 *   was denied and `retryAfterMs` is finite. `Infinity` (a bucket that will
 *   never refill) omits both `Retry-After` and `X-RateLimit-Reset`.
 */
export function rateLimitHeaders(
  decision: TakeResult,
  meta: RateLimitHeaderMeta,
): RateLimitHeaders {
  if (typeof decision.ok !== "boolean") {
    throw new Error("ok must be a boolean");
  }
  assertRetryAfter(decision.retryAfterMs);

  const nowMs = meta.nowMs ?? Date.now();
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
    throw new Error("nowMs must be a finite number");
  }

  const headers: RateLimitHeaders = {
    "X-RateLimit-Limit": String(wholeUnits("limit", meta.limit)),
    "X-RateLimit-Remaining": String(wholeUnits("remaining", decision.remaining)),
  };

  if (decision.ok) {
    headers["X-RateLimit-Reset"] = unixSeconds(nowMs);
    return headers;
  }

  if (!Number.isFinite(decision.retryAfterMs)) {
    return headers;
  }

  headers["Retry-After"] = retryAfterSeconds(decision.retryAfterMs);
  headers["X-RateLimit-Reset"] = unixSeconds(nowMs + decision.retryAfterMs);
  return headers;
}

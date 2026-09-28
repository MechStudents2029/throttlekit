import { describe, expect, it } from "vitest";
import { createLimiter, rateLimitHeaders } from "../src/index.js";

const NOW_MS = 1_700_000_000_000;
const NOW_SECONDS = "1700000000";

describe("rateLimitHeaders", () => {
  it("maps an allowed tryTake onto limit, remaining, and reset", () => {
    const limiter = createLimiter({
      capacity: 2,
      refillPerSecond: 1,
      clock: { now: () => NOW_MS },
    });

    const decision = limiter.tryTake();
    expect(decision).toEqual({ ok: true, remaining: 1, retryAfterMs: 0 });
    expect(rateLimitHeaders(decision, { limit: 2, nowMs: NOW_MS })).toEqual({
      "X-RateLimit-Limit": "2",
      "X-RateLimit-Remaining": "1",
      "X-RateLimit-Reset": NOW_SECONDS,
    });
  });

  it("maps a denied tryTake onto Retry-After and a later reset", () => {
    const limiter = createLimiter({
      capacity: 1,
      refillPerSecond: 1,
      clock: { now: () => NOW_MS },
    });
    limiter.tryTake();

    const decision = limiter.tryTake();
    expect(decision).toEqual({ ok: false, remaining: 0, retryAfterMs: 1000 });
    expect(rateLimitHeaders(decision, { limit: 1, nowMs: NOW_MS })).toEqual({
      "X-RateLimit-Limit": "1",
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Reset": "1700000001",
      "Retry-After": "1",
    });
  });

  it("uses the sliding-window max as the advertised limit", () => {
    const limiter = createLimiter({
      strategy: "sliding-window",
      windowMs: 10_000,
      max: 5,
      clock: { now: () => NOW_MS },
    });

    const decision = limiter.tryTake();
    expect(rateLimitHeaders(decision, { limit: 5, nowMs: NOW_MS })).toEqual({
      "X-RateLimit-Limit": "5",
      "X-RateLimit-Remaining": "4",
      "X-RateLimit-Reset": NOW_SECONDS,
    });
  });

  it("floors fractional limit and remaining to whole request units", () => {
    expect(
      rateLimitHeaders(
        { ok: true, remaining: 1.9, retryAfterMs: 0 },
        { limit: 10.8, nowMs: NOW_MS },
      ),
    ).toEqual({
      "X-RateLimit-Limit": "10",
      "X-RateLimit-Remaining": "1",
      "X-RateLimit-Reset": NOW_SECONDS,
    });
  });

  it("rounds the reset second and Retry-After up so the client does not retry early", () => {
    expect(
      rateLimitHeaders(
        { ok: false, remaining: 0, retryAfterMs: 1500 },
        { limit: 5, nowMs: NOW_MS },
      ),
    ).toEqual({
      "X-RateLimit-Limit": "5",
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Reset": "1700000002",
      "Retry-After": "2",
    });
  });

  it("omits Retry-After and X-RateLimit-Reset when the limiter can never admit the take", () => {
    const headers = rateLimitHeaders(
      { ok: false, remaining: 0, retryAfterMs: Number.POSITIVE_INFINITY },
      { limit: 1, nowMs: NOW_MS },
    );

    expect(headers).toEqual({
      "X-RateLimit-Limit": "1",
      "X-RateLimit-Remaining": "0",
    });
    expect(headers).not.toHaveProperty("Retry-After");
    expect(headers).not.toHaveProperty("X-RateLimit-Reset");
  });

  it("defaults nowMs to the current time", () => {
    const before = Date.now();
    const headers = rateLimitHeaders(
      { ok: true, remaining: 1, retryAfterMs: 0 },
      { limit: 2 },
    );
    const after = Date.now();
    const reset = Number(headers["X-RateLimit-Reset"]);

    expect(reset).toBeGreaterThanOrEqual(Math.ceil(before / 1000));
    expect(reset).toBeLessThanOrEqual(Math.ceil(after / 1000));
    expect(headers).not.toHaveProperty("Retry-After");
  });

  it("rejects inputs that cannot be encoded as headers", () => {
    const decision = { ok: true, remaining: 1, retryAfterMs: 0 };
    expect(() => rateLimitHeaders(decision, { limit: -1, nowMs: NOW_MS })).toThrow(
      /limit/,
    );
    expect(() =>
      rateLimitHeaders(
        { ok: false, remaining: -1, retryAfterMs: 0 },
        { limit: 1, nowMs: NOW_MS },
      ),
    ).toThrow(/remaining/);
    expect(() =>
      rateLimitHeaders(
        { ok: false, remaining: 0, retryAfterMs: -5 },
        { limit: 1, nowMs: NOW_MS },
      ),
    ).toThrow(/retryAfterMs/);
    expect(() => rateLimitHeaders(decision, { limit: 1, nowMs: Number.NaN })).toThrow(
      /nowMs/,
    );
  });
});

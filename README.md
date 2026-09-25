# ThrottleKit

Resume-grade TypeScript rate-limiting toolkit: token bucket, sliding window, standard rate-limit headers, and a tiny HTTP demo against a free public API.

Free/local only. No paid APIs.

## Status

**Day 1** lands the core token-bucket limiter (`createLimiter`, `tryTake`, `wait`) and Vitest unit tests. The bucket starts full, refills continuously (fractional tokens included), and takes an injectable clock so tests do not use real timers.

**Day 2** adds a sliding-window counter on the same surface. Pass `strategy: "sliding-window"` with `windowMs` and `max`. Omit `strategy`, or pass `"token-bucket"`, to keep the Day 1 bucket.

Days 3–5 are still ahead: optional Redis, rate-limit headers plus a JSONPlaceholder demo, then benchmarks and README polish. See `WEEK_PLAN.md`.
Day 1 is on main as of 2026-09-24 and stays as shipped.
Day 2 is on main as of 2026-09-25 and stays as shipped.

## Setup

```bash
npm install
```

## Tests

```bash
npm test
```

Typecheck / emit:

```bash
npm run build
```

Watch mode: `npm run test:watch`.

## Usage

```ts
import { createLimiter } from "throttlekit";

const limiter = createLimiter({
  capacity: 10,
  refillPerSecond: 2,
});

const result = limiter.tryTake();
if (!result.ok) {
  // result.retryAfterMs is how long until one token is available.
  // result.remaining is the current (possibly fractional) balance.
  await limiter.wait();
}
```

`tryTake(n)` removes `n` tokens (default `1`) or leaves the bucket unchanged. `wait(n)` takes the same way, sleeping via the clock until the refill covers the cost. Pass `clock: { now, sleep }` to drive time yourself. `capacity` is the maximum balance. A cost larger than `capacity` throws, because that take can never succeed.

### Sliding window

```ts
const windowLimiter = createLimiter({
  strategy: "sliding-window",
  windowMs: 10_000,
  max: 5,
});

const decision = windowLimiter.tryTake();
if (!decision.ok) {
  // decision.retryAfterMs is when enough earlier requests age out.
  // decision.remaining is how many more units still fit in this window.
  await windowLimiter.wait();
}
```

Each admitted take is stored with its timestamp and cost. It counts until it is `windowMs` old, then drops out and frees that many units. `tryTake(n)` costs `n` units (default `1`). `n` or `max` must be a positive integer; a cost larger than `max` throws, because that take can never succeed.

## Week plan

See `WEEK_PLAN.md`. Days 3–5 are not implemented yet. Next slice is Day 3 (optional Redis), still not started as of 2026-09-25.

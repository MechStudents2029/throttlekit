# ThrottleKit

Resume-grade TypeScript rate-limiting toolkit: token bucket, sliding window, an optional Redis store, standard rate-limit headers, and a tiny HTTP demo against a free public API.

Free/local only. No paid APIs.

## Status

Days 1–5 are on main and frozen. Day 5 squash-merged 2026-09-29 (`0c0853e`). See `WEEK_PLAN.md`.

- **Day 1** (2026-09-24) — token bucket: `createLimiter`, `tryTake`, `wait`, injectable clock.
- **Day 2** (2026-09-25) — sliding window on the same surface (`strategy: "sliding-window"`).
- **Day 3** (2026-09-27) — `LimiterStore`, `createMemoryStore`, `createRedisStore`, `createDistributedLimiter`.
- **Day 4** (2026-09-28) — `rateLimitHeaders` and the JSONPlaceholder demo.
- **Day 5** (2026-09-29) — in-memory microbench (`npm run bench`), architecture notes, and resume bullets. On main as `0c0853e`.

## Setup

```bash
npm install
```

Optional local Redis, for shared counters across processes:

```bash
docker compose up -d
```

That publishes Redis at `redis://127.0.0.1:6379`. Set `REDIS_URL` to point somewhere else on localhost. `npm test` still passes when Redis is down: the Redis client is covered with a mock, and the live test skips.

## Tests

```bash
npm test
```

Typecheck / emit:

```bash
npm run build
```

Watch mode: `npm run test:watch`.

In-memory microbench (no Redis, no network):

```bash
npm run bench
```

That runs Vitest bench (`vitest bench --run`) against [`bench/microbench.bench.ts`](bench/microbench.bench.ts), which `vitest.config.ts` includes as `bench/**/*.bench.ts`. It times the allowed `tryTake` path for the token bucket and the sliding window, `rateLimitHeaders` on a fixed decision, and `createDistributedLimiter` with `createMemoryStore`. Each bench injects a clock and steps it by a fixed amount, so the run does not sleep and stays on the allowed path. Case setup, and the fact that timings are not checked in, is in [`BENCH.md`](BENCH.md).

## Architecture

Strategies, storage, and headers meet on one `TakeResult` (`ok`, `remaining`, `retryAfterMs`):

1. **Strategy.** `createLimiter` keeps the counter in the process. Omit `strategy` for a token bucket (`capacity`, `refillPerSecond`). Pass `strategy: "sliding-window"` for a rolling count (`windowMs`, `max`). Both return the same decision.
2. **Store.** `createDistributedLimiter` applies those same rules, but reads and writes the counter through a `LimiterStore` at `throttlekit:<key>`. `createMemoryStore` stays in one process. `createRedisStore` is the optional local Redis backend when several processes share a key. `createLimiter` does not use a store.
3. **Headers.** `rateLimitHeaders` does not admit or deny. It turns a decision into `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `Retry-After` when the take was denied. The demo server is that path in front of JSONPlaceholder: one in-memory sliding window, then those headers.

## Resume bullets

- Built a TypeScript rate limiter with token-bucket and sliding-window strategies and an injectable clock, so admission rules can be tested without real timers.
- Separated the decision rules from storage, so the same limits run in memory or on local Redis without a second implementation.
- Mapped each decision to standard `X-RateLimit-*` and `Retry-After` headers and showed them on a small local proxy in front of a public API.
- Added an in-memory microbench (`npm run bench`) for token-bucket `tryTake`, sliding-window `tryTake`, `rateLimitHeaders` on an allowed decision, and `createDistributedLimiter` with `createMemoryStore`, with no Redis and no network. Setup is in `BENCH.md`.

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

### Shared store

`createDistributedLimiter` is the async form of the same two strategies. Pass a store and a `key`. Every limiter using that store and key shares one counter. `tryTake` returns a promise.

```ts
import {
  createDistributedLimiter,
  createMemoryStore,
  createRedisStore,
} from "throttlekit";

const memory = createMemoryStore();
const local = createDistributedLimiter({
  store: memory,
  key: "checkout",
  capacity: 10,
  refillPerSecond: 2,
});

const redis = createRedisStore(); // REDIS_URL or redis://127.0.0.1:6379
const shared = createDistributedLimiter({
  store: redis,
  key: "checkout",
  strategy: "sliding-window",
  windowMs: 10_000,
  max: 5,
});

const decision = await shared.tryTake();
if (!decision.ok) {
  await shared.wait();
}

await redis.close();
```

A client you pass to `createRedisStore({ client })` stays yours: ThrottleKit will not connect or close it. Omit `client` and call `close()` when the process is done. The counter is stored at `throttlekit:<key>`. A sliding-window key expires `windowMs` after the last update. A token-bucket key is not given a TTL, so an empty bucket is not treated as full just because Redis dropped it. A missing key starts as a full bucket or an empty window.

### Rate-limit headers

`rateLimitHeaders` reads a `tryTake` result. Pass the same maximum you configured (`capacity` or `max`) as `limit`. `nowMs` defaults to `Date.now()`; pass a fixed value in tests.

```ts
import { createLimiter, rateLimitHeaders } from "throttlekit";

const limiter = createLimiter({ capacity: 10, refillPerSecond: 2 });
const decision = limiter.tryTake();
const headers = rateLimitHeaders(decision, { limit: 10 });

headers["X-RateLimit-Limit"]; // "10"
headers["X-RateLimit-Remaining"]; // whole units still available
headers["X-RateLimit-Reset"]; // Unix seconds when this take could succeed
// headers["Retry-After"] is set only when decision.ok is false
// and retryAfterMs is finite (delay-seconds).
```

`X-RateLimit-Remaining` floors fractional tokens, so a partial token is not advertised as another request. On an allowed take, `X-RateLimit-Reset` is the decision time in Unix seconds. On a denial it is `now + retryAfterMs`, rounded up to a whole Unix second. `Retry-After` is that wait in whole seconds. When `retryAfterMs` is `Infinity` (a bucket that will never refill), both `Retry-After` and `X-RateLimit-Reset` are omitted.

### HTTP demo

The demo is a local Node `http` server. It allows 5 requests per 10 seconds, then proxies the path to `https://jsonplaceholder.typicode.com` (for example `/todos/1` or `/posts`). No API key. Build first so the server can import `dist/`.

```bash
npm run build
npm run demo
```

`PORT` defaults to `3000`.

```bash
curl -i http://127.0.0.1:3000/todos/1
```

An allowed response forwards the upstream JSON and sets `X-RateLimit-*`. The next request past the limit is `429` with those headers and `Retry-After`.

## Week plan

See `WEEK_PLAN.md`. Days 1–5 are on main and frozen. Day 5 (benchmarks and README polish) squash-merged 2026-09-29 (`0c0853e`).

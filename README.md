# ThrottleKit

Resume-grade TypeScript rate-limiting toolkit: token bucket, sliding window, an optional Redis store, standard rate-limit headers, and a tiny HTTP demo against a free public API.

Free/local only. No paid APIs.

## Status

**Day 1** lands the core token-bucket limiter (`createLimiter`, `tryTake`, `wait`) and Vitest unit tests. The bucket starts full, refills continuously (fractional tokens included), and takes an injectable clock so tests do not use real timers.

**Day 2** adds a sliding-window counter on the same surface. Pass `strategy: "sliding-window"` with `windowMs` and `max`. Omit `strategy`, or pass `"token-bucket"`, to keep the Day 1 bucket.

**Day 3** adds an optional shared store. `createLimiter` stays synchronous and in-memory. `createDistributedLimiter` keeps the same rules, but the counter lives in a `LimiterStore`: `createMemoryStore` in one process, or `createRedisStore` when several processes must share a counter. Local Redis only (`docker compose up -d`, or `REDIS_URL`). No paid APIs.

**Day 4** adds `rateLimitHeaders`, which turns a `tryTake` decision into `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `Retry-After` when the take is denied. A small local server (`npm run demo` after `npm run build`) sits `createLimiter` in front of JSONPlaceholder.

Day 5 (benchmarks and README polish) is still ahead. See `WEEK_PLAN.md`.
Day 1 is on main as of 2026-09-24 and stays as shipped.
Day 2 is on main as of 2026-09-25 and stays as shipped.
Day 3 is on main as of 2026-09-27 and stays as shipped.
Day 4 shipped 2026-09-28. Day 5 is unstarted. Days 1–3 limiter behavior stays as shipped.

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

See `WEEK_PLAN.md`. Day 4 (headers and the JSONPlaceholder demo) shipped 2026-09-28. Day 5 (benchmarks and README polish) is unstarted.

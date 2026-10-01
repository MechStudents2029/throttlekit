# ThrottleKit — weekday slices (credit-light)

## Day 1 — Core token bucket ✅
- `createLimiter` / `tryTake` / `wait` API
- Configurable capacity + refill rate
- Injectable clock for deterministic tests
- Vitest unit tests
- Merged on main 2026-09-24; no further Day 1 behavior changes.

## Day 2 — Sliding window ✅
- Sliding-window counter strategy
- Compare / switch strategies via options (`strategy: "token-bucket" | "sliding-window"`)
- Tests for edge windows
- Shipped 2026-09-25. Token bucket stays the default when `strategy` is omitted.
- Merged on main 2026-09-25; no further Day 2 behavior changes.

## Day 3 — Distributed backend (optional Redis) ✅
- `LimiterStore` interface. `createMemoryStore` is the in-process store. `createRedisStore` is optional.
- `docker-compose.yml` runs local Redis at `redis://127.0.0.1:6379`
- `createDistributedLimiter` shares token-bucket and sliding-window counters for one store and key
- Vitest covers the Redis client with a mock, and skips the live test when Redis is down
- Shipped 2026-09-28. `createLimiter` stays the synchronous in-memory default.
- Merged on main 2026-09-27; no further Day 3 behavior changes.

## Day 4 — Headers + tiny HTTP demo ✅
- `rateLimitHeaders` maps a `tryTake` decision onto `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `Retry-After` when denied
- Minimal local demo (`examples/demo-server`) proxies JSONPlaceholder behind `createLimiter`
- Vitest unit tests for the header helpers (no network)
- Shipped 2026-09-28. Days 1–3 limiter and store behavior unchanged.
- Merged on main 2026-09-28; no further Day 4 header or demo behavior changes.

## Day 5 — Benchmarks + README polish ✅
- In-memory Vitest microbench (`npm run bench`): token-bucket `tryTake`, sliding-window `tryTake`, `rateLimitHeaders` on a decision, and `createDistributedLimiter` with `createMemoryStore`
- Architecture section and resume bullets in the README
- Shipped 2026-09-29. Days 1–4 limiter, store, header, and demo behavior unchanged.
- Merged on main 2026-09-29 (0c0853e); no further Day 5 bench or README behavior changes.

## Next project — dry-run CLI ✅

Days 1–5 are on main. Admission, store, header, demo, and bench behavior stay frozen.

- A small CLI (`examples/dry-run-cli`, `npm run dry-run`) takes limiter options (`capacity` and `refillPerSecond`, or `strategy: "sliding-window"` with `windowMs` and `max`) and prints one `tryTake` decision.
- It calls the existing `createLimiter`. It does not add a strategy, a store, or a header format.
- Shipped 2026-10-01. Days 1–5 limiter, store, header, demo, and bench behavior unchanged.

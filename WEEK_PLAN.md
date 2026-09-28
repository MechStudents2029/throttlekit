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

## Day 4 — Headers + tiny HTTP demo
- `X-RateLimit-*` / `Retry-After` helpers
- Minimal local demo server using a free public API (JSONPlaceholder) behind the limiter

## Day 5 — Benchmarks + README polish
- Microbench script
- Architecture + resume bullets

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

## Day 3 — Distributed backend (optional Redis)
- docker-compose Redis
- Redis-backed limiter
- Integration tests skip if Redis down
- Status 2026-09-25: not started.

## Day 4 — Headers + tiny HTTP demo
- `X-RateLimit-*` / `Retry-After` helpers
- Minimal local demo server using a free public API (JSONPlaceholder) behind the limiter

## Day 5 — Benchmarks + README polish
- Microbench script
- Architecture + resume bullets

# Shipping log

- 2026-09-24 — repo scaffold; start Day 1 (token bucket).
- 2026-09-24 — Day 1: token-bucket limiter (`createLimiter`, `tryTake`, `wait`) and Vitest tests.
- 2026-09-24 — Day 1 squash-merged on main (5e67716); token-bucket behavior left as shipped.
- 2026-09-24 — Day 2 sliding-window slice is still unstarted.
- 2026-09-25 — Day 2: sliding-window limiter (`strategy: "sliding-window"`, `windowMs`, `max`) and edge-window Vitest tests.
- 2026-09-25 — Day 2 squash-merged on main (17c222b); sliding-window behavior left as shipped.
- 2026-09-25 — Day 3 optional Redis backend is next and still unstarted.
- 2026-09-28 — Day 3: shared limiter store (`createMemoryStore`, `createRedisStore`, `createDistributedLimiter`). In-memory `createLimiter` stays the default.
- 2026-09-28 — Day 3: Redis compare-and-set covered by a mock client; live Vitest skips when Redis is down. Local Redis is `docker compose up -d`.
- 2026-09-27 — Day 3 squash-merged on main (4d6eaff); distributed limiter store left as shipped.
- 2026-09-27 — Day 3 keeps `createLimiter` as the synchronous in-memory default; that behavior is frozen.

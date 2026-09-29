# Bench notes

`npm run bench` runs `vitest bench --run`. `vitest.config.ts` includes `bench/**/*.bench.ts`. The only bench file is `bench/microbench.bench.ts`.

The run stays in memory. It does not open Redis, the network, or `sleep`. Each `tryTake` bench injects a clock and moves that clock forward before the take so the call stays allowed. If a take is denied, the bench throws and the run fails.

| Bench name | What it times |
| --- | --- |
| `token-bucket tryTake allowed` | `createLimiter` with `capacity: 10` and `refillPerSecond: 1000`. The clock starts at `0` and advances `1` ms on every call. |
| `sliding-window tryTake allowed` | `strategy: "sliding-window"`, `windowMs: 1000`, `max: 8`. The clock advances `windowMs / max` (`125` ms) on every call. |
| `rateLimitHeaders on an allowed decision` | One allowed token-bucket take at `now` `1700000000000`, then `rateLimitHeaders` with `limit: 10` and that same `nowMs`. The timed loop only builds the header map. |
| `createDistributedLimiter memory tryTake allowed` | `createMemoryStore` under the key `bench-token-bucket`, with the same capacity and refill as the token-bucket bench. The clock advances `1` ms on every call. |

A `sink` read of `remaining` (or of the remaining-header length) keeps the result live so the timed call is not dropped.

Timings are local to the machine that runs the script. This repo does not check in an ops/sec sample. Run `npm run bench` on that machine to see numbers.

# Dry-run notes

`npm run dry-run` runs `node examples/dry-run-cli/cli.mjs`. It calls the existing `createLimiter` and prints one `tryTake` decision. It does not open Redis or the network, and it does not add a strategy, a store, or a header format. Run `npm run build` first. If `dist/index.js` cannot be loaded, the script exits 1 with `could not load dist/index.js; run npm run build first`.

## Flags

| Flag | Role |
| --- | --- |
| `--capacity <n>` | Token-bucket maximum. Required when `--strategy` is omitted or is `token-bucket`. |
| `--refill-per-second <n>` | Token-bucket refill rate. Required with `--capacity`. The limiter accepts `0`. |
| `--strategy token-bucket` | Optional. Same options as omitting `--strategy`. |
| `--strategy sliding-window` | Requires `--window-ms` and `--max`. |
| `--window-ms <ms>` | Sliding-window length. Rejected on the token-bucket form. |
| `--max <n>` | Sliding-window maximum. Rejected on the token-bucket form. |
| `--n <units>` | Take size passed to `tryTake`. Default `1`. |
| `--help`, `-h` | Print usage on stdout and exit 0. |

A value is a separate argument (`--capacity 10`). `--capacity=10` exits 1 as an unexpected argument. A missing value, a repeated flag, an unknown name, or a non-finite number exits 1. Token-bucket flags reject `--window-ms` and `--max`. Sliding-window flags reject `--capacity` and `--refill-per-second`. The message is `--<name> does not apply to this strategy`. With no arguments, usage is printed on stderr and the process exits 1.

## Output shape

Stdout is one JSON object with a two-space indent. The keys are always in this order:

| Field | Meaning |
| --- | --- |
| `decision` | `"allowed"` when `ok` is true, otherwise `"denied"`. |
| `ok` | The `tryTake` boolean. |
| `remaining` | Tokens left, or window units still free, after the call. |
| `retryAfterMs` | `0` when the take was allowed. Otherwise the wait until a later take could succeed. `Infinity` and `-Infinity` are the JSON strings `"Infinity"` and `"-Infinity"`. |

A printed decision exits 0. A cost that can never succeed throws before a decision is printed: `n (11) exceeds capacity (10)` on a token bucket, or `n (6) exceeds max (5)` on a sliding window. That error goes to stderr and the process exits 1. It is not a `denied` object.

The process builds a new limiter and calls `tryTake` once. A fresh token bucket starts full, so refill does not change the first take, and `remaining` is `capacity` minus `--n`. A fresh sliding window starts empty, so a cost that fits is allowed and `remaining` is `max` minus `--n`. The README examples (`capacity` 10 taking 1, and `max` 5 taking 1) print `remaining` 9 and 4. Capacity 10 with `--n 3` prints `remaining` 7.

## Commands

```bash
npm run build
npm run dry-run -- --capacity 10 --refill-per-second 2
npm run dry-run -- --strategy sliding-window --window-ms 10000 --max 5
npm run dry-run -- --capacity 10 --refill-per-second 2 --n 3
npm run dry-run -- --help
```

/**
 * Dry-run one `tryTake` on the existing in-memory `createLimiter`, then
 * print `rateLimitHeaders` for that decision.
 *
 *   npm run build
 *   npm run dry-run -- --capacity 10 --refill-per-second 2
 *   npm run dry-run -- --strategy sliding-window --window-ms 10000 --max 5
 *
 * Prints one JSON object: `allowed` or `denied`, plus `ok`, `remaining`,
 * `retryAfterMs`, and `headers`. Headers come from `rateLimitHeaders` with
 * `limit` set to the same maximum the command took (`--capacity` or `--max`):
 * `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and
 * `Retry-After` when the take is denied. Every successful dry-run includes
 * that map. There is no second script and no extra flag. No new strategy,
 * store, or header format.
 */
const USAGE = `Usage:
  npm run dry-run -- --capacity <n> --refill-per-second <n> [--n <units>]
  npm run dry-run -- --strategy token-bucket --capacity <n> --refill-per-second <n> [--n <units>]
  npm run dry-run -- --strategy sliding-window --window-ms <ms> --max <n> [--n <units>]

Prints one tryTake decision as JSON, including rateLimitHeaders for it:
  decision      "allowed" when ok is true, otherwise "denied"
  ok            whether this take was admitted
  remaining     capacity left after the call
  retryAfterMs  0 when allowed; otherwise the wait until a later take could succeed
  headers       rateLimitHeaders(decision, { limit }) where limit is --capacity
                or --max. Keys are X-RateLimit-Limit, X-RateLimit-Remaining,
                X-RateLimit-Reset, and Retry-After when the take is denied
                and the wait is finite. Printed on every successful dry-run.

Run npm run build first so this file can import dist/.
A fresh limiter starts full (token bucket) or empty (sliding window), so the
first take is allowed when the cost fits. That allowed take omits Retry-After.`;

const KNOWN = new Set([
  "strategy",
  "capacity",
  "refill-per-second",
  "window-ms",
  "max",
  "n",
]);

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  if (argv.length === 0) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(1);
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--") || arg.includes("=") || arg.length === 2) {
      fail(`unexpected argument ${arg}`);
    }
    const name = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`missing value for --${name}`);
    }
    if (flags.has(name)) {
      fail(`duplicate --${name}`);
    }
    flags.set(name, value);
    i += 1;
  }
  return flags;
}

function assertKnown(flags) {
  for (const name of flags.keys()) {
    if (!KNOWN.has(name)) {
      fail(`unknown option --${name}`);
    }
  }
}

function readNumber(flags, name) {
  const raw = flags.get(name);
  if (raw === undefined) {
    return undefined;
  }
  if (raw.trim() === "") {
    fail(`--${name} must be a finite number`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    fail(`--${name} must be a finite number`);
  }
  return value;
}

function requireNumber(flags, name) {
  if (!flags.has(name)) {
    fail(`missing --${name}`);
  }
  return readNumber(flags, name);
}

function rejectIfPresent(flags, names) {
  for (const name of names) {
    if (flags.has(name)) {
      fail(`--${name} does not apply to this strategy`);
    }
  }
}

function limiterOptions(flags) {
  const strategy = flags.get("strategy");
  if (strategy === undefined || strategy === "token-bucket") {
    rejectIfPresent(flags, ["window-ms", "max"]);
    const capacity = requireNumber(flags, "capacity");
    const refillPerSecond = requireNumber(flags, "refill-per-second");
    if (strategy === "token-bucket") {
      return { strategy: "token-bucket", capacity, refillPerSecond };
    }
    return { capacity, refillPerSecond };
  }
  if (strategy === "sliding-window") {
    rejectIfPresent(flags, ["capacity", "refill-per-second"]);
    return {
      strategy: "sliding-window",
      windowMs: requireNumber(flags, "window-ms"),
      max: requireNumber(flags, "max"),
    };
  }
  return { strategy };
}

function configuredLimit(options) {
  return options.strategy === "sliding-window" ? options.max : options.capacity;
}

function printDecision(result, headers) {
  const payload = {
    decision: result.ok ? "allowed" : "denied",
    ok: result.ok,
    remaining: result.remaining,
    retryAfterMs: result.retryAfterMs,
    headers,
  };
  const json = JSON.stringify(
    payload,
    (_key, value) => (value === Infinity || value === -Infinity ? String(value) : value),
    2,
  );
  process.stdout.write(`${json}\n`);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  assertKnown(flags);
  const options = limiterOptions(flags);
  const n = flags.has("n") ? readNumber(flags, "n") : undefined;

  let createLimiter;
  let rateLimitHeaders;
  try {
    ({ createLimiter, rateLimitHeaders } = await import("../../dist/index.js"));
  } catch {
    fail("could not load dist/index.js; run npm run build first");
  }

  const limiter = createLimiter(options);
  const result = n === undefined ? limiter.tryTake() : limiter.tryTake(n);
  const headers = rateLimitHeaders(result, { limit: configuredLimit(options) });
  printDecision(result, headers);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
});

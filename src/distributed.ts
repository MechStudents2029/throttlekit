import {
  applyBucketTake,
  applyWindowTake,
  type BucketState,
  type WindowHit,
} from "./decide.js";
import type {
  Clock,
  LimiterOptions,
  SlidingWindowOptions,
  TakeResult,
  TokenBucketOptions,
} from "./limiter.js";
import type { LimiterStore } from "./store.js";

/** Async limiter backed by a `LimiterStore`. */
export type AsyncLimiter = {
  tryTake(n?: number): Promise<TakeResult>;
  /** Resolve once `n` units have been taken. Uses `clock.sleep` while waiting. */
  wait(n?: number): Promise<void>;
};

export type DistributedLimiterOptions = LimiterOptions & {
  /** Counter backend. Use `createMemoryStore` or `createRedisStore`. */
  store: LimiterStore;
  /**
   * Name shared by every limiter that should share this counter.
   * Stored under `throttlekit:<key>`.
   */
  key: string;
};

const KEY_PREFIX = "throttlekit:";
const STATE_VERSION = 1;

type BucketWire = {
  v: typeof STATE_VERSION;
  kind: "token-bucket";
  tokens: number;
  updatedAt: number;
};

type WindowWire = {
  v: typeof STATE_VERSION;
  kind: "sliding-window";
  hits: WindowHit[];
};

function assertFiniteNumber(name: string, value: number): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
}

function assertPositive(name: string, value: number): void {
  assertFiniteNumber(name, value);
  if (value <= 0) {
    throw new Error(`${name} must be greater than 0`);
  }
}

function assertNonNegative(name: string, value: number): void {
  assertFiniteNumber(name, value);
  if (value < 0) {
    throw new Error(`${name} must be greater than or equal to 0`);
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function systemSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function storageKeyFor(key: string): string {
  if (typeof key !== "string" || key.trim() === "") {
    throw new Error("key must be a non-empty string");
  }
  return KEY_PREFIX + key;
}

function invalidState(key: string): Error {
  return new Error(`invalid limiter state at "${key}"`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseWire(raw: string, key: string): BucketWire | WindowWire {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidState(key);
  }
  if (!isRecord(parsed) || parsed.v !== STATE_VERSION) {
    throw invalidState(key);
  }
  if (parsed.kind === "token-bucket") {
    if (typeof parsed.tokens !== "number" || !Number.isFinite(parsed.tokens)) {
      throw invalidState(key);
    }
    if (typeof parsed.updatedAt !== "number" || !Number.isFinite(parsed.updatedAt)) {
      throw invalidState(key);
    }
    return {
      v: STATE_VERSION,
      kind: "token-bucket",
      tokens: parsed.tokens,
      updatedAt: parsed.updatedAt,
    };
  }
  if (parsed.kind === "sliding-window") {
    if (!Array.isArray(parsed.hits)) {
      throw invalidState(key);
    }
    const hits: WindowHit[] = [];
    for (const hit of parsed.hits) {
      if (
        !isRecord(hit) ||
        typeof hit.at !== "number" ||
        !Number.isFinite(hit.at) ||
        typeof hit.weight !== "number" ||
        !Number.isFinite(hit.weight) ||
        hit.weight <= 0
      ) {
        throw invalidState(key);
      }
      hits.push({ at: hit.at, weight: hit.weight });
    }
    return { v: STATE_VERSION, kind: "sliding-window", hits };
  }
  throw invalidState(key);
}

function readBucket(raw: string | null, key: string): BucketState | null {
  if (raw === null) {
    return null;
  }
  const wire = parseWire(raw, key);
  if (wire.kind !== "token-bucket") {
    throw new Error(`key "${key}" holds ${wire.kind} state, not token-bucket`);
  }
  return { tokens: wire.tokens, updatedAt: wire.updatedAt };
}

function readWindow(raw: string | null, key: string): WindowHit[] {
  if (raw === null) {
    return [];
  }
  const wire = parseWire(raw, key);
  if (wire.kind !== "sliding-window") {
    throw new Error(`key "${key}" holds ${wire.kind} state, not sliding-window`);
  }
  return wire.hits;
}

function encodeBucket(state: BucketState): string {
  const wire: BucketWire = {
    v: STATE_VERSION,
    kind: "token-bucket",
    tokens: state.tokens,
    updatedAt: state.updatedAt,
  };
  return JSON.stringify(wire);
}

function encodeWindow(hits: readonly WindowHit[]): string {
  const wire: WindowWire = {
    v: STATE_VERSION,
    kind: "sliding-window",
    hits: hits.map((hit) => ({ at: hit.at, weight: hit.weight })),
  };
  return JSON.stringify(wire);
}

function rejectStrategy(options: DistributedLimiterOptions): never {
  const strategy = (options as { strategy?: unknown }).strategy;
  throw new Error(
    `strategy must be "token-bucket" or "sliding-window" (received ${JSON.stringify(strategy)})`,
  );
}

function clockFns(clock: Clock | undefined): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
} {
  return {
    now: clock?.now ?? Date.now,
    sleep: clock?.sleep ?? systemSleep,
  };
}

/**
 * Rate limiter whose counter lives in `options.store`.
 * Two limiters that share a store and a `key` share one counter, including
 * across processes when the store is Redis. `createLimiter` stays the
 * synchronous in-memory default and does not use this path.
 */
export function createDistributedLimiter(options: DistributedLimiterOptions): AsyncLimiter {
  if (!options.store || typeof options.store.transact !== "function") {
    throw new Error("store must be a limiter store");
  }
  switch (options.strategy) {
    case "sliding-window":
      return createDistributedWindow(options);
    case "token-bucket":
    case undefined:
      return createDistributedBucket(options);
    default:
      return rejectStrategy(options);
  }
}

function createDistributedBucket(
  options: TokenBucketOptions & { store: LimiterStore; key: string },
): AsyncLimiter {
  assertPositive("capacity", options.capacity);
  assertNonNegative("refillPerSecond", options.refillPerSecond);
  const storageKey = storageKeyFor(options.key);

  const capacity = options.capacity;
  const refillPerSecond = options.refillPerSecond;
  const store = options.store;
  const label = options.key;
  const { now, sleep } = clockFns(options.clock);

  function takeCount(n: number | undefined): number {
    const count = n ?? 1;
    assertPositive("n", count);
    if (count > capacity) {
      throw new Error(`n (${count}) exceeds capacity (${capacity})`);
    }
    return count;
  }

  async function tryTake(n?: number): Promise<TakeResult> {
    const count = takeCount(n);
    return store.transact(storageKey, (current) => {
      const at = now();
      const decided = applyBucketTake(
        readBucket(current, label) ?? { tokens: capacity, updatedAt: at },
        count,
        at,
        capacity,
        refillPerSecond,
      );
      return {
        next: encodeBucket(decided.state),
        result: decided.result,
      };
    });
  }

  async function wait(n?: number): Promise<void> {
    for (;;) {
      const decision = await tryTake(n);
      if (decision.ok) {
        return;
      }
      if (!Number.isFinite(decision.retryAfterMs)) {
        throw new Error(
          "cannot wait for tokens: refillPerSecond is 0 and the bucket is short",
        );
      }
      await sleep(decision.retryAfterMs);
    }
  }

  return { tryTake, wait };
}

function createDistributedWindow(
  options: SlidingWindowOptions & { store: LimiterStore; key: string },
): AsyncLimiter {
  assertPositive("windowMs", options.windowMs);
  assertPositiveInteger("max", options.max);
  const storageKey = storageKeyFor(options.key);

  const windowMs = options.windowMs;
  const max = options.max;
  const store = options.store;
  const label = options.key;
  const { now, sleep } = clockFns(options.clock);
  const ttlMs = Math.max(1, Math.ceil(windowMs));

  function takeCount(n: number | undefined): number {
    const count = n ?? 1;
    assertPositiveInteger("n", count);
    if (count > max) {
      throw new Error(`n (${count}) exceeds max (${max})`);
    }
    return count;
  }

  async function tryTake(n?: number): Promise<TakeResult> {
    const count = takeCount(n);
    return store.transact(storageKey, (current) => {
      const decided = applyWindowTake(
        readWindow(current, label),
        count,
        now(),
        windowMs,
        max,
      );
      return {
        next: encodeWindow(decided.hits),
        ttlMs,
        result: decided.result,
      };
    });
  }

  async function wait(n?: number): Promise<void> {
    for (;;) {
      const decision = await tryTake(n);
      if (decision.ok) {
        return;
      }
      if (!Number.isFinite(decision.retryAfterMs)) {
        throw new Error("cannot wait: the sliding window cannot admit this take");
      }
      await sleep(decision.retryAfterMs);
    }
  }

  return { tryTake, wait };
}

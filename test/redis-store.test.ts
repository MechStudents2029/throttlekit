import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type RedisClientType } from "redis";
import {
  createDistributedLimiter,
  createRedisStore,
  type RedisCommandClient,
} from "../src/index.js";

const KEY_PREFIX = "throttlekit:";

type EvalRequest = {
  script: string;
  keys: string[];
  arguments: string[];
};

function createCasClient(options?: {
  conflicts?: number;
  conflictValue?: string;
  barrier?: boolean;
}) {
  const values = new Map<string, string>();
  const calls: EvalRequest[] = [];
  let conflictsLeft = options?.conflicts ?? 0;
  let started = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const client: RedisCommandClient = {
    async get(key: string): Promise<string | null> {
      if (options?.barrier) {
        started += 1;
        if (started >= 2) {
          release?.();
        }
        await gate;
      }
      return values.get(key) ?? null;
    },
    async eval(
      script: string,
      evalOptions: { keys: string[]; arguments: string[] },
    ): Promise<number> {
      calls.push({
        script,
        keys: evalOptions.keys,
        arguments: evalOptions.arguments,
      });
      const key = evalOptions.keys[0]!;
      const args = evalOptions.arguments;
      const current = values.get(key) ?? null;
      const expectMissing = args[0] === "0";
      const expected = args[1] ?? "";
      const matches = expectMissing ? current === null : current === expected;
      if (!matches) {
        return 0;
      }
      if (conflictsLeft > 0) {
        conflictsLeft -= 1;
        if (options?.conflictValue !== undefined) {
          values.set(key, options.conflictValue);
        }
        return 0;
      }
      if (args[2] === "0") {
        values.delete(key);
      } else {
        values.set(key, args[3] ?? "");
      }
      return 1;
    },
  };

  return { client, values, calls };
}

describe("redis store client", () => {
  it("shares a counter through compare-and-set and keeps the token bucket without a ttl", async () => {
    const redis = createCasClient();
    const store = createRedisStore({ client: redis.client });
    const clock = { now: () => 0 };
    const first = createDistributedLimiter({
      store,
      key: "api",
      capacity: 2,
      refillPerSecond: 1,
      clock,
    });
    const second = createDistributedLimiter({
      store,
      key: "api",
      capacity: 2,
      refillPerSecond: 1,
      clock,
    });

    expect(await first.tryTake()).toEqual({ ok: true, remaining: 1, retryAfterMs: 0 });
    expect(await second.tryTake()).toEqual({ ok: true, remaining: 0, retryAfterMs: 0 });
    expect(redis.calls.length).toBeGreaterThan(0);
    expect(redis.calls[0]?.script).toContain("redis.call('GET'");
    expect(redis.calls[0]?.script).toContain("PX");
    expect(redis.calls[0]?.arguments[4]).toBe("0");
    expect(redis.values.has(`${KEY_PREFIX}api`)).toBe(true);

    await store.close();
    expect(await first.tryTake()).toEqual({
      ok: false,
      remaining: 0,
      retryAfterMs: 1_000,
    });
  });

  it("retries after a lost race and does not grant a token another writer took", async () => {
    const stolen = JSON.stringify({
      v: 1,
      kind: "token-bucket",
      tokens: 0,
      updatedAt: 0,
    });
    const redis = createCasClient({ conflicts: 1, conflictValue: stolen });
    const limiter = createDistributedLimiter({
      store: createRedisStore({ client: redis.client }),
      key: "race",
      capacity: 1,
      refillPerSecond: 1,
      clock: { now: () => 0 },
    });

    expect(await limiter.tryTake()).toEqual({
      ok: false,
      remaining: 0,
      retryAfterMs: 1_000,
    });
    expect(redis.calls).toHaveLength(2);
  });

  it("admits only one of two parallel takes that read the same empty key", async () => {
    const redis = createCasClient({ barrier: true });
    const limiter = createDistributedLimiter({
      store: createRedisStore({ client: redis.client }),
      key: "parallel",
      capacity: 1,
      refillPerSecond: 0,
      clock: { now: () => 0 },
    });

    const results = await Promise.all([limiter.tryTake(), limiter.tryTake()]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
  });

  it("sets a sliding-window ttl and gives up when every compare-and-set loses", async () => {
    const redis = createCasClient();
    const limiter = createDistributedLimiter({
      store: createRedisStore({ client: redis.client }),
      key: "window",
      strategy: "sliding-window",
      windowMs: 1_000.2,
      max: 1,
      clock: { now: () => 0 },
    });
    expect((await limiter.tryTake()).ok).toBe(true);
    expect(redis.calls[0]?.arguments[4]).toBe("1001");

    const stuck = createCasClient({ conflicts: 100 });
    const blocked = createDistributedLimiter({
      store: createRedisStore({ client: stuck.client }),
      key: "stuck",
      capacity: 1,
      refillPerSecond: 1,
      clock: { now: () => 0 },
    });
    await expect(blocked.tryTake()).rejects.toThrow(/could not update limiter key/);
    expect(stuck.calls).toHaveLength(32);
  });

  it("rejects when the owned client cannot reach Redis", async () => {
    const store = createRedisStore({ url: "redis://127.0.0.1:6399" });
    await expect(
      store.transact("k", () => ({ next: "a", result: true })),
    ).rejects.toThrow();
    await store.close();
  });

  it("rejects an empty url and leaves an injected client connected after close", async () => {
    expect(() => createRedisStore({ url: "   " })).toThrow(/url/);
    let quit = 0;
    const redis = createCasClient();
    const client = {
      ...redis.client,
      quit: async () => {
        quit += 1;
      },
      close: async () => {
        quit += 1;
      },
    };
    const store = createRedisStore({ client });
    await store.close();
    expect(quit).toBe(0);
    expect(
      await createDistributedLimiter({
        store,
        key: "still-open",
        capacity: 1,
        refillPerSecond: 1,
        clock: { now: () => 0 },
      }).tryTake(),
    ).toMatchObject({ ok: true });
  });
});

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

describe("live redis", () => {
  let client: RedisClientType | undefined;

  beforeAll(async () => {
    const candidate = createClient({
      url: redisUrl,
      socket: { connectTimeout: 500, reconnectStrategy: false },
    });
    candidate.on("error", () => {
      // A refused connection rejects `connect`. Don't crash the test worker.
    });
    try {
      await candidate.connect();
      client = candidate;
    } catch {
      client = undefined;
      try {
        candidate.destroy();
      } catch {
        // A refused connection is already closed.
      }
    }
  });

  afterAll(async () => {
    if (client?.isOpen) {
      await client.close();
    }
  });

  it("shares token-bucket and sliding-window counters on one server", async (context) => {
    if (!client) {
      context.skip();
      return;
    }

    const store = createRedisStore({ client });
    const key = `vitest-${crypto.randomUUID()}`;
    let now = 0;
    const clock = { now: () => now };
    const bucketA = createDistributedLimiter({
      store,
      key: `${key}-bucket`,
      capacity: 5,
      refillPerSecond: 0,
      clock,
    });
    const bucketB = createDistributedLimiter({
      store,
      key: `${key}-bucket`,
      capacity: 5,
      refillPerSecond: 0,
      clock,
    });

    const burst = await Promise.all([
      ...Array.from({ length: 5 }, () => bucketA.tryTake()),
      ...Array.from({ length: 5 }, () => bucketB.tryTake()),
    ]);
    expect(burst.filter((result) => result.ok)).toHaveLength(5);
    expect(await client.pTTL(`${KEY_PREFIX}${key}-bucket`)).toBe(-1);

    const windowA = createDistributedLimiter({
      store,
      key: `${key}-window`,
      strategy: "sliding-window",
      windowMs: 1_000,
      max: 1,
      clock,
    });
    const windowB = createDistributedLimiter({
      store,
      key: `${key}-window`,
      strategy: "sliding-window",
      windowMs: 1_000,
      max: 1,
      clock,
    });
    expect(await windowA.tryTake()).toEqual({ ok: true, remaining: 0, retryAfterMs: 0 });
    const ttl = await client.pTTL(`${KEY_PREFIX}${key}-window`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(1_000);
    now = 1_000;
    expect(await windowB.tryTake()).toEqual({ ok: true, remaining: 0, retryAfterMs: 0 });

    await client.del([`${KEY_PREFIX}${key}-bucket`, `${KEY_PREFIX}${key}-window`]);
  });
});

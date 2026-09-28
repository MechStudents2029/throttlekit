import { createClient, type RedisClientType } from "redis";
import type { LimiterStore, StoreMutation } from "./store.js";

/**
 * Commands ThrottleKit sends. A `node-redis` client satisfies this, and so
 * does a test double. ThrottleKit does not connect or close a client you pass in.
 */
export type RedisCommandClient = {
  get(key: string): Promise<unknown>;
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
};

export type RedisStoreOptions = {
  /**
   * Redis URL. Used only when `client` is omitted.
   * Falls back to `REDIS_URL`, then `redis://127.0.0.1:6379`.
   */
  url?: string;
  /** Existing client. When set, `url` is ignored and `close` does not quit it. */
  client?: RedisClientType | RedisCommandClient;
};

export type RedisLimiterStore = LimiterStore & {
  /** Close a client this store opened. A client passed in `options` stays open. */
  close(): Promise<void>;
};

const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379";
const MAX_CAS_ATTEMPTS = 32;

/**
 * Compare-and-set. ARGV layout:
 * 1. "0" when the expected value is missing, otherwise "1"
 * 2. expected string (ignored when missing)
 * 3. "0" to delete, "1" to set
 * 4. next string (ignored when deleting)
 * 5. TTL in milliseconds, or "0" to keep the key until it is replaced
 */
const COMPARE_AND_SET = `
local current = redis.call('GET', KEYS[1])
local missing = (current == false)
local expectMissing = (ARGV[1] == '0')
local matches = false
if expectMissing then
  matches = missing
else
  matches = (not missing) and (current == ARGV[2])
end
if not matches then
  return 0
end
if ARGV[3] == '0' then
  redis.call('DEL', KEYS[1])
  return 1
end
local ttl = tonumber(ARGV[5])
if ttl ~= nil and ttl > 0 then
  redis.call('SET', KEYS[1], ARGV[4], 'PX', math.floor(ttl))
else
  redis.call('SET', KEYS[1], ARGV[4])
end
return 1
`;

function resolveUrl(url: string | undefined): string {
  if (url !== undefined) {
    if (url.trim() === "") {
      throw new Error("url must be a redis URL");
    }
    return url;
  }
  const fromEnv = process.env.REDIS_URL;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return fromEnv;
  }
  return DEFAULT_REDIS_URL;
}

function asState(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  throw new Error("redis GET returned an unexpected value");
}

function casArguments(
  expected: string | null,
  next: string | null,
  ttlMs: number | undefined,
): string[] {
  const ttl =
    ttlMs !== undefined && Number.isFinite(ttlMs) && ttlMs > 0 ? String(Math.ceil(ttlMs)) : "0";
  return [
    expected === null ? "0" : "1",
    expected ?? "",
    next === null ? "0" : "1",
    next ?? "",
    ttl,
  ];
}

function asCommandClient(client: RedisClientType | RedisCommandClient): RedisCommandClient {
  return client as RedisCommandClient;
}

/**
 * Redis-backed `LimiterStore`. Each `transact` is a compare-and-set, retried
 * when another process writes the key first. Local Redis only: pass a
 * `redis://127.0.0.1` URL or run `docker compose up -d`.
 */
export function createRedisStore(options: RedisStoreOptions = {}): RedisLimiterStore {
  const injected = options.client ? asCommandClient(options.client) : undefined;
  const owned = injected
    ? undefined
    : createClient({
        url: resolveUrl(options.url),
        socket: {
          connectTimeout: 1_000,
          reconnectStrategy: false,
        },
      });
  if (owned) {
    owned.on("error", () => {
      // The in-flight command rejects. This listener keeps that from crashing the process.
    });
  }

  let connecting: Promise<unknown> | undefined;
  let closed = false;

  async function commands(): Promise<RedisCommandClient> {
    if (injected) {
      return injected;
    }
    if (!owned || closed) {
      throw new Error("redis store is closed");
    }
    if (owned.isReady) {
      return asCommandClient(owned);
    }
    if (!connecting) {
      connecting = owned.connect().catch((error: unknown) => {
        connecting = undefined;
        throw error;
      });
    }
    await connecting;
    return asCommandClient(owned);
  }

  async function transact<T>(
    key: string,
    update: (current: string | null) => StoreMutation<T>,
  ): Promise<T> {
    const client = await commands();
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = asState(await client.get(key));
      const mutation = update(current);
      const reply = await client.eval(COMPARE_AND_SET, {
        keys: [key],
        arguments: casArguments(current, mutation.next, mutation.ttlMs),
      });
      if (Number(reply) === 1) {
        return mutation.result;
      }
    }
    throw new Error(`could not update limiter key "${key}" after ${MAX_CAS_ATTEMPTS} attempts`);
  }

  async function close(): Promise<void> {
    if (!owned || closed) {
      return;
    }
    closed = true;
    try {
      if (connecting) {
        await connecting.catch(() => undefined);
      }
      if (owned.isOpen) {
        await owned.close();
        return;
      }
    } catch {
      // Fall through and destroy the socket.
    }
    try {
      owned.destroy();
    } catch {
      // A refused connection is already closed.
    }
  }

  return { transact, close };
}

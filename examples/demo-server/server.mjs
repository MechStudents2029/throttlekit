/**
 * Local demo: rate-limit inbound HTTP, then proxy allowed GETs to JSONPlaceholder.
 *
 *   npm run build
 *   npm run demo
 *
 * In-memory sliding window: 5 requests / 10 seconds.
 *   curl -i http://127.0.0.1:3000/todos/1
 *   curl -i http://127.0.0.1:3000/posts
 *
 * Allowed responses include X-RateLimit-* and the upstream JSON.
 * The next request past the limit is 429 with Retry-After.
 */
import http from "node:http";
import https from "node:https";
import { createLimiter, rateLimitHeaders } from "../../dist/index.js";

const PORT = Number(process.env.PORT ?? 3000);
const LIMIT = 5;
const WINDOW_MS = 10_000;
const UPSTREAM_HOST = "jsonplaceholder.typicode.com";

const limiter = createLimiter({
  strategy: "sliding-window",
  windowMs: WINDOW_MS,
  max: LIMIT,
});

function upstreamPath(url) {
  if (typeof url !== "string" || !url.startsWith("/") || url.startsWith("//")) {
    return null;
  }
  const hash = url.indexOf("#");
  const path = hash === -1 ? url : url.slice(0, hash);
  if (path.includes("..") || path.includes("\\") || path.includes("\0")) {
    return null;
  }
  return path;
}

function writeJson(req, res, status, headers, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(req.method === "HEAD" ? undefined : payload);
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    writeJson(req, res, 405, { allow: "GET, HEAD" }, { error: "Method Not Allowed" });
    return;
  }

  const path = upstreamPath(req.url);
  if (path === null) {
    writeJson(req, res, 400, {}, { error: "Bad Request" });
    return;
  }

  const decision = limiter.tryTake();
  const headers = rateLimitHeaders(decision, { limit: LIMIT });

  if (!decision.ok) {
    writeJson(req, res, 429, headers, {
      error: "Too Many Requests",
      retryAfterMs: decision.retryAfterMs,
    });
    return;
  }

  const upstream = https.request(
    {
      hostname: UPSTREAM_HOST,
      path,
      method: req.method,
      headers: {
        accept: "application/json",
        "user-agent": "throttlekit-demo",
      },
    },
    (upstreamRes) => {
      const contentType = upstreamRes.headers["content-type"] ?? "application/json";
      res.writeHead(upstreamRes.statusCode ?? 502, {
        "content-type": contentType,
        ...headers,
      });
      if (req.method === "HEAD") {
        upstreamRes.resume();
        res.end();
        return;
      }
      upstreamRes.pipe(res);
    },
  );

  upstream.setTimeout(10_000, () => {
    upstream.destroy(new Error("upstream timeout"));
  });

  upstream.on("error", () => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    writeJson(req, res, 502, headers, { error: "Bad Gateway" });
  });

  upstream.end();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`throttlekit demo http://127.0.0.1:${PORT}`);
  console.log(`limit ${LIMIT} requests / ${WINDOW_MS}ms`);
  console.log(`try: curl -i http://127.0.0.1:${PORT}/todos/1`);
});

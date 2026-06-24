// Minimal in-process fixed-window rate limiter for auth endpoints (login / setup / dev-login / register).
// Scope & limits: this is a brute-force speed bump, not a DoS shield. It is per-process and in-memory only —
// it does NOT coordinate across multiple server instances or survive a restart. For a multi-instance deployment,
// front this with a shared store (Redis) or an edge/WAF rate limit. Documented as a known limitation.
import type { IncomingMessage } from "node:http";

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

/** Best-effort client identity: trust x-forwarded-for's first hop when present (deploys sit behind a proxy), else the socket address. */
export function clientIp(req: IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  const fwd = Array.isArray(xff) ? xff[0] : xff;
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.socket?.remoteAddress ?? "unknown";
}

/**
 * Returns { ok, retryAfter } for a (bucket, key) pair. `ok=false` means the window limit is exceeded.
 * Windows are lazily reset; stale buckets are pruned opportunistically to bound memory.
 */
export function rateLimit(bucket: string, key: string, limit = 10, windowMs = 60_000, now = Date.now()): { ok: boolean; retryAfter: number } {
  const id = `${bucket}:${key}`;
  const b = buckets.get(id);
  if (!b || now >= b.resetAt) {
    buckets.set(id, { count: 1, resetAt: now + windowMs });
    if (buckets.size > 10_000) for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k); // opportunistic prune
    return { ok: true, retryAfter: 0 };
  }
  if (b.count >= limit) return { ok: false, retryAfter: Math.ceil((b.resetAt - now) / 1000) };
  b.count++;
  return { ok: true, retryAfter: 0 };
}

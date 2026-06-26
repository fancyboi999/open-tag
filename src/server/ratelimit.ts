// Minimal in-process fixed-window rate limiter for auth endpoints (login / setup / dev-login / register).
// Scope & limits: this is a brute-force speed bump, not a DoS shield. It is per-process and in-memory only —
// it does NOT coordinate across multiple server instances or survive a restart. For a multi-instance deployment,
// front this with a shared store (Redis) or an edge/WAF rate limit. Documented as a known limitation.
import type { IncomingMessage } from "node:http";

/**
 * Per-IP rate-limit constants for the registration endpoint.
 *
 * 5 attempts per hour is generous for a real user (registration is a one-time event)
 * and tight enough to stop bot/script bulk-registration.  Login keeps a looser default
 * (10 per minute) because repeated attempts from a real user are normal.
 *
 * Exported so tests can assert on the exact contract without hard-coding magic numbers.
 */
export const REGISTER_RATE_LIMIT = 5;
export const REGISTER_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

/** Best-effort client identity for rate-limiting.
 *
 * By default this uses the TCP socket address (req.socket.remoteAddress), which is
 * unforgeable but returns the proxy's IP when the server runs behind a reverse proxy —
 * making rate-limiting ineffective (all requests share one bucket).
 *
 * Set TRUST_PROXY=true in .env when running behind a trusted reverse proxy (nginx,
 * Caddy, cloud load-balancer) that unconditionally rewrites X-Forwarded-For. Only enable
 * this when you control the proxy; never enable it with a public-facing server that
 * accepts arbitrary XFF headers, as clients can spoof the value and bypass rate limits.
 *
 * Note: this server uses node:http directly (not Express), so there is no framework-level
 * trust proxy setting — the decision is explicit via this env flag. */
export function clientIp(req: IncomingMessage): string {
  if (process.env.TRUST_PROXY === "true") {
    const xff = req.headers["x-forwarded-for"];
    const fwd = Array.isArray(xff) ? xff[0] : xff;
    if (fwd) return fwd.split(",")[0]!.trim();
  }
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

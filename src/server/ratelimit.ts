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
 * Set TRUST_PROXY=true in .env when running behind a single trusted reverse proxy (nginx,
 * Caddy, Railway, cloud load-balancer) that appends the real client IP to X-Forwarded-For.
 * Only enable this when you control the proxy; never enable it when the server is
 * directly internet-facing, as clients could inject arbitrary XFF headers.
 *
 * XFF parsing assumes exactly ONE trusted proxy hop. The proxy appends the real
 * client IP as the rightmost entry in the chain; we take that rightmost value.
 * Example: a client forges "X-Forwarded-For: 1.2.3.4"; the proxy appends the real IP
 * "203.0.113.9" → XFF becomes "1.2.3.4, 203.0.113.9" → we return "203.0.113.9".
 * Taking the leftmost value (the old behaviour) would return the forged "1.2.3.4",
 * allowing the attacker to rotate buckets and bypass rate-limiting.
 *
 * Multi-hop deployments (CDN → nginx → app) need hop-count-aware parsing; that is
 * outside the scope of this single-hop implementation and should use a dedicated
 * library (e.g. proxy-addr) instead.
 *
 * Note: this server uses node:http directly (not Express), so there is no framework-level
 * trust proxy setting — the decision is explicit via this env flag. */
export function clientIp(req: IncomingMessage): string {
  if (process.env.TRUST_PROXY === "true") {
    const xff = req.headers["x-forwarded-for"];
    // node:http may deliver multiple XFF headers as a string[]; join before splitting.
    const raw = Array.isArray(xff) ? xff.join(",") : xff;
    if (raw) {
      const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length > 0) return parts[parts.length - 1]!;
    }
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

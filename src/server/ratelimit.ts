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
 * Caddy, Railway, cloud load-balancer) that rewrites the client-IP headers. Only enable this
 * when you control the proxy; never enable it when the server is directly internet-facing, as
 * clients could otherwise inject arbitrary X-Real-IP / X-Forwarded-For headers.
 *
 * When trusted, we prefer X-Real-IP (a single clean value the proxy sets to the real client and
 * overwrites if forged), and fall back to the FIRST X-Forwarded-For hop (the proxy puts the real
 * client at the front and strips any client-supplied XFF).
 *
 * Verified empirically against Railway (getopentag.com's proxy): a request carrying a forged
 * `X-Real-IP` AND a forged `X-Forwarded-For` arrived with both rewritten — X-Real-IP held the
 * true client IP and the forged XFF entries were dropped, leaving the real client leftmost.
 * Railway *prepends* the real client and *appends* its own (rotating) edge hop, so the RIGHTMOST
 * XFF entry is the proxy's edge IP — using it as the rate-limit key gives every request a fresh
 * bucket and defeats the limit entirely.
 *
 * NB: this assumes the proxy overwrites/prepends these headers (Railway; nginx with
 * `proxy_set_header X-Real-IP $remote_addr`). A proxy that blindly *appends* a client-supplied
 * XFF would leave the leftmost spoofable. Multi-hop chains (CDN → nginx → app) need hop-count-aware
 * parsing (e.g. proxy-addr) — outside the scope of this single-trusted-hop implementation.
 *
 * Note: this server uses node:http directly (not Express), so there is no framework-level
 * trust proxy setting — the decision is explicit via this env flag. */
export function clientIp(req: IncomingMessage): string {
  if (process.env.TRUST_PROXY === "true") {
    const xRealIp = req.headers["x-real-ip"];
    const real = (Array.isArray(xRealIp) ? xRealIp[0] : xRealIp)?.trim();
    if (real) return real;
    const xff = req.headers["x-forwarded-for"];
    // node:http may deliver multiple XFF headers as a string[]; the real client is the first
    // entry of the first header (the trusted proxy prepends it).
    const raw = Array.isArray(xff) ? xff[0] : xff;
    const first = raw?.split(",")[0]?.trim();
    if (first) return first;
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

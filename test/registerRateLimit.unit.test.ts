// Unit tests for the registration rate limit.
// Contract: POST /api/auth/register is capped at REGISTER_RATE_LIMIT requests per
// REGISTER_RATE_WINDOW_MS per IP — stricter than the login default (brute-force guard),
// because legitimate users register at most once; repeated attempts from the same IP
// in a short window are almost certainly bot/script behaviour.
//
// Run: npx tsx --test --test-force-exit test/registerRateLimit.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
// REGISTER_RATE_LIMIT / REGISTER_RATE_WINDOW_MS are exported only after the fix.
// On origin/main they do not exist → this import fails → all tests below fail.
// That is the "red on main" evidence required by the goal contract.
import { rateLimit, REGISTER_RATE_LIMIT, REGISTER_RATE_WINDOW_MS } from "../src/server/ratelimit.ts";

test("REGISTER_RATE_LIMIT is 5 (one registration per ~hour is ample for a real user)", () => {
  assert.equal(REGISTER_RATE_LIMIT, 5);
});

test("REGISTER_RATE_WINDOW_MS is 1 hour (3 600 000 ms)", () => {
  assert.equal(REGISTER_RATE_WINDOW_MS, 60 * 60 * 1000);
});

test("rateLimit allows up to REGISTER_RATE_LIMIT requests per IP within the window", () => {
  // Use a unique bucket suffix to avoid cross-test pollution from the shared in-memory store.
  const bucket = "auth:register:test-allow";
  const ip = "192.0.2.1";
  const t = 1_000_000; // arbitrary fixed timestamp
  for (let i = 0; i < REGISTER_RATE_LIMIT; i++) {
    const r = rateLimit(bucket, ip, REGISTER_RATE_LIMIT, REGISTER_RATE_WINDOW_MS, t + i);
    assert.ok(r.ok, `request ${i + 1} of ${REGISTER_RATE_LIMIT} should be allowed`);
    assert.equal(r.retryAfter, 0);
  }
});

test("rateLimit blocks the (REGISTER_RATE_LIMIT + 1)th request from the same IP", () => {
  const bucket = "auth:register:test-block";
  const ip = "192.0.2.2";
  const t = 2_000_000;
  // Exhaust the limit
  for (let i = 0; i < REGISTER_RATE_LIMIT; i++) {
    rateLimit(bucket, ip, REGISTER_RATE_LIMIT, REGISTER_RATE_WINDOW_MS, t + i);
  }
  // Next request must be blocked
  const blocked = rateLimit(bucket, ip, REGISTER_RATE_LIMIT, REGISTER_RATE_WINDOW_MS, t + REGISTER_RATE_LIMIT);
  assert.ok(!blocked.ok, "request beyond the limit should be blocked");
  assert.ok(blocked.retryAfter > 0, "Retry-After must be positive when blocked");
});

test("rateLimit resets after the window expires", () => {
  const bucket = "auth:register:test-reset";
  const ip = "192.0.2.3";
  const t = 3_000_000;
  // Exhaust the limit within the window
  for (let i = 0; i < REGISTER_RATE_LIMIT; i++) {
    rateLimit(bucket, ip, REGISTER_RATE_LIMIT, REGISTER_RATE_WINDOW_MS, t + i);
  }
  // Advance time past the window — a new window should open
  const afterReset = rateLimit(bucket, ip, REGISTER_RATE_LIMIT, REGISTER_RATE_WINDOW_MS, t + REGISTER_RATE_WINDOW_MS + 1);
  assert.ok(afterReset.ok, "first request in a new window should be allowed");
});

test("rateLimit gives independent buckets to different IPs", () => {
  const bucket = "auth:register:test-independent";
  const t = 4_000_000;
  const ipA = "10.0.0.1";
  const ipB = "10.0.0.2";
  // Exhaust limit for ipA
  for (let i = 0; i < REGISTER_RATE_LIMIT; i++) {
    rateLimit(bucket, ipA, REGISTER_RATE_LIMIT, REGISTER_RATE_WINDOW_MS, t + i);
  }
  // ipB should be unaffected
  const r = rateLimit(bucket, ipB, REGISTER_RATE_LIMIT, REGISTER_RATE_WINDOW_MS, t + REGISTER_RATE_LIMIT);
  assert.ok(r.ok, "a different IP should not share the same bucket");
});

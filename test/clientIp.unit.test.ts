// Unit tests for clientIp() — best-effort client identity extraction for rate-limiting.
//
// Model (verified empirically against Railway — see clientIp() JSDoc): behind a trusted proxy
// (TRUST_PROXY=true) the proxy authoritatively sets the client-IP headers and overwrites any
// client-forged values. clientIp() therefore PREFERS X-Real-IP (single clean value) and falls
// back to the FIRST X-Forwarded-For hop (the proxy prepends the real client and strips forged
// XFF). It must NEVER use the rightmost XFF entry — on Railway that is the proxy's rotating edge
// IP, which would give every request its own rate-limit bucket and defeat the limit.
//
// The anti-spoofing guarantee comes from the trusted proxy overwriting these headers (proven by
// the prod probe in the PR), not from this parser; these tests pin the precedence/parse logic.
//
// Run: npx tsx --test --test-force-exit test/clientIp.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { clientIp } from "../src/server/ratelimit.ts";

function req(
  headers: Record<string, string | string[]> = {},
  remoteAddr = "10.0.0.1",
) {
  return { headers, socket: { remoteAddress: remoteAddr } } as any;
}

/** Set TRUST_PROXY for the duration of fn(), then restore it. */
function withTrustProxy(value: string | undefined, fn: () => void) {
  const orig = process.env.TRUST_PROXY;
  if (value !== undefined) process.env.TRUST_PROXY = value;
  else delete process.env.TRUST_PROXY;
  try {
    fn();
  } finally {
    if (orig !== undefined) process.env.TRUST_PROXY = orig;
    else delete process.env.TRUST_PROXY;
  }
}

// [1] X-Real-IP is the preferred source when trusted.
test("TRUST_PROXY=true + X-Real-IP → that value", () => {
  withTrustProxy("true", () => {
    assert.equal(clientIp(req({ "x-real-ip": "203.0.113.9" })), "203.0.113.9");
  });
});

// [2] X-Real-IP wins over X-Forwarded-For when both are present.
test("TRUST_PROXY=true + X-Real-IP and XFF both present → X-Real-IP wins", () => {
  withTrustProxy("true", () => {
    assert.equal(
      clientIp(req({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.7, 10.0.0.1" })),
      "203.0.113.9",
    );
  });
});

// [3] CORE: no X-Real-IP, XFF chain → take the FIRST (real client), NOT the rightmost.
//     On Railway XFF is "<realClient>, <rotating edge hop>"; the rightmost is the proxy edge IP
//     and using it would give every request a fresh bucket → rate-limit bypass.
test("TRUST_PROXY=true + XFF chain → returns FIRST hop (real client), NOT rightmost", () => {
  withTrustProxy("true", () => {
    const ip = clientIp(req({ "x-forwarded-for": "203.0.113.9, 152.233.33.161" }));
    assert.equal(
      ip,
      "203.0.113.9",
      `Expected leftmost real client "203.0.113.9" but got "${ip}" — the rightmost is the proxy's rotating edge IP`,
    );
  });
});

// [4] Single-value XFF (no extra hops) → that value.
test("TRUST_PROXY=true + single XFF value → that value", () => {
  withTrustProxy("true", () => {
    assert.equal(clientIp(req({ "x-forwarded-for": "203.0.113.9" })), "203.0.113.9");
  });
});

// [5] node:http may split multiple XFF headers into a string[] — use the first header's first hop.
test("TRUST_PROXY=true + XFF as string array → first hop of first header", () => {
  withTrustProxy("true", () => {
    assert.equal(clientIp(req({ "x-forwarded-for": ["203.0.113.9, 152.233.33.161", "10.0.0.2"] })), "203.0.113.9");
  });
});

// [6] Whitespace trimming on both sources.
test("TRUST_PROXY=true + surrounding whitespace → trimmed", () => {
  withTrustProxy("true", () => {
    assert.equal(clientIp(req({ "x-real-ip": "  203.0.113.9  " })), "203.0.113.9");
    assert.equal(clientIp(req({ "x-forwarded-for": "  203.0.113.9  , 10.0.0.1" })), "203.0.113.9");
  });
});

// [7] Without TRUST_PROXY, proxy headers are never trusted — use socket address.
test("TRUST_PROXY not set + proxy headers present → returns socket address (headers ignored)", () => {
  withTrustProxy(undefined, () => {
    assert.equal(
      clientIp(req({ "x-real-ip": "1.2.3.4", "x-forwarded-for": "1.2.3.4" }, "10.0.0.1")),
      "10.0.0.1",
      "Without TRUST_PROXY, X-Real-IP/XFF must be ignored and socket address returned",
    );
  });
});

// [8] TRUST_PROXY=true but no proxy headers → fall back to socket address.
test("TRUST_PROXY=true + no proxy headers → falls back to socket address", () => {
  withTrustProxy("true", () => {
    assert.equal(clientIp(req({}, "10.0.0.1")), "10.0.0.1");
  });
});

// [9] Empty / whitespace-only headers → fall back rather than returning "".
test("TRUST_PROXY=true + empty proxy headers → falls back to socket address", () => {
  withTrustProxy("true", () => {
    assert.equal(clientIp(req({ "x-real-ip": "   ", "x-forwarded-for": "  ,  " }, "10.0.0.1")), "10.0.0.1");
  });
});

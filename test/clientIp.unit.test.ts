// Unit tests for clientIp() — best-effort client identity extraction for rate-limiting.
//
// Security property: when TRUST_PROXY=true, clientIp() MUST return the rightmost
// non-empty item in X-Forwarded-For — the IP appended by the trusted proxy
// (unforgeable by the client). The leftmost item is client-controlled and MUST NOT
// be used as the rate-limit key.
//
// Run: npx tsx --test --test-force-exit test/clientIp.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { clientIp } from "../src/server/ratelimit.ts";

function req(xff: string | string[] | undefined, remoteAddr = "10.0.0.1") {
  return {
    headers: xff !== undefined ? { "x-forwarded-for": xff } : {},
    socket: { remoteAddress: remoteAddr },
  } as any;
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

// [1] Single-value XFF — straightforward passthrough
test("TRUST_PROXY=true + single XFF value → that value", () => {
  withTrustProxy("true", () => {
    assert.equal(clientIp(req("203.0.113.9")), "203.0.113.9");
  });
});

// [2] THE CORE SECURITY ASSERTION:
//     Attacker sends "X-Forwarded-For: 1.2.3.4"; the trusted proxy appends the real
//     IP "203.0.113.9". clientIp() MUST return 203.0.113.9 (rightmost = proxy-appended),
//     NOT 1.2.3.4 (leftmost = client-forged). Returning the leftmost value lets an
//     attacker rotate buckets and bypass rate-limiting.
test("TRUST_PROXY=true + forged prefix → returns rightmost (real), NOT leftmost (forged)", () => {
  withTrustProxy("true", () => {
    const ip = clientIp(req("1.2.3.4, 203.0.113.9"));
    assert.equal(
      ip,
      "203.0.113.9",
      `Expected rightmost "203.0.113.9" but got "${ip}" — the leftmost value is client-forged and allows rate-limit bypass`
    );
  });
});

// [3] Three-hop chain — always take the rightmost
test("TRUST_PROXY=true + three-hop XFF chain → returns rightmost", () => {
  withTrustProxy("true", () => {
    assert.equal(clientIp(req("a, b, c")), "c");
  });
});

// [4] node:http may split multiple XFF headers into a string[] — join and take rightmost
test("TRUST_PROXY=true + XFF as string array → joins and returns rightmost", () => {
  withTrustProxy("true", () => {
    assert.equal(clientIp(req(["1.2.3.4", "203.0.113.9"])), "203.0.113.9");
  });
});

// [5] Whitespace trimming
test("TRUST_PROXY=true + XFF with surrounding whitespace → trimmed", () => {
  withTrustProxy("true", () => {
    assert.equal(clientIp(req("  203.0.113.9  ")), "203.0.113.9");
  });
});

// [6] Without TRUST_PROXY, XFF is never trusted — use socket address
test("TRUST_PROXY not set + XFF present → returns socket address (XFF ignored)", () => {
  withTrustProxy(undefined, () => {
    assert.equal(
      clientIp(req("1.2.3.4", "10.0.0.1")),
      "10.0.0.1",
      "Without TRUST_PROXY, XFF must be ignored and socket address returned"
    );
  });
});

// [7] TRUST_PROXY=true but no XFF header → fall back to socket address
test("TRUST_PROXY=true + no XFF → falls back to socket address", () => {
  withTrustProxy("true", () => {
    assert.equal(clientIp(req(undefined, "10.0.0.1")), "10.0.0.1");
  });
});

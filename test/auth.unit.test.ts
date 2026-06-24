// Unit tests for human-auth primitives (no DB / no network).
// Run: npx tsx --test --test-force-exit test/auth.unit.test.ts
// JWT_SECRET is pinned before importing auth.ts so signed/forged tokens are deterministic.
import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-secret";
const auth = await import("../src/server/auth.ts");

test("signUser / verifyUser round-trip returns the uid", () => {
  const token = auth.signUser("user-123");
  assert.equal(auth.verifyUser(token), "user-123");
});

test("verifyUser rejects null, garbage, tampered, and wrong-secret tokens", () => {
  assert.equal(auth.verifyUser(null), null);
  assert.equal(auth.verifyUser(""), null);
  assert.equal(auth.verifyUser("not.a.jwt"), null);
  const tampered = auth.signUser("user-123").slice(0, -2) + "xx";
  assert.equal(auth.verifyUser(tampered), null);
  const wrongSecret = jwt.sign({ uid: "user-123" }, "other-secret", { expiresIn: "30d" });
  assert.equal(auth.verifyUser(wrongSecret), null);
});

test("verifyUser rejects an expired token", () => {
  const expired = jwt.sign({ uid: "user-123" }, "test-secret", { expiresIn: "-1s" });
  assert.equal(auth.verifyUser(expired), null);
});

test("hashPassword / verifyPassword", () => {
  const stored = auth.hashPassword("correct horse battery staple");
  assert.ok(stored.includes(":"));
  assert.equal(auth.verifyPassword("correct horse battery staple", stored), true);
  assert.equal(auth.verifyPassword("wrong password", stored), false);
  assert.equal(auth.verifyPassword("anything", null), false);
  assert.equal(auth.verifyPassword("anything", "no-colon"), false);
  // salted: two hashes of the same password differ
  assert.notEqual(auth.hashPassword("same"), auth.hashPassword("same"));
});

test("safeEqual", () => {
  assert.equal(auth.safeEqual("abc", "abc"), true);
  assert.equal(auth.safeEqual("abc", "abd"), false);
  assert.equal(auth.safeEqual("abc", "abcd"), false);
  assert.equal(auth.safeEqual("", ""), true);
});

test("isValidEmail", () => {
  for (const ok of ["a@b.co", "user.name+tag@sub.example.com"]) assert.equal(auth.isValidEmail(ok), true, ok);
  for (const bad of ["", "nope", "a@b", "a@@b.co", "a b@c.co", 42 as any, null as any]) assert.equal(auth.isValidEmail(bad), false, String(bad));
});

test("passwordError enforces length policy", () => {
  assert.equal(auth.passwordError("12345678"), null);
  assert.match(auth.passwordError("short") ?? "", /at least 8/);
  assert.match(auth.passwordError("x".repeat(201)) ?? "", /too long/);
  assert.match(auth.passwordError(undefined) ?? "", /required/);
});

test("devLoginEnabled reads env at call-time, default off", () => {
  delete process.env.ALLOW_DEV_LOGIN;
  assert.equal(auth.devLoginEnabled(), false);
  process.env.ALLOW_DEV_LOGIN = "false";
  assert.equal(auth.devLoginEnabled(), false);
  process.env.ALLOW_DEV_LOGIN = "1";
  assert.equal(auth.devLoginEnabled(), false, "only the exact string 'true' enables it");
  process.env.ALLOW_DEV_LOGIN = "true";
  assert.equal(auth.devLoginEnabled(), true);
  delete process.env.ALLOW_DEV_LOGIN;
});

test("setupToken returns null when unset/empty", () => {
  delete process.env.ADMIN_SETUP_TOKEN;
  assert.equal(auth.setupToken(), null);
  process.env.ADMIN_SETUP_TOKEN = "";
  assert.equal(auth.setupToken(), null);
  process.env.ADMIN_SETUP_TOKEN = "tok_abc";
  assert.equal(auth.setupToken(), "tok_abc");
  delete process.env.ADMIN_SETUP_TOKEN;
});

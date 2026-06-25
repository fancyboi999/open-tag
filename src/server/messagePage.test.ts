// Unit tests for the channel-messages pagination query parsing. The route (GET /api/messages/channel/:id)
// gained a keyset `before` cursor on the globally-monotonic message seq; these lock the parse edges so a
// garbage cursor can never silently turn into a NaN filter (which would return an empty page).
// Run: npx tsx --test --test-force-exit src/server/messagePage.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMsgPageParams } from "./messagePage.js";

test("limit defaults to 50 when absent, no cursor", () => {
  assert.deepEqual(parseMsgPageParams(new URLSearchParams("")), { limit: 50, before: null });
});

test("limit is clamped to the 200 ceiling", () => {
  assert.equal(parseMsgPageParams(new URLSearchParams("limit=999")).limit, 200);
});

test("garbage limit falls back to 50 (never NaN)", () => {
  assert.equal(parseMsgPageParams(new URLSearchParams("limit=abc")).limit, 50);
});

test("before parses a numeric keyset cursor", () => {
  assert.equal(parseMsgPageParams(new URLSearchParams("before=1500")).before, 1500);
});

test("garbage / empty / non-positive before yields a null cursor (returns the latest page)", () => {
  assert.equal(parseMsgPageParams(new URLSearchParams("before=abc")).before, null);
  assert.equal(parseMsgPageParams(new URLSearchParams("before=")).before, null);
  assert.equal(parseMsgPageParams(new URLSearchParams("before=0")).before, null);
});

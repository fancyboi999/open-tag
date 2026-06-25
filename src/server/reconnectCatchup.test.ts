// Wake-criterion unit tests for reconnect catch-up. The criterion is the conservative mirror of
// createMessage's wake branch (core.ts) — these cases lock that contract so the two cannot silently drift.
// Run: `npx tsx --test --test-force-exit src/server/reconnectCatchup.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isWakeable } from "./reconnectCatchup.js";

test("DM always wakes, regardless of mention or scope", () => {
  assert.equal(isWakeable({ channelType: "dm", mentioned: false, hasInboxScope: false }), true);
  assert.equal(isWakeable({ channelType: "dm", mentioned: true, hasInboxScope: true }), true);
});

test("@-mention always wakes in a plain channel, even without inbox scope", () => {
  assert.equal(isWakeable({ channelType: "channel", mentioned: true, hasInboxScope: false }), true);
});

test("ambient (no @) wakes only with the inbox:receive scope", () => {
  assert.equal(isWakeable({ channelType: "channel", mentioned: false, hasInboxScope: true }), true);
  assert.equal(isWakeable({ channelType: "channel", mentioned: false, hasInboxScope: false }), false);
});

test("a thread behaves like a plain channel, not a DM", () => {
  assert.equal(isWakeable({ channelType: "thread", mentioned: true, hasInboxScope: false }), true);
  assert.equal(isWakeable({ channelType: "thread", mentioned: false, hasInboxScope: true }), true);
  assert.equal(isWakeable({ channelType: "thread", mentioned: false, hasInboxScope: false }), false);
});

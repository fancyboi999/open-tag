// Wake-criterion unit tests for reconnect catch-up. The criterion is the conservative mirror of
// createMessage's wake branch (core.ts) — these cases lock that contract so the two cannot silently drift.
// Run: `npx tsx --test --test-force-exit src/server/reconnectCatchup.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isWakeable } from "./agentWakePolicy.js";

test("DM always wakes, regardless of mention or scope", () => {
  assert.equal(isWakeable({ channelType: "dm", mentioned: false, hasInboxScope: false, senderType: "agent" }), true);
  assert.equal(isWakeable({ channelType: "dm", mentioned: true, hasInboxScope: true, senderType: "user" }), true);
});

test("@-mention always wakes in a plain channel, even without inbox scope", () => {
  assert.equal(isWakeable({ channelType: "channel", mentioned: true, hasInboxScope: false, senderType: "agent" }), true);
});

test("human/system ambient (no @) wakes only with the inbox:receive scope", () => {
  assert.equal(isWakeable({ channelType: "channel", mentioned: false, hasInboxScope: true, senderType: "user" }), true);
  assert.equal(isWakeable({ channelType: "channel", mentioned: false, hasInboxScope: true, senderType: "system" }), true);
  assert.equal(isWakeable({ channelType: "channel", mentioned: false, hasInboxScope: false, senderType: "user" }), false);
});

test("agent ambient chatter does not wake peers even with inbox scope", () => {
  assert.equal(isWakeable({ channelType: "channel", mentioned: false, hasInboxScope: true, senderType: "agent" }), false);
});

test("a thread behaves like a plain channel, not a DM", () => {
  assert.equal(isWakeable({ channelType: "thread", mentioned: true, hasInboxScope: false, senderType: "agent" }), true);
  assert.equal(isWakeable({ channelType: "thread", mentioned: false, hasInboxScope: true, senderType: "user" }), true);
  assert.equal(isWakeable({ channelType: "thread", mentioned: false, hasInboxScope: false, senderType: "user" }), false);
});

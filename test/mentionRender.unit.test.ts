// Unit tests for frontend mention rendering (I2): @ highlighting is driven by the message's authoritative
// mentions[] (server-recorded, channel-scoped), NOT a workspace-wide name list — so a non-member @ renders
// as plain text instead of a fake clickable mention. Run: npx tsx --test --test-force-exit test/mentionRender.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { processMessageContent } from "../web/src/messageRender.tsx";

const ch = [{ name: "general", id: "c-general" }];

test("renders an @ that the server actually recorded as a mention", () => {
  const out = processMessageContent("hi @alice", { mentions: [{ type: "user", id: "u-alice", name: "alice" }], channels: ch });
  assert.equal(out, "hi [@alice](tag:human:u-alice)");
});

test("renders an agent mention with the agent tag", () => {
  const out = processMessageContent("@bot run it", { mentions: [{ type: "agent", id: "a-bot", name: "bot" }], channels: ch });
  assert.equal(out, "[@bot](tag:agent:a-bot) run it");
});

test("a non-member @ (not in mentions[]) stays plain text — no fake clickable mention", () => {
  // ghost is a workspace member but NOT recorded as a mention on this message (e.g. a private channel non-member)
  const out = processMessageContent("@ghost secret", { mentions: [], channels: ch });
  assert.equal(out, "@ghost secret");
});

test("only the recorded mention is linkified when both a member and a non-member are @-ed", () => {
  const out = processMessageContent("@alice and @ghost", { mentions: [{ type: "user", id: "u-alice", name: "alice" }], channels: ch });
  assert.equal(out, "[@alice](tag:human:u-alice) and @ghost");
});

test("mention matching is case-insensitive", () => {
  const out = processMessageContent("@ALICE", { mentions: [{ type: "user", id: "u-alice", name: "alice" }], channels: ch });
  assert.equal(out, "[@ALICE](tag:human:u-alice)");
});

test("channel references still resolve against the channel list", () => {
  const out = processMessageContent("see #general", { mentions: [], channels: ch });
  assert.equal(out, "see [#general](tag:channel:c-general)");
});

test("@ inside inline code is not turned into a mention", () => {
  const out = processMessageContent("use `@alice` literally", { mentions: [{ type: "user", id: "u-alice", name: "alice" }], channels: ch });
  assert.equal(out, "use `@alice` literally");
});

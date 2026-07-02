import { test } from "node:test";
import assert from "node:assert/strict";
import { canAutoJoinMentionedMembers, isWakeable } from "./agentWakePolicy.js";

test("only human-authored mentions auto-join non-members", () => {
  assert.equal(canAutoJoinMentionedMembers("user"), true);
  assert.equal(canAutoJoinMentionedMembers("agent"), false);
  assert.equal(canAutoJoinMentionedMembers("system"), false);
});

test("DM and explicit mentions wake agents", () => {
  assert.equal(isWakeable({ channelType: "dm", mentioned: false, hasInboxScope: false, senderType: "agent" }), true);
  assert.equal(isWakeable({ channelType: "channel", mentioned: true, hasInboxScope: false, senderType: "agent" }), true);
  assert.equal(isWakeable({ channelType: "thread", mentioned: true, hasInboxScope: false, senderType: "agent" }), true);
});

test("agent-authored ambient channel chatter does not wake peer agents", () => {
  assert.equal(isWakeable({ channelType: "channel", mentioned: false, hasInboxScope: true, senderType: "agent" }), false);
  assert.equal(isWakeable({ channelType: "thread", mentioned: false, hasInboxScope: true, senderType: "agent" }), false);
});

test("human and system ambient messages keep inbox-scope wake behavior", () => {
  assert.equal(isWakeable({ channelType: "channel", mentioned: false, hasInboxScope: true, senderType: "user" }), true);
  assert.equal(isWakeable({ channelType: "channel", mentioned: false, hasInboxScope: true, senderType: "system" }), true);
  assert.equal(isWakeable({ channelType: "channel", mentioned: false, hasInboxScope: false, senderType: "user" }), false);
});

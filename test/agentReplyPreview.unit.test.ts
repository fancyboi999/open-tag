import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { absorbPersistedAgentMessagePreview, agentReplyPreviewId, applyAgentReplyPreview, dropAgentReplyPreviewsForMessage, renderKeyForMessage, tickAgentReplyPreviews, hasStreamingAgentReplyPreview, AGENT_REPLY_PREVIEW_TYPE, AGENT_REPLY_STREAM_TICK_MS, AGENT_REPLY_PREVIEW_DELAY_MS, AGENT_REPLY_ENTER_DURATION_MS, AGENT_REPLY_THINKING_DELAY_MS, AGENT_REPLY_THINKING_SHIMMER_MS, AGENT_REPLY_FINAL_SETTLE_MS, AGENT_REPLY_CHARS_PER_TICK } from "../web/src/lib/agentReplyPreview.ts";
import type { Msg } from "../web/src/store.tsx";

test("agent reply preview streams text into an ephemeral chat message", () => {
  const start = applyAgentReplyPreview([], {
    type: "agent:reply",
    op: "start",
    agentId: "agent-1",
    channelId: "chan-1",
    streamId: "stream-1",
    name: "Xiaos",
  }, undefined, 1000);

  assert.equal(start.length, 1);
  assert.equal(start[0]?.messageType, AGENT_REPLY_PREVIEW_TYPE);
  assert.equal(start[0]?.senderName, "Xiaos");
  assert.equal(start[0]?.content, "");
  assert.equal((start[0] as any)?.streamVisible, false);
  assert.equal((start[0] as any)?.streamVisibleAt, 1000 + AGENT_REPLY_PREVIEW_DELAY_MS);
  assert.equal((start[0] as any)?.streamThinkingAt, 1000 + AGENT_REPLY_PREVIEW_DELAY_MS + AGENT_REPLY_THINKING_DELAY_MS);

  const withDelta = applyAgentReplyPreview(start, {
    type: "agent:reply",
    op: "delta",
    agentId: "agent-1",
    channelId: "chan-1",
    streamId: "stream-1",
    text: "hello",
  }, undefined, 1100);

  assert.equal(withDelta.length, 1);
  assert.equal(withDelta[0]?.content, "", "delta text should not be dumped into the preview all at once");
  assert.equal((withDelta[0] as any)?.streamTargetContent, "hello");

  assert.equal(hasStreamingAgentReplyPreview(withDelta), true);
  const beforeReveal = tickAgentReplyPreviews(withDelta, 1, 1000 + AGENT_REPLY_PREVIEW_DELAY_MS - 1);
  assert.equal(beforeReveal.changed, false, "agent card should not appear before the 1s preview delay completes");
  assert.equal(beforeReveal.messages[0]?.content, "");
  assert.equal((beforeReveal.messages[0] as any)?.streamVisible, false);

  const visible = tickAgentReplyPreviews(withDelta, 1, 1000 + AGENT_REPLY_PREVIEW_DELAY_MS);
  assert.equal(visible.changed, true);
  assert.equal((visible.messages[0] as any)?.streamVisible, true);
  assert.equal(visible.messages[0]?.content, "", "card visibility should not dump buffered text in the same tick");

  const oneTick = tickAgentReplyPreviews(visible.messages, 1, 1000 + AGENT_REPLY_PREVIEW_DELAY_MS + AGENT_REPLY_STREAM_TICK_MS);
  assert.equal(oneTick.changed, true);
  assert.equal(oneTick.messages[0]?.content, "h");
  assert.equal((oneTick.messages[0] as any)?.streamTargetContent, "hello");

  const finished = tickAgentReplyPreviews(oneTick.messages, 10, 1000 + AGENT_REPLY_PREVIEW_DELAY_MS + 20);
  assert.equal(finished.messages[0]?.content, "hello");
  assert.equal(hasStreamingAgentReplyPreview(finished.messages), false);
});

test("agent reply preview constants separate card delay, thinking delay, shimmer, and fast reveal", () => {
  assert.equal(AGENT_REPLY_PREVIEW_DELAY_MS, 1000);
  assert.equal(AGENT_REPLY_ENTER_DURATION_MS, 1000);
  assert.equal(AGENT_REPLY_THINKING_DELAY_MS, 0);
  assert.equal(AGENT_REPLY_THINKING_SHIMMER_MS, 4000);
  assert.equal(AGENT_REPLY_FINAL_SETTLE_MS, 500);
  assert.ok(AGENT_REPLY_CHARS_PER_TICK >= 3, "preview text should reveal quickly once text is available");
});

test("empty agent reply preview shows thinking as soon as the delayed card appears", () => {
  const start = applyAgentReplyPreview([], {
    type: "agent:reply",
    op: "start",
    agentId: "agent-1",
    channelId: "chan-1",
    streamId: "stream-1",
    name: "Xiaos",
  }, undefined, 2000);

  const visible = tickAgentReplyPreviews(start, 1, 2000 + AGENT_REPLY_PREVIEW_DELAY_MS);
  assert.equal((visible.messages[0] as any)?.streamVisible, true);
  assert.equal((visible.messages[0] as any)?.streamThinkingVisible, true);

  const beforeThinking = tickAgentReplyPreviews(start, 1, 2000 + AGENT_REPLY_PREVIEW_DELAY_MS - 1);
  assert.equal(beforeThinking.changed, false);
  assert.equal((beforeThinking.messages[0] as any)?.streamThinkingVisible, false);

  const thinking = tickAgentReplyPreviews(beforeThinking.messages, 1, 2000 + AGENT_REPLY_PREVIEW_DELAY_MS);
  assert.equal(thinking.changed, true);
  assert.equal((thinking.messages[0] as any)?.streamThinkingVisible, true);
});

test("agent reply preview done appends final text to the stream target instead of bypassing typing", () => {
  const start = applyAgentReplyPreview([], {
    type: "agent:reply",
    op: "start",
    agentId: "agent-1",
    channelId: "chan-1",
    streamId: "stream-1",
    name: "Xiaos",
  }, undefined, 1000);

  const done = applyAgentReplyPreview(start, {
    type: "agent:reply",
    op: "done",
    agentId: "agent-1",
    channelId: "chan-1",
    streamId: "stream-1",
    text: "final",
  }, undefined, 1200);

  assert.equal(done.length, 1);
  assert.equal(done[0]?.content, "", "done text should still reveal through the typewriter path");
  assert.equal((done[0] as any)?.streamTargetContent, "final");
  assert.equal((done[0] as any)?.streamDone, true);
});

test("real persisted agent message replaces the ephemeral preview", () => {
  const preview = applyAgentReplyPreview([], {
    type: "agent:reply",
    op: "delta",
    agentId: "agent-1",
    channelId: "chan-1",
    streamId: "stream-1",
    name: "Xiaos",
    text: "draft",
  });
  const real: Msg = {
    id: "msg-1",
    seq: 1,
    channelId: "chan-1",
    senderType: "agent",
    senderId: "agent-1",
    senderName: "Xiaos",
    content: "final",
  };

  assert.deepEqual(dropAgentReplyPreviewsForMessage(preview, real), []);
});

test("persisted agent message streams through the preview before replacing it", () => {
  const preview = applyAgentReplyPreview([], {
    type: "agent:reply",
    op: "start",
    agentId: "agent-1",
    channelId: "chan-1",
    streamId: "stream-1",
    name: "Xiaos",
  }, undefined, 1000);
  const real: Msg = {
    id: "msg-1",
    seq: 1,
    channelId: "chan-1",
    senderType: "agent",
    senderId: "agent-1",
    senderName: "Xiaos",
    content: "final",
  };

  const absorbed = absorbPersistedAgentMessagePreview(preview, real);
  assert.equal(absorbed.consumed, true);
  assert.equal(absorbed.messages[0]?.messageType, AGENT_REPLY_PREVIEW_TYPE);
  assert.equal(absorbed.messages[0]?.content, "");
  assert.equal((absorbed.messages[0] as any)?.streamTargetContent, "final");

  const visible = tickAgentReplyPreviews(absorbed.messages, 1, 1000 + AGENT_REPLY_PREVIEW_DELAY_MS);
  const oneTick = tickAgentReplyPreviews(visible.messages, 1, 1000 + AGENT_REPLY_PREVIEW_DELAY_MS + AGENT_REPLY_STREAM_TICK_MS);
  assert.equal(oneTick.messages[0]?.id, preview[0]?.id);
  assert.equal(oneTick.messages[0]?.content, "f");

  const typed = tickAgentReplyPreviews(oneTick.messages, 10, 1000 + AGENT_REPLY_PREVIEW_DELAY_MS + 20);
  assert.equal(typed.messages[0]?.id, preview[0]?.id, "fully typed text should settle briefly before swapping to the persisted message");
  assert.equal(typed.messages[0]?.messageType, AGENT_REPLY_PREVIEW_TYPE);
  assert.equal(typed.messages[0]?.content, "final");

  const beforeSettle = tickAgentReplyPreviews(typed.messages, 10, 1000 + AGENT_REPLY_PREVIEW_DELAY_MS + 20 + AGENT_REPLY_FINAL_SETTLE_MS - 1);
  assert.equal(beforeSettle.messages[0]?.id, preview[0]?.id);
  const finished = tickAgentReplyPreviews(beforeSettle.messages, 10, 1000 + AGENT_REPLY_PREVIEW_DELAY_MS + 20 + AGENT_REPLY_FINAL_SETTLE_MS);
  assert.equal(finished.messages[0]?.id, "msg-1");
  assert.equal(finished.messages[0]?.messageType, undefined);
  assert.equal(finished.messages[0]?.content, "final");
});

test("finalized agent preview keeps the preview render key to avoid remount jump", () => {
  const preview = applyAgentReplyPreview([], {
    type: "agent:reply",
    op: "start",
    agentId: "agent-1",
    channelId: "chan-1",
    streamId: "stream-1",
    name: "Xiaos",
  });
  const previewKey = agentReplyPreviewId("agent-1", "stream-1");
  const real: Msg = {
    id: "msg-1",
    seq: 1,
    channelId: "chan-1",
    senderType: "agent",
    senderId: "agent-1",
    senderName: "Xiaos",
    content: "final",
  };

  assert.equal(renderKeyForMessage(preview[0]!), previewKey);
  const absorbed = absorbPersistedAgentMessagePreview(preview, real);
  const now = Date.now();
  const visible = tickAgentReplyPreviews(absorbed.messages, 10, now + AGENT_REPLY_PREVIEW_DELAY_MS);
  const typed = tickAgentReplyPreviews(visible.messages, 10, now + AGENT_REPLY_PREVIEW_DELAY_MS + AGENT_REPLY_STREAM_TICK_MS);
  const finished = tickAgentReplyPreviews(typed.messages, 10, now + AGENT_REPLY_PREVIEW_DELAY_MS + AGENT_REPLY_FINAL_SETTLE_MS + AGENT_REPLY_STREAM_TICK_MS + 1);
  const final = finished.messages[0]!;

  assert.equal(final.id, "msg-1");
  assert.equal(renderKeyForMessage(final), previewKey);
  assert.equal(final.content, "final");
});

test("empty error keeps a visible failed preview instead of disappearing", () => {
  const preview = applyAgentReplyPreview([], {
    type: "agent:reply",
    op: "start",
    agentId: "agent-1",
    channelId: "chan-1",
    streamId: "stream-1",
    name: "Xiaos",
  });

  const failed = applyAgentReplyPreview(preview, {
    type: "agent:reply",
    op: "error",
    agentId: "agent-1",
    channelId: "chan-1",
    streamId: "stream-1",
  });

  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.messageType, AGENT_REPLY_PREVIEW_TYPE);
  assert.equal((failed[0] as any)?.streamError, true);
});

test("same-agent consecutive starts in one channel supersede the older pending preview", () => {
  const first = applyAgentReplyPreview([], {
    type: "agent:reply",
    op: "start",
    agentId: "agent-1",
    channelId: "chan-1",
    streamId: "stream-1",
    name: "Xiaos",
  });
  const second = applyAgentReplyPreview(first, {
    type: "agent:reply",
    op: "start",
    agentId: "agent-1",
    channelId: "chan-1",
    streamId: "stream-2",
    name: "Xiaos",
  });

  assert.equal(second.length, 1);
  assert.equal(second[0]?.id, "agent-reply:agent-1:stream-2");
});

test("stale stream delta cannot revive a superseded same-agent preview", () => {
  const first = applyAgentReplyPreview([], {
    type: "agent:reply",
    op: "start",
    agentId: "agent-1",
    channelId: "chan-1",
    streamId: "stream-1",
    name: "Xiaos",
  });
  const second = applyAgentReplyPreview(first, {
    type: "agent:reply",
    op: "start",
    agentId: "agent-1",
    channelId: "chan-1",
    streamId: "stream-2",
    name: "Xiaos",
  });
  const staleDelta = applyAgentReplyPreview(second, {
    type: "agent:reply",
    op: "delta",
    agentId: "agent-1",
    channelId: "chan-1",
    streamId: "stream-1",
    text: "old",
  });
  const latestDelta = applyAgentReplyPreview(staleDelta, {
    type: "agent:reply",
    op: "delta",
    agentId: "agent-1",
    channelId: "chan-1",
    streamId: "stream-2",
    text: "new",
  });

  assert.equal(staleDelta.length, 1);
  assert.equal(staleDelta[0]?.id, "agent-reply:agent-1:stream-2");
  assert.equal((staleDelta[0] as any)?.streamTargetContent, "");
  assert.equal((latestDelta[0] as any)?.streamTargetContent, "new");
});

test("a late delta for an already-absorbed stream does not spawn a ghost preview (real message already replaced it, no other preview active)", () => {
  // Simulates: agent posted its real message (tick already swapped the preview array entry to the
  // real persisted message), then the CLI keeps streaming a trailing remark for the same streamId.
  // Reproduces a real bug seen live: a claude turn that calls `message send` and then keeps talking
  // produced a channel-looking bubble with no backing row in the DB, gone on refresh.
  const realMessage = {
    id: "real-msg-1",
    channelId: "chan-1",
    senderType: "agent",
    senderId: "agent-1",
    senderName: "Xiaos",
    content: "the actual posted reply",
    messageType: "text",
    createdAt: new Date().toISOString(),
    seq: 6,
  } as any;
  const afterLateDelta = applyAgentReplyPreview([realMessage], {
    type: "agent:reply",
    op: "delta",
    agentId: "agent-1",
    channelId: "chan-1",
    streamId: "stream-1",
    text: "trailing remark after the tool call",
  });
  assert.equal(afterLateDelta.length, 1, "a stray delta with no active preview and no matching stream must not create a new one");
  assert.equal(afterLateDelta[0], realMessage);
});

test("a late done/error for an already-absorbed stream is a no-op (already covered by idx<0 guard, kept as a regression pin)", () => {
  const realMessage = { id: "real-msg-1", channelId: "chan-1", senderType: "agent", senderId: "agent-1", senderName: "Xiaos", content: "posted", messageType: "text", createdAt: new Date().toISOString(), seq: 6 } as any;
  const before = [realMessage];
  const afterDone = applyAgentReplyPreview(before, { type: "agent:reply", op: "done", agentId: "agent-1", channelId: "chan-1", streamId: "stream-1" });
  assert.equal(afterDone, before, "stale done for a vanished stream should return the same array reference untouched");
});

test("agent reply previews stay independent across agents and channels", () => {
  const first = applyAgentReplyPreview([], {
    type: "agent:reply",
    op: "start",
    agentId: "agent-1",
    channelId: "chan-1",
    streamId: "stream-1",
    name: "Xiaos",
  });
  const otherAgent = applyAgentReplyPreview(first, {
    type: "agent:reply",
    op: "start",
    agentId: "agent-2",
    channelId: "chan-1",
    streamId: "stream-2",
    name: "Lili",
  });
  const otherChannel = applyAgentReplyPreview(otherAgent, {
    type: "agent:reply",
    op: "start",
    agentId: "agent-1",
    channelId: "chan-2",
    streamId: "stream-3",
    name: "Xiaos",
  });

  assert.equal(otherChannel.length, 3);
  assert.deepEqual(otherChannel.map((m) => m.id), [
    "agent-reply:agent-1:stream-1",
    "agent-reply:agent-2:stream-2",
    "agent-reply:agent-1:stream-3",
  ]);
});

test("persisted agent message consumes all same-agent same-channel previews", () => {
  const first = applyAgentReplyPreview([], {
    type: "agent:reply",
    op: "start",
    agentId: "agent-1",
    channelId: "chan-1",
    streamId: "stream-1",
    name: "Xiaos",
  });
  const duplicate = [
    ...first,
    {
      ...first[0]!,
      id: agentReplyPreviewId("agent-1", "stream-2"),
      clientRenderKey: agentReplyPreviewId("agent-1", "stream-2"),
    } as Msg,
  ];
  const real: Msg = {
    id: "msg-1",
    seq: 1,
    channelId: "chan-1",
    senderType: "agent",
    senderId: "agent-1",
    senderName: "Xiaos",
    content: "final",
  };

  const absorbed = absorbPersistedAgentMessagePreview(duplicate, real);
  assert.equal(absorbed.consumed, true);
  assert.equal(absorbed.messages.length, 1);
  assert.equal(absorbed.messages[0]?.id, agentReplyPreviewId("agent-1", "stream-2"));
  assert.equal((absorbed.messages[0] as any)?.streamTargetContent, "final");
});

test("main chat and thread panel both consume agent reply preview events", () => {
  const chatSrc = fs.readFileSync(new URL("../web/src/views/Chat.tsx", import.meta.url), "utf8");

  assert.match(chatSrc, /e\.type === "agent:reply" && e\.channelId === cur\?\.id/);
  assert.match(chatSrc, /e\.type === "agent:reply" && e\.channelId === channelId/);
  assert.match(chatSrc, /hasStreamingAgentReplyPreview\(msgs\)/, "main chat should run the typewriter loop while a preview has pending text");
  assert.match(chatSrc, /tickAgentReplyPreviews/, "thread panel should use the same preview typewriter loop");
  assert.match(chatSrc, /dropAgentReplyPreviewsForMessage\(m, e\.message\), e\.message/);
  assert.match(chatSrc, /key=\{renderKeyForMessage\(m\)\}/, "finalized previews should keep the same React key instead of remounting");
  assert.match(chatSrc, /newMsgOrderRef\.current\.delete\(e\.message\.id\)/, "persisted messages absorbed by a preview should not get a second enter animation");
  assert.match(chatSrc, /forceBottomPinRef\.current = true/, "own messages and agent previews should force the chat viewport back to the live tail");
});

test("empty agent reply start previews render a visible thinking state", () => {
  const chatSrc = fs.readFileSync(new URL("../web/src/views/Chat.tsx", import.meta.url), "utf8");
  const en = fs.readFileSync(new URL("../web/src/locales/en.json", import.meta.url), "utf8");
  const zh = fs.readFileSync(new URL("../web/src/locales/zh.json", import.meta.url), "utf8");

  assert.match(chatSrc, /AGENT_REPLY_PREVIEW_TYPE/, "Chat should identify ephemeral agent reply previews");
  assert.match(chatSrc, /AgentReplyPreviewMsg/, "Chat should read preview error state without relying on persisted message content");
  assert.match(chatSrc, /agent-reply-placeholder/, "empty previews need a visible body before delta text arrives");
  assert.match(chatSrc, /!preview\.streamThinkingVisible/, "empty previews should stay visually empty until the delayed card appears with thinking");
  assert.match(chatSrc, /!agentReplyPreview\.streamVisible/, "hidden delayed previews should not mount a visible message card before the 1s delay");
  assert.match(chatSrc, /chat\.agentThinking/, "empty preview should show a localized thinking label");
  assert.match(chatSrc, /chat\.agentThinkingDone/, "completed empty preview should show a finished thinking label before settling");
  assert.match(chatSrc, /chat\.agentReplyError/, "failed preview should show a localized error label");
  assert.match(en, /"agentThinking": "Thinking\.\.\."/);
  assert.match(en, /"agentThinkingDone": "Thinking complete."/);
  assert.match(zh, /"agentThinking": "正在思考\.\.\."/);
  assert.match(zh, /"agentThinkingDone": "思考完成。"/);
});

test("server starts agent reply previews as soon as a message wakes an agent", () => {
  const coreSrc = fs.readFileSync(new URL("../src/server/core.ts", import.meta.url), "utf8");
  assert.match(coreSrc, /const replyStreamId = agentReplyStreamId\(msg!\.id, mem\.id\);/, "createMessage should derive a stable preview stream id from trigger message + agent");
  assert.match(coreSrc, /await publish\(opts\.serverId, \{ type: "agent:reply", agentId: mem\.id, channelId: opts\.channelId, streamId: replyStreamId,[\s\S]*?op: "start"/, "createMessage should publish preview start before waiting for daemon runtime output");
  assert.match(coreSrc, /streamId: replyStreamId/, "agent:deliver payload should pass the same stream id through to the daemon");
});

test("daemon reply preview can reuse a server-provided stream id", () => {
  const daemonSrc = fs.readFileSync(new URL("../src/daemon/agentManager.ts", import.meta.url), "utf8");
  const indexSrc = fs.readFileSync(new URL("../src/daemon/index.ts", import.meta.url), "utf8");
  assert.match(daemonSrc, /streamId\?: string/, "deliver metadata should accept a stable stream id");
  assert.match(daemonSrc, /streamId:\s*streamId \?\? `\$\{Date\.now\(\)\}-\$\{\+\+this\.replySeq\}`/, "daemon should prefer the server stream id and fall back only for older servers");
  assert.doesNotMatch(daemonSrc, /if \(existing\?\.channelId === channelId && streamId\) return;/, "a later server stream id in the same channel should not be ignored");
  assert.match(daemonSrc, /b\.streamId = meta\.streamId \?\? b\.streamId/, "debounced deliver should keep the latest server stream id so only the active preview receives deltas");
  assert.match(daemonSrc, /this\.startReplyPreview\(agentId, r, target, b\.streamId\)/, "debounced deliver should publish a new preview start when the active stream id changes");
  assert.match(indexSrc, /streamId: msg\.streamId/, "daemon websocket bridge should forward agent:deliver streamId into AgentManager");
});

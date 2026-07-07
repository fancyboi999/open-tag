import type { Agent, Msg } from "../store.tsx";

export interface AgentReplyEvent {
  type: "agent:reply";
  agentId: string;
  channelId: string;
  op: "start" | "delta" | "done" | "error";
  streamId: string;
  name?: string;
  text?: string;
}

export const AGENT_REPLY_PREVIEW_TYPE = "agent_reply_preview";
export const AGENT_REPLY_STREAM_TICK_MS = 12;
export const AGENT_REPLY_CHARS_PER_TICK = 3;
export const AGENT_REPLY_PREVIEW_DELAY_MS = 1000;
export const AGENT_REPLY_ENTER_DURATION_MS = 1000;
export const AGENT_REPLY_THINKING_DELAY_MS = 0;
export const AGENT_REPLY_THINKING_SHIMMER_MS = 4000;
export const AGENT_REPLY_FINAL_SETTLE_MS = 500;

export interface AgentReplyPreviewMsg extends Msg {
  // UI-only key that keeps the preview and final persisted message on the same React node.
  clientRenderKey?: string;
  streamTargetContent?: string;
  streamVisible?: boolean;
  streamVisibleAt?: number;
  streamThinkingVisible?: boolean;
  streamThinkingAt?: number;
  streamRevealAt?: number;
  streamSettledAt?: number;
  streamDone?: boolean;
  streamError?: boolean;
  streamFinalMessage?: Msg;
}

export function agentReplyPreviewId(agentId: string, streamId: string): string {
  return `agent-reply:${agentId}:${streamId}`;
}

export function renderKeyForMessage(m: Msg): string {
  return (m as AgentReplyPreviewMsg).clientRenderKey || m.id;
}

function withPreviewRenderKey(msg: Msg, preview: AgentReplyPreviewMsg): Msg {
  return { ...msg, clientRenderKey: preview.clientRenderKey || preview.id } as Msg;
}

function senderNameFor(e: AgentReplyEvent, agent?: Agent): string {
  return e.name || agent?.displayName || agent?.name || "Agent";
}

export function applyAgentReplyPreview(messages: Msg[], e: AgentReplyEvent, agent?: Agent, now = Date.now()): Msg[] {
  if (!e.agentId || !e.channelId || !e.streamId) return messages;
  const id = agentReplyPreviewId(e.agentId, e.streamId);
  const idx = messages.findIndex((m) => m.id === id);
  if (e.op === "done" || e.op === "error") {
    if (idx < 0) return messages;
    const current = messages[idx] as AgentReplyPreviewMsg;
    const target = (current.streamTargetContent ?? current.content) + (e.text || "");
    if (e.op === "error") {
      return messages.map((m, i) => i === idx ? { ...m, streamTargetContent: target, streamDone: false, streamError: true } as AgentReplyPreviewMsg : m);
    }
    if ((current.content || target).trim()) {
      return messages.map((m, i) => i === idx ? { ...m, streamTargetContent: target, streamDone: e.op === "done", streamError: e.op === "error", streamSettledAt: undefined } as AgentReplyPreviewMsg : m);
    }
    return messages.map((m, i) => i === idx ? { ...m, streamDone: true, streamError: false, streamSettledAt: undefined } as AgentReplyPreviewMsg : m);
  }
  if (idx >= 0) {
    if (e.op === "delta" && e.text) return messages.map((m, i) => {
      if (i !== idx) return m;
      const current = m as AgentReplyPreviewMsg;
      return { ...m, streamTargetContent: (current.streamTargetContent ?? current.content) + e.text, streamSettledAt: undefined } as AgentReplyPreviewMsg;
    });
    return messages;
  }
  // Only a "start" may originate a brand-new preview. A "delta" that doesn't match an existing
  // preview (idx<0) means its stream already finished and was absorbed into a real message (or
  // was superseded) — silently ignore it instead of spawning an orphan bubble with no persisted
  // message behind it. This mirrors the idx<0 guard "done"/"error" already had above; a runtime
  // that keeps streaming trailing text after its `message send` tool call reproduced exactly this
  // as a channel-looking bubble with nothing in the DB, gone on refresh.
  if (e.op !== "start") return messages;
  const withoutSuperseded = messages.filter((m) => !(m.messageType === AGENT_REPLY_PREVIEW_TYPE && m.channelId === e.channelId && m.senderId === e.agentId));
  const preview: AgentReplyPreviewMsg = {
    id,
    seq: Number.MAX_SAFE_INTEGER,
    channelId: e.channelId,
    senderType: "agent",
    senderId: e.agentId,
    senderName: senderNameFor(e, agent),
    content: "",
    messageType: AGENT_REPLY_PREVIEW_TYPE,
    createdAt: new Date().toISOString(),
    clientRenderKey: id,
    streamTargetContent: "",
    streamVisible: false,
    streamVisibleAt: now + AGENT_REPLY_PREVIEW_DELAY_MS,
    streamThinkingVisible: false,
    streamThinkingAt: now + AGENT_REPLY_PREVIEW_DELAY_MS + AGENT_REPLY_THINKING_DELAY_MS,
    streamRevealAt: now + AGENT_REPLY_PREVIEW_DELAY_MS,
  };
  return [...withoutSuperseded, preview];
}

export function dropAgentReplyPreviewsForMessage(messages: Msg[], msg: Msg): Msg[] {
  if (msg.senderType !== "agent" || !msg.senderId) return messages;
  return messages.filter((m) => !(m.messageType === AGENT_REPLY_PREVIEW_TYPE && m.channelId === msg.channelId && m.senderId === msg.senderId));
}

export function absorbPersistedAgentMessagePreview(messages: Msg[], msg: Msg): { messages: Msg[]; consumed: boolean } {
  if (msg.senderType !== "agent" || !msg.senderId) return { messages, consumed: false };
  const indexes = messages
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.messageType === AGENT_REPLY_PREVIEW_TYPE && m.channelId === msg.channelId && m.senderId === msg.senderId)
    .map(({ i }) => i);
  const idx = indexes[indexes.length - 1];
  if (idx === undefined) return { messages, consumed: false };
  const previewIndexes = new Set(indexes);
  return {
    consumed: true,
    messages: messages.flatMap((m, i) => {
      if (i === idx) return [{ ...m, streamTargetContent: msg.content, streamDone: true, streamSettledAt: undefined, streamFinalMessage: withPreviewRenderKey(msg, m as AgentReplyPreviewMsg) } as AgentReplyPreviewMsg];
      if (previewIndexes.has(i)) return [];
      return [m];
    }),
  };
}

export function hasStreamingAgentReplyPreview(messages: Msg[]): boolean {
  return messages.some((m) => {
    if (m.messageType !== AGENT_REPLY_PREVIEW_TYPE) return false;
    const preview = m as AgentReplyPreviewMsg;
    const target = preview.streamTargetContent ?? "";
    if (!preview.streamVisible) return true;
    if (!preview.streamThinkingVisible && !preview.streamDone && !preview.streamError && !target.trim()) return true;
    if (target.length > m.content.length) return true;
    return !!preview.streamDone && !preview.streamError && (!!preview.streamFinalMessage || !target.trim());
  });
}

export function tickAgentReplyPreviews(messages: Msg[], charsPerTick = AGENT_REPLY_CHARS_PER_TICK, now = Date.now()): { messages: Msg[]; changed: boolean } {
  let changed = false;
  const next: Msg[] = [];
  for (const m of messages) {
    if (m.messageType !== AGENT_REPLY_PREVIEW_TYPE) { next.push(m); continue; }
    const preview = m as AgentReplyPreviewMsg;
    const target = preview.streamTargetContent ?? "";
    if (!preview.streamVisible) {
      if (preview.streamVisibleAt && now >= preview.streamVisibleAt) {
        changed = true;
        const showThinking = !preview.streamDone
          && !preview.streamError
          && !target.trim()
          && !!preview.streamThinkingAt
          && now >= preview.streamThinkingAt;
        next.push({ ...preview, streamVisible: true, streamThinkingVisible: preview.streamThinkingVisible || showThinking } as AgentReplyPreviewMsg);
        continue;
      }
      next.push(m);
      continue;
    }
    if (!preview.streamThinkingVisible && !preview.streamDone && !preview.streamError && !target.trim() && preview.streamThinkingAt && now >= preview.streamThinkingAt) {
      changed = true;
      next.push({ ...preview, streamThinkingVisible: true } as AgentReplyPreviewMsg);
      continue;
    }
    if (preview.streamRevealAt && now < preview.streamRevealAt && target.length > m.content.length) {
      next.push(m);
      continue;
    }
    if (target.length <= m.content.length) {
      if (preview.streamDone && !preview.streamError && (!target.trim() || preview.streamFinalMessage)) {
        const settledAt = preview.streamSettledAt ?? now + AGENT_REPLY_FINAL_SETTLE_MS;
        if (now < settledAt) {
          if (!preview.streamSettledAt) changed = true;
          next.push({ ...preview, streamSettledAt: settledAt } as AgentReplyPreviewMsg);
          continue;
        }
        if (!preview.streamFinalMessage) {
          changed = true;
          continue;
        }
        changed = true;
        next.push(preview.streamFinalMessage);
        continue;
      }
      next.push(m);
      continue;
    }
    changed = true;
    const content = target.slice(0, Math.min(target.length, m.content.length + charsPerTick));
    if (content.length >= target.length && preview.streamFinalMessage && preview.streamDone) {
      next.push({ ...preview, content, streamSettledAt: now + AGENT_REPLY_FINAL_SETTLE_MS } as AgentReplyPreviewMsg);
      continue;
    }
    next.push({ ...m, content } as AgentReplyPreviewMsg);
  }
  return { messages: next, changed };
}

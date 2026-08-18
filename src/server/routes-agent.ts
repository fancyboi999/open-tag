// Agent-side REST: /agent-api/*  (Bearer per-agent token sk_agent_* + x-agent-id; NOT a machine/bootstrap key — see docs/authorization.md §1)
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq, ne, gt, lt, inArray, asc, desc, ilike, like, max, sql, isNull, isNotNull } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { sendJson, sendErr, readJson, bearer, agentIdHeader } from "./util.js";
import { resolveAgent } from "./auth.js";
import { createMessage, resolveTarget, channelMembers, addChannelMembers, addReaction, removeReaction, getOrCreateThread, unclaimTask, claimTask, setTaskStatus, convertMessageToTask, TASK_STATUSES, resolveMessageId, canAgentReadChannel, descTooLong, DESC_TOO_LONG, assignTask, resolveIdOrPrefix, wakeAgentForReplyCoordination } from "./core.js";
import { agentHasScope } from "./scopes.js";
import { senderAllowedByPolicy } from "./triggerPolicy.js";
import { applyPolicyView } from "./sanitizedView.js";
import { parseUpload } from "./attachments.js";
import { readObject } from "./storage.js";
import { authorizePendingDmGrants, canAgentManageCoordinatedTask, checkReplyGrant, claimReplyCoordination, coordinationHeader, decideReply, ensureReplyRecipients, finishReplyPublication, hasOutstandingReplyDecision, markReplyMessagesObserved, releaseReplyReservation, reserveReplyGrant } from "./replyCoordination.js";
import type { ReplySlot } from "./replyCoordinationPolicy.js";
import { validateDecisionInput } from "./replyCoordinationPolicy.js";
import { canonicalReplyTriggerMessageId } from "./conversationTurns.js";
import { conversationTurnDeliveryBlockReason } from "./daemonHub.js";
import { isConversationTurnCapabilityPaused } from "./conversationTurnRecovery.js";
import { CHANNEL_DELETED_NOTICE_KIND, channelDeletedNoticeForAgent, type ChannelDeletedNoticeMetadata } from "./channelDeletionNotice.js";
import { inputSenderAllowed } from "./agentInputPolicy.js";
import { agentInputVisible, filterAgentInputView } from "./agentInputView.js";

// Freshness-hold draft buffer (prevents agent↔agent duplicate replies): when the agent sends
// and new messages have arrived since last read → save as draft + surface bounded context, do not post immediately.
// Agent can revise (send again to same target) or submit unchanged with `--send-draft`.
// Key = `agentId:channelId`, short-lived in-process (discarded on restart — acceptable, drafts are ephemeral by design).
const drafts = new Map<string, { content: string; attachmentIds: string[]; replyToMessageId?: string; reviewedMessageIds: string[] }>();

// /agent-api action → required scope. Default mode grants all; custom mode enforces per granted list.
function requiredScope(p: string): string | null {
  if (p === "/agent-api/message/check") return "inbox:receive";
  if (p === "/agent-api/message/send") return "message:send";
  if (p === "/agent-api/message/decide") return "inbox:receive";
  if (p === "/agent-api/message/read") return "message:read";
  if (p === "/agent-api/message/react") return "message:send";
  if (p === "/agent-api/server/info") return "server:read";
  if (p === "/agent-api/channel/join") return "channel:join";
  if (p === "/agent-api/task/list") return "task:read";
  if (p === "/agent-api/task/claim" || p === "/agent-api/task/update" || p === "/agent-api/task/new" || p === "/agent-api/task/assign") return "task:write";
  if (p === "/agent-api/search") return "message:read";
  if (p === "/agent-api/attachment/upload") return "attachment:upload";
  if (p === "/agent-api/thread/reply") return "message:send";
  if (p === "/agent-api/thread/read") return "message:read";
  if (p === "/agent-api/message/resolve") return "message:read";
  if (p === "/agent-api/channel/members") return "channel:read";
  if (p === "/agent-api/channel/leave") return "channel:leave";
  if (p === "/agent-api/task/unclaim") return "task:write";
  if (p === "/agent-api/thread/unfollow") return "thread:unfollow";
  if (p === "/agent-api/attachment/view") return "attachment:view";
  if (p === "/agent-api/profile/show") return "server:read";
  if (p === "/agent-api/action/prepare") return "action:prepare";
  // profile/update has no scope requirement (own profile)
  return null;
}

async function agentChannels(agentId: string) {
  return db.select().from(schema.channelMembers).where(and(eq(schema.channelMembers.memberType, "agent"), eq(schema.channelMembers.memberId, agentId)));
}

async function durableTurnActionBlockReason(serverId: string, machineId: string | null, agentId: string, messageId: string): Promise<string | null> {
  const row = (await db.select({
    turnId: schema.messages.conversationTurnId,
    state: schema.conversationTurns.state,
    dispatchLeaseUntil: schema.conversationTurns.dispatchLeaseUntil,
  }).from(schema.messages)
    .leftJoin(schema.conversationTurns, eq(schema.conversationTurns.id, schema.messages.conversationTurnId))
    .where(and(eq(schema.messages.id, messageId), eq(schema.messages.serverId, serverId))).limit(1))[0];
  if (!row?.turnId) return null;
  if (row.state && isConversationTurnCapabilityPaused({ state: row.state, dispatchLeaseUntil: row.dispatchLeaseUntil })) {
    return "conversation turn paused for daemon capability";
  }
  const recipient = (await db.select({
    admittedAt: schema.agentMessageDecisions.deliveryAdmittedAt,
    attention: schema.agentMessageDecisions.attention,
  })
    .from(schema.agentMessageDecisions).where(and(
      eq(schema.agentMessageDecisions.messageId, messageId),
      eq(schema.agentMessageDecisions.agentId, agentId),
    )).limit(1))[0];
  if (recipient?.admittedAt || recipient?.attention === "ambient") return null;
  return conversationTurnDeliveryBlockReason(serverId, machineId)
    ?? "conversation turn is queued for runtime delivery";
}

async function agentHasCapabilityPausedTurn(agentId: string): Promise<boolean> {
  const rows = await db.select({
    state: schema.conversationTurns.state,
    dispatchLeaseUntil: schema.conversationTurns.dispatchLeaseUntil,
  }).from(schema.agentMessageDecisions)
    .innerJoin(schema.conversationTurns, eq(schema.conversationTurns.triggerMessageId, schema.agentMessageDecisions.messageId))
    .where(and(
      eq(schema.agentMessageDecisions.agentId, agentId),
      inArray(schema.agentMessageDecisions.grantStatus, ["reserved", "active", "publishing"]),
      eq(schema.conversationTurns.state, "active"),
    ));
  return rows.some(isConversationTurnCapabilityPaused);
}

/** Human-readable addressable target: channel → #name; DM → dm:@peer; thread → <parentChannelTarget>:parentMessageShortId. Agent uses this to reply back to the same location. */
export async function addressableTarget(ch: typeof schema.channels.$inferSelect, selfAgentId: string): Promise<string> {
  // Thread channel: render as #parentChannel:shortid (or dm:@peer:shortid) so the agent can reuse it with message send --target
  if (ch.type === "thread" && ch.parentMessageId) {
    // Stable across public/private/DM and across different agent viewpoints: a new assignee may only be
    // a member of the thread itself, not of the parent DM/private channel, so caller-relative parent targets
    // like dm:@peer:shortid do not round-trip reliably after handoff. Use thread:<parentShortId> instead.
    return `thread:${ch.parentMessageId.slice(0, 8)}`;
  }
  if (ch.type === "dm") {
    const members = await db.select().from(schema.channelMembers).where(eq(schema.channelMembers.channelId, ch.id));
    const peer = members.find((m) => !(m.memberType === "agent" && m.memberId === selfAgentId));
    if (peer) {
      const name = peer.memberType === "user"
        ? (await db.select().from(schema.users).where(eq(schema.users.id, peer.memberId)))[0]?.name
        : (await db.select().from(schema.agents).where(eq(schema.agents.id, peer.memberId)))[0]?.name;
      if (name) return `dm:@${name}`;
    }
    return `dm:${ch.id}`;
  }
  return `#${ch.name}`;
}
// Message header: target uses human-readable address string (not channelId); thread messages append :shortid suffix
const pad2 = (n: number) => String(n).padStart(2, "0");
// Local YYYY-MM-DD HH:MM:SS format for message header time= field (not ISO)
const localTime = (d: Date | string | null | undefined) => { const t = d instanceof Date ? d : new Date(d ?? Date.now()); return `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())} ${pad2(t.getHours())}:${pad2(t.getMinutes())}:${pad2(t.getSeconds())}`; };
// Message rendering: header + task suffix [task #N status=] + attachment suffix
export const fmt = (m: typeof schema.messages.$inferSelect, target: string, atts: { filename: string; id: string }[] = [], coordination?: Parameters<typeof coordinationHeader>[0]) => {
  const taskSuffix = m.taskStatus ? ` [task #${m.taskNumber} status=${m.taskStatus}]` : "";
  const attSuffix = atts.length ? ` [${atts.length} attachment${atts.length > 1 ? "s" : ""}: ${atts.map((a) => `${a.filename} (id:${a.id})`).join(", ")} — use open-tag attachment view to download]` : "";
  const type = m.senderType === "user" ? "human" : m.senderType; // message header uses "human" for human senders, not "user"
  // A thread-anchor message (m.threadId set = the thread it owns) is rendered as #chan:<this message's id>
  // — NOT the thread channel id — because resolveTarget resolves the suffix as a PARENT MESSAGE id prefix
  // (matches addressableTarget's convention). Using the thread channel id here made the shown target
  // unresolvable (404), so agents reusing it couldn't reply into the thread. See threadTargetRoundtrip test.
  return `[target=${target}${m.threadId ? ":" + m.id.slice(0, 8) : ""} msg=${m.id.slice(0, 8)}${coordinationHeader(coordination)} time=${localTime(m.createdAt)} type=${type}] @${m.senderName}: ${m.content}${taskSuffix}${attSuffix}`;
};

type InboxMessage = typeof schema.messages.$inferSelect;

type ClaimedChannelDeletionNotice = {
  message: InboxMessage;
  metadata: ChannelDeletedNoticeMetadata;
};

async function claimChannelDeletionNotices(
  serverId: string,
  agentId: string,
): Promise<ClaimedChannelDeletionNotice[]> {
  return db.transaction(async (tx) => {
    const candidates = await tx.select({
      message: schema.messages,
    }).from(schema.messages)
      .innerJoin(schema.channels, eq(schema.channels.id, schema.messages.channelId))
      .leftJoin(schema.agentMessageObservations, and(
        eq(schema.agentMessageObservations.messageId, schema.messages.id),
        eq(schema.agentMessageObservations.agentId, agentId),
      ))
      .where(and(
        eq(schema.messages.serverId, serverId),
        eq(schema.channels.serverId, serverId),
        isNotNull(schema.channels.deletedAt),
        eq(schema.messages.senderType, "system"),
        eq(schema.messages.messageType, "system"),
        isNull(schema.agentMessageObservations.messageId),
        sql<boolean>`${schema.messages.actionMetadata} @> ${JSON.stringify({
          kind: CHANNEL_DELETED_NOTICE_KIND,
          recipientAgentIds: [agentId],
        })}::jsonb`,
        sql<boolean>`${schema.messages.actionMetadata}->>'channelId' = ${schema.messages.channelId}::text`,
      ))
      .orderBy(asc(schema.messages.seq))
      .limit(100);
    const valid = candidates.flatMap(({ message }) => {
      const metadata = channelDeletedNoticeForAgent(message.actionMetadata, message.channelId, agentId);
      return metadata ? [{ message, metadata }] : [];
    });
    if (!valid.length) return [];

    const inserted = await tx.insert(schema.agentMessageObservations).values(valid.map(({ message }) => ({
      messageId: message.id,
      agentId,
      serverId,
    }))).onConflictDoNothing().returning({ messageId: schema.agentMessageObservations.messageId });
    const claimedIds = new Set(inserted.map(({ messageId }) => messageId));
    const claimed = valid.filter(({ message }) => claimedIds.has(message.id));
    if (!claimed.length) return [];

    const channelIds = [...new Set(claimed.map(({ message }) => message.channelId))];
    const watermarks = await tx.select({
      channelId: schema.messages.channelId,
      seq: max(schema.messages.seq),
    }).from(schema.messages)
      .where(and(eq(schema.messages.serverId, serverId), inArray(schema.messages.channelId, channelIds)))
      .groupBy(schema.messages.channelId);
    for (const watermark of watermarks) {
      await tx.update(schema.channelMembers).set({
        lastReadSeq: sql<number>`greatest(${schema.channelMembers.lastReadSeq}, ${Number(watermark.seq ?? 0)})`,
      }).where(and(
        eq(schema.channelMembers.channelId, watermark.channelId),
        eq(schema.channelMembers.memberType, "agent"),
        eq(schema.channelMembers.memberId, agentId),
      ));
    }
    return claimed;
  });
}

async function classifyInboxVisibility(opts: {
  agentId: string;
  messages: InboxMessage[];
  durableDeliveryBlock: string | null;
  purpose: "inbox" | "freshness";
}): Promise<{
  visible: InboxMessage[];
  cursorPrefix: InboxMessage[];
  capabilityPaused: boolean;
  topologyBlocked: boolean;
}> {
  const turnIds = [...new Set(opts.messages.flatMap((message) => message.conversationTurnId ? [message.conversationTurnId] : []))];
  const turnRows = turnIds.length
    ? await db.select({
      id: schema.conversationTurns.id,
      state: schema.conversationTurns.state,
      boundaryKind: schema.conversationTurns.boundaryKind,
      triggerMessageId: schema.conversationTurns.triggerMessageId,
      dispatchLeaseUntil: schema.conversationTurns.dispatchLeaseUntil,
    }).from(schema.conversationTurns).where(inArray(schema.conversationTurns.id, turnIds))
    : [];
  const triggerIds = [...new Set(turnRows.map((turn) => turn.triggerMessageId))];
  const recipientRows = triggerIds.length
    ? await db.select({
      messageId: schema.agentMessageDecisions.messageId,
      attention: schema.agentMessageDecisions.attention,
      deliveryAdmittedAt: schema.agentMessageDecisions.deliveryAdmittedAt,
    }).from(schema.agentMessageDecisions).where(and(
      eq(schema.agentMessageDecisions.agentId, opts.agentId),
      inArray(schema.agentMessageDecisions.messageId, triggerIds),
    ))
    : [];
  const recipientByTrigger = new Map(recipientRows.map((row) => [row.messageId, row]));
  const stableStates = new Set(["active", "dispatched", "blocked"]);
  let capabilityPaused = false;
  let topologyBlocked = false;
  const turnInboxVisible = new Map<string, boolean>();
  const turnPurposeVisible = new Map<string, boolean>();
  for (const turn of turnRows) {
    if (isConversationTurnCapabilityPaused(turn)) {
      capabilityPaused = true;
    }
    const recipient = recipientByTrigger.get(turn.triggerMessageId);
    const admissionBlocked = !!recipient && recipient.attention !== "ambient" && !recipient.deliveryAdmittedAt;
    if (admissionBlocked) {
      if (opts.durableDeliveryBlock) topologyBlocked = true;
    }
    const inboxVisible = !isConversationTurnCapabilityPaused(turn)
      && !admissionBlocked
      && stableStates.has(turn.state);
    turnInboxVisible.set(turn.id, inboxVisible);
    turnPurposeVisible.set(turn.id, inboxVisible || (opts.purpose === "freshness" && turn.boundaryKind === "ambient"));
  }
  const isCursorSafe = (message: InboxMessage) => message.senderId === opts.agentId
    || !message.conversationTurnId
    || turnInboxVisible.get(message.conversationTurnId) === true;
  const isVisible = (message: InboxMessage) => message.senderId === opts.agentId
    || !message.conversationTurnId
    || turnPurposeVisible.get(message.conversationTurnId) === true;
  const blockedIndex = opts.messages.findIndex((message) => message.senderId !== opts.agentId
    && !!message.conversationTurnId
    && !isCursorSafe(message));
  return {
    visible: opts.messages.filter(isVisible),
    cursorPrefix: blockedIndex >= 0 ? opts.messages.slice(0, blockedIndex) : opts.messages,
    capabilityPaused,
    topologyBlocked,
  };
}

export async function handleAgentApi(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean> {
  const p = url.pathname;
  if (!p.startsWith("/agent-api/")) return false;

  const agent = await resolveAgent(bearer(req), agentIdHeader(req));
  if (!agent) return (sendErr(res, 401, "unauthorized (need Bearer sk_agent_* token + x-agent-id header)"), true);
  const serverId = agent.serverId;

  // Scope enforcement: in custom mode, missing scope → 403 (in default mode effectiveScopes returns all, passes through)
  const need = requiredScope(p);
  if (need && !agentHasScope(agent.scopes, need)) return (sendErr(res, 403, `missing scope: ${need}`, { code: "SCOPE_DENIED", scope: need }), true);

  // Poll for new messages (non-blocking): messages in agent's channels with seq > lastReadSeq, then advance lastReadSeq
  if (p === "/agent-api/message/check" && method === "GET") {
    const durableDeliveryBlock = conversationTurnDeliveryBlockReason(serverId, agent.machineId);
    let capabilityPaused = await agentHasCapabilityPausedTurn(agent.id);
    let topologyBlocked = false;
    if (!durableDeliveryBlock) await authorizePendingDmGrants(agent.id);
    const out: any[] = [];
    const deletionNotices = await claimChannelDeletionNotices(serverId, agent.id);
    out.push(...deletionNotices.map(({ message, metadata }) => ({
      ...serialize(message),
      coordination: null,
      text: fmt(message, `#${metadata.channelName}`),
    })));
    const cms = await agentChannels(agent.id);
    for (const cm of cms) {
      const ch = (await db.select().from(schema.channels).where(eq(schema.channels.id, cm.channelId)))[0];
      if (!ch || ch.deletedAt) continue;
      const unread = await db.select().from(schema.messages).where(and(eq(schema.messages.channelId, cm.channelId), ne(schema.messages.messageType, "agent_activity_receipt"), gt(schema.messages.seq, cm.lastReadSeq))).orderBy(asc(schema.messages.seq)).limit(100);
      const visibility = await classifyInboxVisibility({ agentId: agent.id, messages: unread, durableDeliveryBlock, purpose: "inbox" });
      capabilityPaused ||= visibility.capabilityPaused;
      topologyBlocked ||= visibility.topologyBlocked;
      // Trigger-source policy: sealed drops non-whitelisted agent text; sanitized replaces it
      // with the stateless gateway's disinfected output (fail closed when gateway unavailable).
      const pol = await applyPolicyView(serverId, agent.machineId, agent, visibility.visible);
      const stable = pol.view;
      const sanitizedIds = pol.replaced;
      const stableForeign = stable.filter((message) => message.senderType !== "agent" || message.senderId !== agent.id);
      const observedRows = stableForeign.length
        ? await db.select({ messageId: schema.agentMessageObservations.messageId }).from(schema.agentMessageObservations).where(and(
          eq(schema.agentMessageObservations.agentId, agent.id),
          inArray(schema.agentMessageObservations.messageId, stableForeign.map((message) => message.id)),
        ))
        : [];
      const observed = new Set(observedRows.map((row) => row.messageId));
      const fresh = stableForeign.filter((message) => !observed.has(message.id));
      if (fresh.length) {
        const target = await addressableTarget(ch, agent.id);
        // A check can expose non-wakeable ambient agent chatter alongside another delivery. Backfill its
        // observation row here so every message the agent actually sees can be judged (usually no_action)
        // without changing the anti-loop wake policy.
        const ownMentions = await db.select({ messageId: schema.messageMentions.messageId }).from(schema.messageMentions).where(and(
          inArray(schema.messageMentions.messageId, fresh.map((m) => m.id)),
          eq(schema.messageMentions.mentionType, "agent"),
          eq(schema.messageMentions.mentionId, agent.id),
        ));
        const mentionedIds = new Set(ownMentions.map((m) => m.messageId));
        for (const message of fresh) await ensureReplyRecipients({
          serverId, channelId: cm.channelId, messageId: message.id,
          recipients: [{ agentId: agent.id, attention: sanitizedIds.has(message.id) ? "ambient" : ch.type === "dm" ? "dm" : mentionedIds.has(message.id) ? "direct" : "ambient" }],
        });
        const coordination = await markReplyMessagesObserved(agent.id, fresh.map((m) => m.id));
        await db.insert(schema.agentMessageObservations).values(fresh.map((message) => ({
          messageId: message.id,
          agentId: agent.id,
          serverId,
        }))).onConflictDoNothing();
        // Batch-load attachments → append attachment suffix to message header
        const atts = await db.select().from(schema.attachments).where(inArray(schema.attachments.messageId, fresh.map((m) => m.id)));
        const byMsg = new Map<string, { filename: string; id: string }[]>();
        for (const a of atts) { const k = a.messageId!; const arr = byMsg.get(k) ?? []; arr.push({ filename: a.filename, id: a.id }); byMsg.set(k, arr); }
        out.push(...fresh.map((m) => ({ ...serialize(m), coordination: coordination.get(m.id) ?? null, text: fmt(m, target, byMsg.get(m.id) ?? [], coordination.get(m.id)) })));
      }
      // Persisted observation de-duplicates stable messages beyond a collecting gap. The scalar channel
      // cursor advances only through the contiguous prefix, so the hidden Turn cannot be skipped forever.
      if (visibility.cursorPrefix.length) await db.update(schema.channelMembers).set({ lastReadSeq: sql<number>`greatest(${schema.channelMembers.lastReadSeq}, ${visibility.cursorPrefix.at(-1)!.seq})` })
        .where(and(eq(schema.channelMembers.channelId, cm.channelId), eq(schema.channelMembers.memberType, "agent"), eq(schema.channelMembers.memberId, agent.id)));
    }
    const coordination: any[] = [];
    for (const update of durableDeliveryBlock ? [] : await claimReplyCoordination(serverId, agent.id)) {
      const requester = (await db.select({ name: schema.agents.name }).from(schema.agents).where(and(
        eq(schema.agents.id, update.requesterAgentId), eq(schema.agents.serverId, serverId),
      )))[0];
      const ch = (await db.select().from(schema.channels).where(and(eq(schema.channels.id, update.channelId), eq(schema.channels.serverId, serverId))))[0];
      if (!requester || !ch) continue;
      const target = await addressableTarget(ch, agent.id);
      const summary = update.summary ? ` summary=${JSON.stringify(update.summary)}` : "";
      const text = update.kind === "request"
        ? `[coordination target=${target} msg=${update.messageId.slice(0, 8)} requester=@${requester.name} reason=${update.reasonCode}${summary}] Decide again: delegate to @${requester.name} or accept to keep the primary reply. This is private coordination, not a channel message.`
        : `[coordination target=${target} msg=${update.messageId.slice(0, 8)} grant=primary reason=${update.reasonCode}${summary}] The primary reply was transferred to you. Publish one reply with --reply-to ${update.messageId.slice(0, 8)}, or abstain if the context changed. This is private coordination, not a channel message.`;
      coordination.push({
        messageId: update.messageId, requesterAgentId: update.requesterAgentId, requester: requester.name,
        kind: update.kind, reason: update.reasonCode, target, grant: "primary", text,
      });
    }
    return (sendJson(res, 200, {
      messages: out,
      coordination,
      warnings: topologyBlocked || capabilityPaused ? [{
        code: "DELIVERY_ADMISSION_REQUIRED",
        detail: topologyBlocked ? durableDeliveryBlock : "conversation turn paused for daemon capability",
      }] : [],
    }), true);
  }

  if (p === "/agent-api/message/decide" && method === "POST") {
    const b = await readJson(req);
    const valid = validateDecisionInput({ decision: b.decision, reason: b.reason, toAgentId: b.to });
    if (!valid.ok) return (sendErr(res, 400, "invalid reply decision", { code: valid.code }), true);
    const resolvedMessageId = await resolveMessageId(serverId, b.messageId, agent.id);
    if (!resolvedMessageId) return (sendErr(res, 404, "message not found", { code: "MESSAGE_NOT_FOUND" }), true);
    const messageId = await canonicalReplyTriggerMessageId(resolvedMessageId);
    const durableActionBlock = await durableTurnActionBlockReason(serverId, agent.machineId, agent.id, messageId);
    if (durableActionBlock) return (sendErr(res, 409, "durable delivery admission required", { code: "DELIVERY_ADMISSION_REQUIRED", detail: durableActionBlock }), true);
    let delegateToAgentId: string | undefined;
    if (valid.decision === "delegate") {
      const name = String(b.to ?? "").trim().replace(/^@/, "");
      delegateToAgentId = (await db.select({ id: schema.agents.id }).from(schema.agents).where(and(
        eq(schema.agents.serverId, serverId), eq(schema.agents.name, name), isNull(schema.agents.deletedAt),
      )))[0]?.id;
      if (!delegateToAgentId) return (sendErr(res, 404, "delegate target not found", { code: "DELEGATE_TARGET_NOT_FOUND" }), true);
    }
    const result = await decideReply({
      serverId, agentId: agent.id, messageId, decision: valid.decision,
      reason: valid.reason, summary: typeof b.summary === "string" ? b.summary : undefined,
      delegateToAgentId,
    });
    if (!result.ok) {
      const status = result.code === "INPUT_SOURCE_REJECTED" ? 403 : 409;
      return (sendErr(res, status, "reply decision rejected", { code: result.code }), true);
    }
    if (result.notifyAgentId) await wakeAgentForReplyCoordination(serverId, result.notifyAgentId, messageId, agent.name);
    if (result.promotedAgentId) await wakeAgentForReplyCoordination(serverId, result.promotedAgentId, messageId, agent.name);
    return (sendJson(res, 200, {
      ok: true, messageId, decision: result.row.decision,
      grant: result.row.grantStatus === "active" ? result.row.grantSlot : null,
      promotedAgentId: result.promotedAgentId ?? null,
      notifiedAgentId: result.notifyAgentId ?? null,
    }), true);
  }

  if (p === "/agent-api/message/send" && method === "POST") {
    const b = await readJson(req);
    const atts = Array.isArray(b.attachmentIds) ? b.attachmentIds.filter(Boolean) : [];
    if (!b.target) return (sendErr(res, 400, "target required"), true);
    const tgt = await resolveTarget(serverId, b.target, agent.id);
    if (!tgt) return (sendErr(res, 404, "target not found", { code: "TARGET_FAILED" }), true);
    const draftKey = `${agent.id}:${tgt.channelId}`;
    const resolveTrigger = async (raw: unknown): Promise<string | null> => {
      const resolved = raw ? await resolveMessageId(serverId, String(raw), agent.id) : null;
      return resolved ? canonicalReplyTriggerMessageId(resolved) : null;
    };
    let replyToMessageId = await resolveTrigger(b.replyTo);
    if (b.replyTo && !replyToMessageId) return (sendErr(res, 404, "reply trigger not found", { code: "REPLY_TRIGGER_NOT_FOUND" }), true);
    const existingDraft = drafts.get(draftKey);
    const savedDraft = b.sendDraft ? existingDraft : undefined;
    replyToMessageId = savedDraft?.replyToMessageId ?? replyToMessageId;
    if (replyToMessageId) {
      const durableActionBlock = await durableTurnActionBlockReason(serverId, agent.machineId, agent.id, replyToMessageId);
      if (durableActionBlock) return (sendErr(res, 409, "durable delivery admission required", { code: "DELIVERY_ADMISSION_REQUIRED", detail: durableActionBlock }), true);
      const preflight = await checkReplyGrant({ serverId, agentId: agent.id, messageId: replyToMessageId, channelId: tgt.channelId });
      if (!preflight.ok) return (sendErr(res, 409, "reply not granted", { code: preflight.code }), true);
    } else if (await hasOutstandingReplyDecision(agent.id, tgt.channelId)) {
      return (sendErr(res, 409, "reply context required", { code: "REPLY_CONTEXT_REQUIRED" }), true);
    }
    const post = async (content: string, attachmentIds: string[], triggerId?: string) => {
      let slot: ReplySlot | undefined;
      if (triggerId) {
        const reserved = await reserveReplyGrant({ serverId, agentId: agent.id, messageId: triggerId, channelId: tgt.channelId });
        if (!reserved.ok) return (sendErr(res, 409, "reply not granted", { code: reserved.code }), true);
        slot = reserved.slot;
      } else if (await hasOutstandingReplyDecision(agent.id, tgt.channelId)) {
        return (sendErr(res, 409, "reply context required", { code: "REPLY_CONTEXT_REQUIRED" }), true);
      }
      drafts.delete(draftKey);
      try {
        const msg = await createMessage({ serverId, channelId: tgt.channelId, senderType: "agent", senderId: agent.id, senderName: agent.name, content, threadId: tgt.threadId, attachmentIds: attachmentIds.length ? attachmentIds : undefined, replyToMessageId: triggerId, replyGrantSlot: slot });
        if (triggerId) await finishReplyPublication({ messageId: triggerId, agentId: agent.id, replyMessageId: msg.id });
        return (sendJson(res, 200, { ok: true, id: msg.id, seq: msg.seq, target: b.target, replyTo: triggerId ?? null, replySlot: slot ?? null }), true);
      } catch (e) {
        if (triggerId) await releaseReplyReservation(triggerId, agent.id);
        const code = (e as any)?.cause?.code ?? (e as any)?.code;
        if (code === "23505") return (sendErr(res, 409, "reply grant already published", { code: "REPLY_GRANT_CONSUMED" }), true);
        throw e;
      }
    };
    // --send-draft: submit existing draft as-is, bypassing freshness check
    if (b.sendDraft) {
      const d = savedDraft;
      const content = d?.content ?? b.content ?? ""; const dAtts = (d?.attachmentIds?.length ? d.attachmentIds : atts);
      if (!content && !dAtts.length) return (sendErr(res, 400, "no draft to send"), true);
      replyToMessageId = d?.replyToMessageId ?? replyToMessageId;
      return post(content, dAtts, replyToMessageId ?? undefined);
    }
    if (!b.content && !atts.length) return (sendErr(res, 400, "target + content (or attachmentIds) required"), true);
    // Freshness-hold: new messages arrived since agent last read (not self / not system) → save draft + surface bounded context, do not post immediately (prevents agent↔agent duplicate replies)
    const cm = (await db.select().from(schema.channelMembers).where(and(eq(schema.channelMembers.channelId, tgt.channelId), eq(schema.channelMembers.memberType, "agent"), eq(schema.channelMembers.memberId, agent.id))))[0];
    const lastRead = cm?.lastReadSeq ?? 0;
    const unread = await db.select().from(schema.messages).where(and(eq(schema.messages.channelId, tgt.channelId), ne(schema.messages.messageType, "agent_activity_receipt"), gt(schema.messages.seq, lastRead))).orderBy(asc(schema.messages.seq)).limit(20);
    const visibility = await classifyInboxVisibility({
      agentId: agent.id,
      messages: unread,
      durableDeliveryBlock: conversationTurnDeliveryBlockReason(serverId, agent.machineId),
      purpose: "freshness",
    });
    const protectedVisible = await filterAgentInputView(agent, visibility.visible);
    const visibleForeign = protectedVisible.filter((m) => m.senderId !== agent.id && m.senderType !== "system");
    const observedRows = visibleForeign.length
      ? await db.select({ messageId: schema.agentMessageObservations.messageId }).from(schema.agentMessageObservations).where(and(
        eq(schema.agentMessageObservations.agentId, agent.id),
        inArray(schema.agentMessageObservations.messageId, visibleForeign.map((message) => message.id)),
      ))
      : [];
    const alreadyReviewed = new Set([...(existingDraft?.reviewedMessageIds ?? []), ...observedRows.map((row) => row.messageId)]);
    const newer = visibleForeign.filter((message) => !alreadyReviewed.has(message.id));
    if (newer.length && cm) {
      drafts.set(draftKey, {
        content: b.content || "",
        attachmentIds: atts,
        replyToMessageId: replyToMessageId ?? undefined,
        reviewedMessageIds: [...new Set([...(existingDraft?.reviewedMessageIds ?? []), ...newer.map((message) => message.id)])],
      });
      if (visibility.cursorPrefix.length) await db.update(schema.channelMembers).set({ lastReadSeq: sql<number>`greatest(${schema.channelMembers.lastReadSeq}, ${visibility.cursorPrefix.at(-1)!.seq})` }).where(and(eq(schema.channelMembers.channelId, tgt.channelId), eq(schema.channelMembers.memberType, "agent"), eq(schema.channelMembers.memberId, agent.id))); // Advance only through the contiguous admitted prefix; a queued Turn must remain unread.
      const ch = (await db.select().from(schema.channels).where(eq(schema.channels.id, tgt.channelId)))[0]!;
      const tname = await addressableTarget(ch, agent.id);
      const history = newer.map((m) => fmt(m, tname)).join("\n");
      const n = newer.length, pl = n > 1 ? "s" : "";
      const replyArg = replyToMessageId ? ` --reply-to ${replyToMessageId.slice(0, 8)}` : "";
      const text = `Freshness hold: showing latest ${n} of ${n} newer message${pl}.\nYour message has been saved as a draft. Review the bounded context shown here, then choose one path.\n\n## Message History for ${tname} (${n} message${pl})\n\n${history}\n\nTo update the draft, send revised content normally:\n  open-tag message send${replyArg} --target "${b.target}" <<'MSG'\n  revised message\n  MSG\nTo send the current draft unchanged:\n  open-tag message send --send-draft${replyArg} --target "${b.target}"`;
      return (sendJson(res, 200, { held: true, draft: true, newerCount: n, messages: newer.map((m) => ({ ...serialize(m), text: fmt(m, tname) })), text }), true);
    }
    return post(b.content || "", atts, replyToMessageId ?? undefined);
  }
  // action prepare: agent lacks channel:create/agent:create scope, so to create resources it posts a "proposal card" → human clicks → pre-filled dialog → human creates under their own identity.
  // message messageType=action + actionMetadata{kind:"action-card",state:"prepared",action}. Variants: channel:create / agent:create.
  if (p === "/agent-api/action/prepare" && method === "POST") {
    const b = await readJson(req);
    const action = b.action;
    if (!action || typeof action !== "object") return (sendErr(res, 400, "action (object) required on stdin", { code: "BAD_ACTION" }), true);
    const ty = String(action.type ?? "");
    if (ty !== "channel:create" && ty !== "agent:create") return (sendErr(res, 400, `unsupported action.type "${ty}" (only channel:create / agent:create)`, { code: "BAD_ACTION" }), true);
    if (!String(action.name ?? "").trim()) return (sendErr(res, 400, "action.name required", { code: "BAD_ACTION" }), true);
    const tgt = await resolveTarget(serverId, String(b.target ?? ""), agent.id);
    if (!tgt) return (sendErr(res, 404, "target not found", { code: "TARGET_FAILED" }), true);
    const norm = ty === "channel:create"
      ? { type: ty, name: String(action.name).trim().replace(/^#/, ""), description: action.description ?? null, visibility: action.visibility === "private" ? "private" : "public", initialHumans: Array.isArray(action.initialHumans) ? action.initialHumans : [], initialAgents: Array.isArray(action.initialAgents) ? action.initialAgents : [] }
      : { type: ty, name: String(action.name).trim().replace(/^@/, ""), description: action.description ?? null, requiredComputer: action.requiredComputer ?? null, suggestedComputer: action.suggestedComputer ?? null };
    const actionMetadata = { kind: "action-card", state: "prepared", action: norm, executedAt: null, executedByUserId: null, executedByUserName: null, result: null };
    const msg = await createMessage({ serverId, channelId: tgt.channelId, senderType: "agent", senderId: agent.id, senderName: agent.name, content: "", messageType: "action", threadId: tgt.threadId, actionMetadata });
    return (sendJson(res, 200, { ok: true, id: msg.id, seq: msg.seq, target: b.target, action: norm }), true);
  }
  // Agent uploads an attachment (first-class member, can share files). Multipart fields: files=binary, channel=human-readable target. Returns attachmentId; use message send --attach to attach it.
  if (p === "/agent-api/attachment/upload" && method === "POST") {
    const { fields, files } = await parseUpload(req);
    const tgt = await resolveTarget(serverId, fields.channel ?? fields.target ?? "", agent.id);
    const out = [];
    for (const f of files) {
      const [a] = await db.insert(schema.attachments).values({ serverId, channelId: tgt?.channelId ?? null, uploaderType: "agent", uploaderId: agent.id, filename: f.filename, mimeType: f.mimeType, sizeBytes: f.size, storageKey: f.storageKey }).returning();
      out.push({ attachmentId: a!.id, id: a!.id, filename: a!.filename, sizeBytes: a!.sizeBytes });
    }
    return (sendJson(res, 200, { attachments: out, attachmentId: out[0]?.attachmentId }), true);
  }

  if (p === "/agent-api/message/react" && method === "POST") {
    const b = await readJson(req);
    const emoji = String(b.emoji ?? "").trim();
    if (!b.messageId || !emoji) return (sendErr(res, 400, "messageId + emoji required"), true);
    const mid = await resolveMessageId(serverId, b.messageId, agent.id); // Tolerates short id (agent reacts to the short id it sees); without this, querying uuid column with a short id → 500
    if (!mid) return (sendErr(res, 404, "message not found"), true);
    const out = b.remove ? await removeReaction(serverId, mid, "agent", agent.id, emoji, agent) : await addReaction(serverId, mid, "agent", agent.id, emoji, agent);
    return (sendJson(res, 200, { ok: true, reactions: out?.reactions ?? [] }), true);
  }
  if (p === "/agent-api/message/read" && method === "GET") {
    const target = url.searchParams.get("channel") ?? "";
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 100);
    const tgt = await resolveTarget(serverId, target, agent.id);
    if (!tgt) return (sendErr(res, 404, "channel not found"), true);
    const ch = (await db.select().from(schema.channels).where(eq(schema.channels.id, tgt.channelId)))[0];
    const tstr = ch ? await addressableTarget(ch, agent.id) : target;
    // Anchor (--before/--after/--around): value = message id (short or full) or numeric seq; no anchor = latest limit messages
    const anchorParam = url.searchParams.get("around") ?? url.searchParams.get("before") ?? url.searchParams.get("after");
    const cid = and(eq(schema.messages.channelId, tgt.channelId), ne(schema.messages.messageType, "agent_activity_receipt"));
    let rows: (typeof schema.messages.$inferSelect)[];
    if (anchorParam) {
      let anchorSeq = /^\d+$/.test(anchorParam) ? Number(anchorParam) : null;
      if (anchorSeq == null) { const aid = await resolveMessageId(serverId, anchorParam, agent.id); const am = aid ? (await db.select({ seq: schema.messages.seq }).from(schema.messages).where(eq(schema.messages.id, aid)))[0] : null; anchorSeq = am?.seq ?? null; }
      if (anchorSeq == null) return (sendErr(res, 404, "anchor message not found"), true);
      if (url.searchParams.get("after")) {
        rows = await db.select().from(schema.messages).where(and(cid, gt(schema.messages.seq, anchorSeq))).orderBy(asc(schema.messages.seq)).limit(limit);
      } else if (url.searchParams.get("before")) {
        rows = (await db.select().from(schema.messages).where(and(cid, lt(schema.messages.seq, anchorSeq))).orderBy(desc(schema.messages.seq)).limit(limit)).reverse();
      } else { // around: half before anchor, half after, inclusive of anchor
        const half = Math.max(1, Math.floor(limit / 2));
        const before = (await db.select().from(schema.messages).where(and(cid, lt(schema.messages.seq, anchorSeq))).orderBy(desc(schema.messages.seq)).limit(half)).reverse();
        const fromAnchor = await db.select().from(schema.messages).where(and(cid, gt(schema.messages.seq, anchorSeq - 1))).orderBy(asc(schema.messages.seq)).limit(limit - before.length);
        rows = [...before, ...fromAnchor];
      }
    } else {
      rows = (await db.select().from(schema.messages).where(cid).orderBy(desc(schema.messages.seq)).limit(limit)).reverse();
    }
    rows = (await applyPolicyView(serverId, agent.machineId, agent, rows)).view; // trigger-source policy: sealed drops, sanitized disinfects
    return (sendJson(res, 200, { messages: rows.map((m) => ({ ...serialize(m), text: fmt(m, tstr) })) }), true);
  }

  if (p === "/agent-api/server/info" && method === "GET") {
    const chs = await db.select().from(schema.channels).where(eq(schema.channels.serverId, serverId));
    const joined = new Set((await agentChannels(agent.id)).map((c) => c.channelId));
    // Exclude system-seeded showcase demo props (creatorType="system") from the agent-facing teammate roster,
    // mirroring the human plane's visibleAgents: they aren't reachable (workspaceMembers excludes them from
    // @-mention/wake for every sender), so listing them would just tempt an agent into a no-op @-mention.
    const agents = await db.select().from(schema.agents).where(and(eq(schema.agents.serverId, serverId), isNull(schema.agents.deletedAt), ne(schema.agents.creatorType, "system")));
    const memberRows = await db.select().from(schema.serverMembers).where(eq(schema.serverMembers.serverId, serverId));
    const humans = memberRows.length ? await db.select().from(schema.users).where(inArray(schema.users.id, memberRows.map((m) => m.userId))) : [];
    return (sendJson(res, 200, {
      // Agent ACL: only surface public channels + channels the agent has joined — never reveal a private
      // channel's name/description to a non-member (DMs are listed elsewhere). Keeps private channels invisible.
      channels: chs.filter((c) => c.type !== "dm" && c.type !== "thread" && !c.deletedAt && (c.type === "channel" || joined.has(c.id))).map((c) => ({ name: c.name, description: c.description, joined: joined.has(c.id), type: c.type })),
      agents: agents.map((a) => ({
        name: a.name,
        status: a.status,
        description: inputSenderAllowed(agent, "agent", a.id) ? a.description ?? null : null,
      })),
      humans: humans.map((u) => ({ name: u.name, description: u.description ?? null })),
    }), true);
  }

  if (p === "/agent-api/channel/join" && method === "POST") {
    const b = await readJson(req);
    const name = (b.target ?? "").replace(/^#/, "");
    const ch = (await db.select().from(schema.channels).where(and(eq(schema.channels.serverId, serverId), eq(schema.channels.name, name))))[0];
    if (!ch) return (sendErr(res, 404, "channel not found"), true);
    // Agent ACL: self-join is for public channels only. Private / DM / thread are invite-only — an admin or an
    // existing member must add the agent (mirrors the human self-join guard). Prevents an agent walking into a
    // private channel by name.
    if (ch.type !== "channel") return (sendErr(res, 403, "this channel is invite-only — an admin or member must add the agent"), true);
    // Join at the channel watermark so a self-joining agent's next `message check` sees only new messages, not
    // the channel's pre-join backlog (it can pull history on demand via `message read`).
    await addChannelMembers(ch.id, [{ type: "agent", id: agent.id }]);
    return (sendJson(res, 200, { ok: true, joined: name }), true);
  }

  // Tasks (basic)
  // Agent claim/update target a message by id; if it is not yet a task, convert it first (canonical
  // path → mints a channel-scoped task number + thread + task:created event) so a status mutation can
  // never silently promote a plain message into a numberless task. No-op when already a task.
  const ensureTaskForAgent = async (mid: string) => {
    const cur = (await db.select({ s: schema.messages.taskStatus }).from(schema.messages).where(eq(schema.messages.id, mid)))[0];
    if (cur && !cur.s) await convertMessageToTask(serverId, mid, { type: "agent", id: agent.id });
  };
  const resolveTaskNumberForAgent = async (channel: unknown, number: unknown): Promise<string | null> => {
    const tgt = await resolveTarget(serverId, String(channel), agent.id);
    if (!tgt) return null;
    const task = (await db.select().from(schema.messages).where(and(
      eq(schema.messages.channelId, tgt.channelId),
      eq(schema.messages.taskNumber, Number(number)),
      isNotNull(schema.messages.taskStatus),
    )))[0];
    return task && await agentInputVisible(agent, task) ? task.id : null;
  };
  if (p === "/agent-api/task/list" && method === "GET") {
    const tgt = await resolveTarget(serverId, url.searchParams.get("channel") ?? "", agent.id);
    if (!tgt) return (sendErr(res, 404, "channel not found"), true);
    const tasks = await db.select().from(schema.messages).where(and(eq(schema.messages.channelId, tgt.channelId))).orderBy(asc(schema.messages.taskNumber));
    const visibleTasks = await filterAgentInputView(agent, tasks.filter((message) => !!message.taskStatus));
    return (sendJson(res, 200, { tasks: visibleTasks.map((m) => ({ number: m.taskNumber, status: m.taskStatus, content: m.content, id: m.id, assigneeId: m.taskAssigneeId })) }), true);
  }
  if (p === "/agent-api/task/claim" && method === "POST") {
    const b = await readJson(req);
    // Supports --channel "#ch" --number N (agent sees task as #N), or --message-id (short/full id)
    let mid: string | null = null;
    if (b.number != null && b.channel) {
      mid = await resolveTaskNumberForAgent(b.channel, b.number);
    } else {
      mid = await resolveMessageId(serverId, b.messageId, agent.id); // Tolerates 8-character short id
    }
    if (!mid) return (sendErr(res, 404, "task not found"), true);
    if (!await canAgentManageCoordinatedTask(mid, agent.id)) {
      return (sendErr(res, 409, "task reserved for its primary coordinator", { code: "TASK_RESERVED_FOR_PRIMARY" }), true);
    }
    await ensureTaskForAgent(mid); // claiming a plain message converts it to a task first (so it gets a number), then claims
    const r = await claimTask(serverId, mid, "agent", agent.id); // Atomic claim: returns null if already taken
    if (!r) return (sendErr(res, 409, "already claimed", { code: "CLAIM_FAILED" }), true);
    // Guide agent to follow up in the task's thread (report in task thread, not the main channel).
    // Use a stable thread:<parentShortId> target so it round-trips across public/private/DM contexts
    // without depending on the caller's view of the parent channel name or DM peer.
    const tm = (await db.select().from(schema.messages).where(eq(schema.messages.id, mid)))[0];
    const threadTarget = tm ? `thread:${mid.slice(0, 8)}` : null;
    return (sendJson(res, 200, { ok: true, claimed: mid, number: tm?.taskNumber ?? null, threadTarget,
      followUp: threadTarget ? `Follow up in the task's thread: open-tag message send --target "${threadTarget}"` : null }), true);
  }
  if (p === "/agent-api/task/update" && method === "POST") {
    const b = await readJson(req);
    // Supports --channel + --number (agent sees task as #N), or --message-id
    let mid: string | null = null;
    if (b.number != null && b.channel) {
      mid = await resolveTaskNumberForAgent(b.channel, b.number);
    } else {
      mid = await resolveMessageId(serverId, b.messageId, agent.id);
    }
    if (!mid) return (sendErr(res, 404, "message not found"), true);
    if (!await canAgentManageCoordinatedTask(mid, agent.id)) {
      return (sendErr(res, 409, "task reserved for its primary coordinator", { code: "TASK_RESERVED_FOR_PRIMARY" }), true);
    }
    if (!(TASK_STATUSES as readonly string[]).includes(String(b.status))) return (sendErr(res, 400, `valid status is required (${TASK_STATUSES.join(", ")})`), true);
    await ensureTaskForAgent(mid); // updating the status of a plain message converts it to a task first (so it gets a number), then sets status
    // Reuse human-side setTaskStatus: done/closed writes completedAt + emits task:updated socket
    // (previously a bare db.update bypassed core → the web kanban did not refresh in real time for agent status changes)
    const upd = await setTaskStatus(serverId, mid, b.status, { type: "agent", id: agent.id });
    if (!upd) return (sendErr(res, 404, "task not found"), true);
    return (sendJson(res, 200, { ok: true, status: upd.taskStatus }), true);
  }
  if (p === "/agent-api/task/assign" && method === "POST") {
    const b = await readJson(req);
    const rawTo = String(b.to ?? "").trim().replace(/^@/, "");
    if (!rawTo) return (sendErr(res, 400, "to required"), true);
    const targetAgent = (await db.select().from(schema.agents).where(and(
      eq(schema.agents.serverId, serverId),
      eq(schema.agents.name, rawTo),
      isNull(schema.agents.deletedAt),
    )))[0];
    if (!targetAgent) return (sendErr(res, 404, "target agent not found"), true);
    if (!senderAllowedByPolicy(targetAgent, "agent", agent.id)) {
      return (sendErr(res, 403, "assignee does not accept commands from this agent"), true);
    }

    let mid: string | null = null;
    if (b.number != null && b.channel) {
      mid = await resolveTaskNumberForAgent(b.channel, b.number);
    } else {
      mid = await resolveMessageId(serverId, b.messageId, agent.id);
    }
    if (!mid) return (sendErr(res, 404, "task not found"), true);
    if (!await canAgentManageCoordinatedTask(mid, agent.id)) {
      return (sendErr(res, 409, "task reserved for its primary coordinator", { code: "TASK_RESERVED_FOR_PRIMARY" }), true);
    }

    const assigned = await assignTask(serverId, mid, targetAgent.id, { type: "agent", id: agent.id });
    if (!assigned) return (sendErr(res, 404, "task not found"), true);
    const threadTarget = `thread:${assigned.id.slice(0, 8)}`;
    return (sendJson(res, 200, {
      ok: true,
      assigned: assigned.id,
      number: assigned.taskNumber ?? null,
      to: targetAgent.name,
      threadTarget,
      followUp: threadTarget ? `Follow up in the task's thread: open-tag message send --target "${threadTarget}"` : null,
    }), true);
  }
  // Create new task (agent delegates work to a channel/other agent): reuses createMessage(asTask). Batch {tasks:[{title}]} or single --title
  if (p === "/agent-api/task/new" && method === "POST") {
    const b = await readJson(req);
    const titles = (Array.isArray(b.tasks) ? b.tasks : (b.title ? [{ title: b.title }] : [])).map((t: any) => String(t?.title ?? "").trim()).filter(Boolean);
    if (!titles.length) return (sendErr(res, 400, "title required"), true);
    const tgt = await resolveTarget(serverId, b.target ?? b.channel ?? "", agent.id);
    if (!tgt) return (sendErr(res, 404, "channel not found"), true);
    const created = [];
    for (const title of titles) { const m = await createMessage({ serverId, channelId: tgt.channelId, senderType: "agent", senderId: agent.id, senderName: agent.name, content: title, asTask: true }); created.push({ id: m.id, number: m.taskNumber, content: m.content }); }
    return (sendJson(res, 200, { ok: true, tasks: created }), true);
  }
  // Thread participation (agent can start/reply to threads, closing the threads loop). parent accepts full id or the 8-character short id from the message header.
  const findParent = async (raw: string, channel: string | null) => {
    const v = (raw || "").trim(); if (!v) return null;
    const tgt = channel ? await resolveTarget(serverId, channel, agent.id) : null;
    const idCond = v.length >= 32 ? eq(schema.messages.id, v) : like(sql`${schema.messages.id}::text`, v + "%");
    const conds = [eq(schema.messages.serverId, serverId), idCond, ...(tgt ? [eq(schema.messages.channelId, tgt.channelId)] : [])];
    const parent = (await db.select().from(schema.messages).where(and(...conds)))[0] ?? null;
    // Agent ACL: a bare parent short id (no channel given) skips resolveTarget, so gate on the found parent's
    // channel — otherwise an agent could read/reply into a thread under a private channel it can't access.
    if (parent && !(await canAgentReadChannel(serverId, parent.channelId, agent.id))) return null;
    if (parent && !await agentInputVisible(agent, parent)) return null;
    return parent;
  };
  if (p === "/agent-api/thread/reply" && method === "POST") {
    const b = await readJson(req);
    if (!b.parent || !b.content) return (sendErr(res, 400, "parent + content required"), true);
    const parent = await findParent(b.parent, b.channel ?? b.target ?? null);
    if (!parent) return (sendErr(res, 404, "parent message not found"), true);
    const resolvedReplyToMessageId = b.replyTo ? await resolveMessageId(serverId, String(b.replyTo), agent.id) : null;
    const replyToMessageId = resolvedReplyToMessageId ? await canonicalReplyTriggerMessageId(resolvedReplyToMessageId) : null;
    if (b.replyTo && !replyToMessageId) return (sendErr(res, 404, "reply trigger not found", { code: "REPLY_TRIGGER_NOT_FOUND" }), true);
    if (replyToMessageId) {
      const durableActionBlock = await durableTurnActionBlockReason(serverId, agent.machineId, agent.id, replyToMessageId);
      if (durableActionBlock) return (sendErr(res, 409, durableActionBlock, { code: "DELIVERY_ADMISSION_REQUIRED" }), true);
    }
    const th = await getOrCreateThread(serverId, parent.id, { type: "agent", id: agent.id });
    if (!replyToMessageId && await hasOutstandingReplyDecision(agent.id, th.id)) {
      return (sendErr(res, 409, "reply context required", { code: "REPLY_CONTEXT_REQUIRED" }), true);
    }
    let slot: ReplySlot | undefined;
    if (replyToMessageId) {
      const reserved = await reserveReplyGrant({ serverId, agentId: agent.id, messageId: replyToMessageId, channelId: th.id });
      if (!reserved.ok) return (sendErr(res, 409, "reply not granted", { code: reserved.code }), true);
      slot = reserved.slot;
    }
    try {
      const msg = await createMessage({ serverId, channelId: th.id, senderType: "agent", senderId: agent.id, senderName: agent.name, content: b.content, replyToMessageId: replyToMessageId ?? undefined, replyGrantSlot: slot });
      if (replyToMessageId) await finishReplyPublication({ messageId: replyToMessageId, agentId: agent.id, replyMessageId: msg.id });
      return (sendJson(res, 200, { ok: true, threadChannelId: th.id, id: msg.id, seq: msg.seq, replyTo: replyToMessageId, replySlot: slot ?? null }), true);
    } catch (e) {
      if (replyToMessageId) await releaseReplyReservation(replyToMessageId, agent.id);
      const code = (e as any)?.cause?.code ?? (e as any)?.code;
      if (code === "23505") return (sendErr(res, 409, "reply grant already published", { code: "REPLY_GRANT_CONSUMED" }), true);
      throw e;
    }
  }
  if (p === "/agent-api/thread/read" && method === "GET") {
    const parent = await findParent(url.searchParams.get("parent") ?? "", url.searchParams.get("channel"));
    if (!parent) return (sendErr(res, 404, "parent message not found"), true);
    const th = (await db.select().from(schema.channels).where(and(eq(schema.channels.serverId, serverId), eq(schema.channels.type, "thread"), eq(schema.channels.parentMessageId, parent.id))))[0];
    const tstr = `thread:${parent.id.slice(0, 8)}`;
    if (!th) return (sendJson(res, 200, { parent: { senderName: parent.senderName, content: parent.content }, messages: [] }), true);
    const msgs = await db.select().from(schema.messages).where(and(eq(schema.messages.channelId, th.id), ne(schema.messages.messageType, "agent_activity_receipt"))).orderBy(asc(schema.messages.seq)).limit(100);
    const visible = await filterAgentInputView(agent, msgs);
    return (sendJson(res, 200, { parent: { senderName: parent.senderName, content: parent.content }, messages: visible.map((m) => ({ ...serialize(m), text: fmt(m, tstr) })) }), true);
  }
  // Full-text search (agent self-queries context): searches only channels the agent belongs to, ilike substring match
  if (p === "/agent-api/search" && method === "GET") {
    const q = (url.searchParams.get("q") || url.searchParams.get("query") || "").trim();
    if (!q) return (sendErr(res, 400, "q required"), true);
    const joined = (await agentChannels(agent.id)).map((c) => c.channelId);
    if (!joined.length) return (sendJson(res, 200, { results: [] }), true);
    const rows = await db.select().from(schema.messages)
      .where(and(eq(schema.messages.serverId, serverId), inArray(schema.messages.channelId, joined), ilike(schema.messages.content, `%${q}%`)))
      .orderBy(desc(schema.messages.seq)).limit(100);
    const visible = (await filterAgentInputView(agent, rows)).slice(0, 20);
    return (sendJson(res, 200, { results: visible.map((m) => ({ id: m.id, channelId: m.channelId, senderType: m.senderType, senderName: m.senderName, content: m.content, createdAt: m.createdAt })) }), true);
  }

  // profile show: own profile or @handle lookup
  if (p === "/agent-api/profile/show" && method === "GET") {
    const who = (url.searchParams.get("handle") || "").replace(/^@/, "");
    const a = who
      ? (await db.select().from(schema.agents).where(and(
        eq(schema.agents.serverId, serverId),
        eq(schema.agents.name, who),
        isNull(schema.agents.deletedAt),
      )))[0]
      : (await db.select().from(schema.agents).where(eq(schema.agents.id, agent.id)))[0];
    if (a) {
      const profileTextAllowed = inputSenderAllowed(agent, "agent", a.id);
      return (sendJson(res, 200, {
        type: "agent",
        name: a.name,
        displayName: profileTextAllowed ? a.displayName : a.name,
        description: profileTextAllowed ? a.description : null,
        runtime: a.runtime,
        model: a.model,
        status: a.status,
      }), true);
    }
    const uRow = who ? (await db.select().from(schema.users).where(eq(schema.users.name, who)))[0] : null;
    const u = uRow && (await db.select({ userId: schema.serverMembers.userId }).from(schema.serverMembers).where(and(
      eq(schema.serverMembers.serverId, serverId),
      eq(schema.serverMembers.userId, uRow.id),
    )))[0] ? uRow : null;
    if (u) return (sendJson(res, 200, { type: "user", name: u.name, displayName: u.displayName, description: u.description }), true);
    return (sendErr(res, 404, "profile not found"), true);
  }
  // profile update: update own displayName/description/avatarUrl
  if (p === "/agent-api/profile/update" && method === "POST") {
    const b = await readJson(req);
    const patch: Record<string, string> = {};
    if (b.displayName) patch.displayName = String(b.displayName);
    if (b.description !== undefined) { if (descTooLong(b.description)) return (sendErr(res, 400, DESC_TOO_LONG), true); patch.description = String(b.description); }
    if (b.avatarUrl) patch.avatarUrl = String(b.avatarUrl);
    if (!Object.keys(patch).length) return (sendErr(res, 400, "provide at least one of displayName/description/avatarUrl"), true);
    await db.update(schema.agents).set(patch).where(eq(schema.agents.id, agent.id));
    return (sendJson(res, 200, { ok: true, ...patch }), true);
  }
  // message resolve: verify message id exists + print canonical line (prevents hallucinated references)
  if (p === "/agent-api/message/resolve" && method === "GET") {
    const raw = (url.searchParams.get("id") || "").trim();
    if (!raw) return (sendErr(res, 400, "id required"), true);
    const messageId = await resolveMessageId(serverId, raw, agent.id);
    const m = messageId ? (await db.select().from(schema.messages).where(eq(schema.messages.id, messageId)))[0] : undefined;
    if (!m) return (sendErr(res, 404, "message not found", { code: "RESOLVE_FAILED" }), true);
    const ch = (await db.select().from(schema.channels).where(eq(schema.channels.id, m.channelId)))[0];
    return (sendJson(res, 200, { ...serialize(m), text: fmt(m, ch ? await addressableTarget(ch, agent.id) : m.channelId) }), true);
  }
  // channel members
  if (p === "/agent-api/channel/members" && method === "GET") {
    const tgt = await resolveTarget(serverId, url.searchParams.get("channel") ?? "", agent.id);
    if (!tgt) return (sendErr(res, 404, "channel not found"), true);
    const mems = await channelMembers(tgt.channelId);
    return (sendJson(res, 200, { members: mems.map((m) => ({
      type: m.type,
      name: m.name,
      displayName: m.type === "agent" && !inputSenderAllowed(agent, "agent", m.id) ? m.name : m.displayName,
    })) }), true);
  }
  // channel leave (only affects own membership)
  if (p === "/agent-api/channel/leave" && method === "POST") {
    const b = await readJson(req);
    const tgt = await resolveTarget(serverId, b.target ?? b.channel ?? "", agent.id);
    if (!tgt) return (sendErr(res, 404, "channel not found"), true);
    await db.delete(schema.channelMembers).where(and(eq(schema.channelMembers.channelId, tgt.channelId), eq(schema.channelMembers.memberType, "agent"), eq(schema.channelMembers.memberId, agent.id)));
    return (sendJson(res, 200, { ok: true, left: b.target ?? b.channel }), true);
  }
  // thread unfollow: stop receiving deliveries from a thread (removes own membership in that thread channel)
  if (p === "/agent-api/thread/unfollow" && method === "POST") {
    const b = await readJson(req);
    const tgt = await resolveTarget(serverId, b.target ?? b.channel ?? "", agent.id);
    if (!tgt) return (sendErr(res, 404, "thread not found"), true);
    await db.delete(schema.channelMembers).where(and(eq(schema.channelMembers.channelId, tgt.channelId), eq(schema.channelMembers.memberType, "agent"), eq(schema.channelMembers.memberId, agent.id)));
    return (sendJson(res, 200, { ok: true, unfollowed: b.target ?? b.channel }), true);
  }
  // task unclaim
  if (p === "/agent-api/task/unclaim" && method === "POST") {
    const b = await readJson(req);
    const mid = await resolveMessageId(serverId, b.messageId, agent.id);
    if (!mid) return (sendErr(res, 404, "message not found"), true);
    const r = await unclaimTask(serverId, mid, { type: "agent", id: agent.id });
    return (r ? sendJson(res, 200, { ok: true, taskStatus: r.taskStatus }) : sendErr(res, 404, "task not found"), true);
  }
  // attachment view: fetch attachment by id (text returned inline, binary returns metadata)
  if (p === "/agent-api/attachment/view" && method === "GET") {
    const id = (url.searchParams.get("id") || "").trim();
    if (!id) return (sendErr(res, 400, "id required"), true);
    // Tolerates short id via the shared resolver (same convention as resolveMessageId): agents cite the 8-char
    // prefixes they see in message text. Without this a short id hits the uuid column raw → 500 (live
    // 2026-07-05: an agent's short-id views failed and it retried in a loop).
    const attId = await resolveIdOrPrefix(schema.attachments, serverId, id);
    const a = attId ? (await db.select().from(schema.attachments).where(eq(schema.attachments.id, attId)))[0] : undefined;
    if (!a) return (sendErr(res, 404, "attachment not found"), true);
    // Agent ACL: the agent may view an attachment only if it uploaded it, or it can access the channel the
    // attachment was posted in — otherwise an attachment id leaks a private channel's file. 404 (don't reveal).
    const ownUpload = a.uploaderType === "agent" && a.uploaderId === agent.id;
    const uploaderAllowed = inputSenderAllowed(agent, a.uploaderType ?? "system", a.uploaderId);
    const channelAllowed = !!a.channelId && await canAgentReadChannel(serverId, a.channelId, agent.id);
    const parentVisible = !a.messageId || !!await resolveMessageId(serverId, a.messageId, agent.id);
    const canView = ownUpload || (uploaderAllowed && channelAllowed && parentVisible);
    if (!canView) return (sendErr(res, 404, "attachment not found"), true);
    try {
      const buf = await readObject(a.storageKey);
      // Return bytes (base64) → CLI saves to agent's local workspace, agent inspects with its own tools.
      // File lives on the server disk; agent may be on a remote machine, so bytes must be delivered to the agent locally for inspection.
      const TOO_BIG = 12 * 1024 * 1024; // 12MB raw limit (base64 +33%); oversized files are not inlined
      const isText = !buf.includes(0) && ((a.mimeType ?? "").startsWith("text") || buf.length < 65536);
      const body: Record<string, unknown> = { id: a.id, filename: a.filename, mimeType: a.mimeType, sizeBytes: a.sizeBytes };
      if (isText) body.text = buf.toString("utf8").slice(0, 100000); // Inline text for direct reading
      if (buf.length <= TOO_BIG) body.base64 = buf.toString("base64");
      else body.note = "file too large to inline (" + a.sizeBytes + "B); on server storageKey=" + a.storageKey;
      return (sendJson(res, 200, body), true);
    } catch (e: any) { return (sendErr(res, 500, "read failed: " + String(e?.message ?? e)), true); }
  }

  // reminder schedule/list/cancel/snooze (agent's own schedule, no scope required). --in <seconds> or --at <iso>; optional --anchor, --recurring
  if (p === "/agent-api/reminder/schedule" && method === "POST") {
    const b = await readJson(req);
    if (!b.content) return (sendErr(res, 400, "content required"), true);
    let remindAt: Date;
    if (b.at) { remindAt = new Date(b.at); if (isNaN(remindAt.getTime())) return (sendErr(res, 400, "invalid --at iso time"), true); }
    else if (b.in != null && Number(b.in) > 0) remindAt = new Date(Date.now() + Number(b.in) * 1000);
    else return (sendErr(res, 400, "provide --in <seconds> or --at <iso>"), true);
    const anchor = b.anchor ? await findParent(String(b.anchor), null) : null;
    const [r] = await db.insert(schema.reminders).values({ serverId, ownerType: "agent", ownerId: agent.id, content: String(b.content), remindAt, anchorMessageId: anchor?.id ?? null, recurrence: b.recurring && Number(b.recurring) > 0 ? String(Number(b.recurring)) : null }).returning();
    return (sendJson(res, 200, { ok: true, id: r!.id, remindAt: r!.remindAt }), true);
  }
  if (p === "/agent-api/reminder/list" && method === "GET") {
    const rows = await db.select().from(schema.reminders).where(and(eq(schema.reminders.serverId, serverId), eq(schema.reminders.ownerType, "agent"), eq(schema.reminders.ownerId, agent.id))).orderBy(asc(schema.reminders.remindAt));
    return (sendJson(res, 200, { reminders: rows.map((r) => ({ id: r.id, content: r.content, remindAt: r.remindAt, status: r.status, recurrence: r.recurrence })) }), true);
  }
  if (p === "/agent-api/reminder/cancel" && method === "POST") {
    const b = await readJson(req);
    if (!b.id) return (sendErr(res, 400, "id required"), true);
    await db.update(schema.reminders).set({ status: "cancelled" }).where(and(eq(schema.reminders.id, String(b.id)), eq(schema.reminders.ownerId, agent.id)));
    return (sendJson(res, 200, { ok: true }), true);
  }
  if (p === "/agent-api/reminder/snooze" && method === "POST") {
    const b = await readJson(req);
    if (!b.id || b.in == null) return (sendErr(res, 400, "id + in(seconds) required"), true);
    await db.update(schema.reminders).set({ remindAt: new Date(Date.now() + Number(b.in) * 1000), status: "scheduled", firedAt: null }).where(and(eq(schema.reminders.id, String(b.id)), eq(schema.reminders.ownerId, agent.id)));
    return (sendJson(res, 200, { ok: true }), true);
  }

  return (sendErr(res, 404, "not found"), true);
}

function serialize(m: typeof schema.messages.$inferSelect) {
  return { id: m.id, seq: m.seq, channelId: m.channelId, senderType: m.senderType, senderName: m.senderName, content: m.content, taskStatus: m.taskStatus, createdAt: m.createdAt };
}

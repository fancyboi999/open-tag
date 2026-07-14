// Message core: seq assignment, @mention parsing, DB write, SSE broadcast (human), wake delivery (agent), target resolution.
import { and, eq, ne, desc, gt, inArray, like, sql, or, isNull, isNotNull } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { nextSeq, publish } from "./realtime.js";
import { nextTaskNumber } from "../redis.js";
import { broadcastToDaemons, daemonCount, isMachineConnected, sendToMachine } from "./daemonHub.js";
import { agentHasScope } from "./scopes.js";
import { newKey, hashToken } from "./auth.js";
import { createLogger } from "../log.js";
import { canUserReadChannel } from "./channelAccess.js";
import { canAutoJoinMentionedMembers, isWakeable } from "./agentWakePolicy.js";
import { UUID_RE } from "./util.js";

const log = createLogger("server:core");
const PORT = Number(process.env.PORT ?? 7777);
const SELF_URL = `http://localhost:${PORT}`;
// Per-agent raw token cache (server process memory; DB stores hash only). Injected into agent process at spawn; resolveAgent looks up by hash. See slice10.
const agentRawTokens = new Map<string, string>();

// Member description (bio) length limit (HumanDetailPanel/AgentDetailPanel both maxLength=3000 + "Description must be at most 3000 characters"). Shared by human+agent.
export const MAX_DESCRIPTION = 3000;
export const DESC_TOO_LONG = `Description must be at most ${MAX_DESCRIPTION} characters`;
export const descTooLong = (s: unknown): boolean => typeof s === "string" && s.length > MAX_DESCRIPTION;

// Agent name is the @mention handle: used directly as @<name> (parseMentions re, CLI, web) and as the
// dm:@<name> lookup key (resolveTarget). It must be a machine-safe identifier — spaces / punctuation /
// emoji / leading digits break mention parsing and DM target resolution. Display-friendly text (Chinese,
// spaces, emoji) belongs in displayName, which is unconstrained and drives all human-facing rendering.
// `agents.name` is an unbounded `text` column, so the length cap is enforced here, not by the DB.
// Trailing / repeated hyphens (`bot--ok`, `my-agent-`) are intentionally allowed: they are harmless for
// @mention / DM resolution since the mention charset itself includes `-`; GitHub-style "no trailing
// hyphen" tightening is deferred as cosmetic. ⚠️ Keep AGENT_NAME_RE + MAX_AGENT_NAME in sync with the
// inline mirror in web/src/views/Members.tsx (CreateAgentModal) — there is no shared module because the
// web bundle must not import server code (it would pull in db/drizzle).
export const MAX_AGENT_NAME = 64;
export const AGENT_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
export const INVALID_AGENT_NAME = `Agent name must be 1-${MAX_AGENT_NAME} characters, start with a letter, and contain only letters, numbers, hyphens, and underscores`;
export const invalidAgentName = (s: unknown): boolean => typeof s !== "string" || s.length > MAX_AGENT_NAME || !AGENT_NAME_RE.test(s);

/** Create a workspace (server/community): create server + creator as owner + default #all channel + add owner to channel. Shared by dev-login / POST /api/servers / seed. */
export async function createServer(name: string, slug: string, ownerId: string) {
  const [srv] = await db.insert(schema.servers).values({ name, slug, ownerId, plan: "free" }).returning();
  await db.insert(schema.serverMembers).values({ serverId: srv!.id, userId: ownerId, role: "owner" });
  const [all] = await db.insert(schema.channels).values({ serverId: srv!.id, name: "all", description: "General channel for all members", type: "channel" }).returning();
  await db.insert(schema.channelMembers).values({ channelId: all!.id, memberType: "user", memberId: ownerId }).onConflictDoNothing();
  return srv!;
}

export interface Member { type: "user" | "agent"; id: string; name: string; displayName: string; }

export async function channelMembers(channelId: string): Promise<Member[]> {
  const rows = await db.select().from(schema.channelMembers).where(eq(schema.channelMembers.channelId, channelId));
  const out: Member[] = [];
  for (const r of rows) {
    if (r.memberType === "user") {
      const u = (await db.select().from(schema.users).where(eq(schema.users.id, r.memberId)))[0];
      if (u) out.push({ type: "user", id: u.id, name: u.name, displayName: u.displayName });
    } else {
      const a = (await db.select().from(schema.agents).where(eq(schema.agents.id, r.memberId)))[0];
      if (a) out.push({ type: "agent", id: a.id, name: a.name, displayName: a.displayName });
    }
  }
  return out;
}

/** Highest message seq currently in a channel (0 if empty). seq is globally monotonic (Redis INCR), so this is
 *  the channel's read "watermark" at this instant — any message that arrives later has a strictly higher seq. */
export async function channelMaxSeq(channelId: string): Promise<number> {
  const [r] = await db.select({ seq: schema.messages.seq }).from(schema.messages)
    .where(eq(schema.messages.channelId, channelId)).orderBy(desc(schema.messages.seq)).limit(1);
  return r?.seq ?? 0;
}

/** Add channel members. An AGENT joins "caught up" at the channel watermark (its lastReadSeq starts at the
 *  channel's current max seq), so its first `open-tag message check` surfaces only messages sent AFTER it
 *  joined — not the channel's pre-join backlog (which it can still pull on demand via `message read`). Without
 *  this, a fresh member's lastReadSeq=0 makes every prior message "unread", flooding a newly created or newly
 *  invited agent with the whole channel history it never needed. A USER keeps lastReadSeq=0 — the human UI
 *  intentionally surfaces channel history as unread on join (unchanged behaviour). Pass `watermark` to override
 *  the agent watermark (the @-mention path passes triggeringSeq-1 so the triggering message stays unread);
 *  `watermark` is a no-op for an all-user batch (users are always pinned to 0). Idempotent via
 *  onConflictDoNothing: re-adding an existing member never rewinds or fast-forwards a real read cursor. */
export async function addChannelMembers(channelId: string, members: { type: "user" | "agent"; id: string }[], opts?: { watermark?: number }): Promise<void> {
  if (!members.length) return;
  const wm = members.some((m) => m.type === "agent") ? (opts?.watermark ?? await channelMaxSeq(channelId)) : 0;
  await db.insert(schema.channelMembers)
    .values(members.map((m) => ({ channelId, memberType: m.type, memberId: m.id, lastReadSeq: m.type === "agent" ? wm : 0 })))
    .onConflictDoNothing();
}

export function parseMentions(content: string, members: Member[]) {
  const found = new Map<string, Member>();
  const re = /@([A-Za-z0-9_\u4e00-\u9fa5-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const name = m[1]!;
    const hit = members.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (hit) found.set(hit.id, hit);
  }
  return [...found.values()];
}

/** All @-addressable members of a workspace: its live agents + human server-members.
 *  Basis for Slack-style mention auto-join — only names that resolve here may be pulled into a channel
 *  (a human in the users table who isn't a member of this server, or another server's agent, is excluded). */
export async function workspaceMembers(serverId: string): Promise<Member[]> {
  const out: Member[] = [];
  // Exclude system-seeded showcase demo agents (creatorType="system"): they are display-only props for the
  // read-only #showcase channel, NOT @-reachable members. This pool feeds @-mention auto-join in public
  // channels — without the filter, @-ing a word that happens to match a prop's name (e.g. "Pat") would
  // auto-join it into a real channel and fire a no-op wake (it has no machine). Message rendering resolves a
  // sender by id elsewhere, so props still render correctly in #showcase history.
  const ags = await db.select().from(schema.agents).where(and(eq(schema.agents.serverId, serverId), isNull(schema.agents.deletedAt), ne(schema.agents.creatorType, "system")));
  for (const a of ags) out.push({ type: "agent", id: a.id, name: a.name, displayName: a.displayName });
  const sm = await db.select().from(schema.serverMembers).where(eq(schema.serverMembers.serverId, serverId));
  const uids = sm.map((s) => s.userId);
  const us = uids.length ? await db.select().from(schema.users).where(inArray(schema.users.id, uids)) : [];
  for (const u of us) out.push({ type: "user", id: u.id, name: u.name, displayName: u.displayName });
  return out;
}

/** Pure decision for Slack-style auto-join: of the workspace members @-referenced in `content`, which are
 *  not yet members of the channel (`current`) and therefore need to be added. Reuses parseMentions so the
 *  matching can never drift from how mentions are actually recorded. */
export function membersToAutoJoin(content: string, workspace: Member[], current: Member[]): Member[] {
  const have = new Set(current.map((m) => m.type + ":" + m.id));
  return parseMentions(content, workspace).filter((r) => !have.has(r.type + ":" + r.id));
}

/** The member set an @-mention in this channel may pull in (auto-join) — who already has access to the space,
 *  so adding them leaks nothing. A thread inherits its PARENT channel's reach, the same parent-channel
 *  inheritance `canReadChannel` (socketio.ts) uses for read access: a public channel's thread reaches the
 *  whole workspace, a private channel's thread only its parent's members, a DM's thread only the two parties.
 *  A top-level public `channel` reaches the workspace; `private`/`dm` reach only their current members, so an
 *  @ to a non-member there stays a no-op (unchanged behaviour). */
async function mentionAutoJoinPool(serverId: string, ch: typeof schema.channels.$inferSelect): Promise<Member[]> {
  let target = ch;
  if (ch.type === "thread" && ch.parentMessageId) {
    const parent = (await db.select().from(schema.messages).where(eq(schema.messages.id, ch.parentMessageId)))[0];
    const pch = parent ? (await db.select().from(schema.channels).where(eq(schema.channels.id, parent.channelId)))[0] : undefined;
    if (pch) target = pch; // depth 1: a parent channel is never itself a thread
    // Orphaned thread (parent message/channel deleted): fall back to the thread's own members — a conservative
    // no-op for @-ing a non-member (the pre-fix behaviour), but log it so a silently-dropped @ is debuggable.
    else log.warn("thread parent channel unresolved; @-mention reach falls back to thread members", { channelId: ch.id, parentMessageId: ch.parentMessageId });
  }
  return target.type === "channel" ? await workspaceMembers(serverId) : await channelMembers(target.id);
}

/** Add @-mentioned non-members to a channel, drawn from `pool` (its @-reach — see mentionAutoJoinPool); returns
 *  those added. Idempotent via onConflictDoNothing; broadcasts a membership update so every client refreshes. */
async function autoJoinMentioned(serverId: string, channelId: string, content: string, current: Member[], pool: Member[], watermark: number): Promise<Member[]> {
  const toAdd = membersToAutoJoin(content, pool, current);
  if (!toAdd.length) return [];
  // watermark = triggeringSeq-1: the @ message that pulled them in stays unread (the agent must see the @), but
  // the channel's prior backlog is marked read so an auto-joined agent isn't flooded with history on first check.
  await addChannelMembers(channelId, toAdd.map((m) => ({ type: m.type, id: m.id })), { watermark });
  await publish(serverId, { type: "channel:members-updated", channelId });
  return toAdd;
}

// Message serialization shape for message:new socket event (omits internal searchVector/agentSendKey).
export interface ReactionAgg { emoji: string; count: number; reactorIds: string[]; reactorNames: string[]; }
export function serializeMsg(msg: typeof schema.messages.$inferSelect, mentions: Member[], atts: (typeof schema.attachments.$inferSelect)[] = [], reactions: ReactionAgg[] = []) {
  return {
    id: msg.id, seq: msg.seq, channelId: msg.channelId, threadId: msg.threadId,
    senderType: msg.senderType, senderId: msg.senderId, senderName: msg.senderName, senderMembershipStatus: "active",
    messageType: msg.messageType, content: msg.content, actionMetadata: msg.actionMetadata ?? null,
    taskStatus: msg.taskStatus, taskNumber: msg.taskNumber,
    taskAssigneeType: msg.taskAssigneeType, taskAssigneeId: msg.taskAssigneeId,
    taskClaimedAt: msg.taskClaimedAt, taskCompletedAt: msg.taskCompletedAt,
    attachments: atts.map((a) => ({ id: a.id, filename: a.filename, mimeType: a.mimeType, sizeBytes: a.sizeBytes })),
    mentions: mentions.map((x) => ({ type: x.type, id: x.id, name: x.name })),
    reactions,
    createdAt: msg.createdAt, updatedAt: msg.updatedAt,
  };
}

export function agentReplyStreamId(messageId: string, agentId: string): string {
  return `${messageId}:${agentId}`;
}

async function publishThreadUpdated(
  serverId: string,
  ch: typeof schema.channels.$inferSelect | undefined,
  senderId: string | null,
  senderType: "user" | "agent" | "system",
) {
  if (ch?.type !== "thread" || !ch.parentMessageId) return;
  const replies = await db.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.channelId, ch.id));
  const parts = await db.select().from(schema.channelMembers).where(eq(schema.channelMembers.channelId, ch.id));
  const parent = (await db.select({ channelId: schema.messages.channelId }).from(schema.messages).where(eq(schema.messages.id, ch.parentMessageId)))[0];
  await publish(serverId, {
    type: "thread:updated",
    threadChannelId: ch.id,
    parentMessageId: ch.parentMessageId,
    parentChannelId: parent?.channelId ?? null,
    replyCount: replies.length,
    participantIds: parts.map((p) => p.memberId),
    senderId,
    senderType,
  });
}

/** Aggregate message reactions into grouped shape: one entry per emoji {emoji,count,reactorIds,reactorNames}. */
export async function aggregateReactions(messageIds: string[]): Promise<Map<string, ReactionAgg[]>> {
  const out = new Map<string, ReactionAgg[]>();
  if (!messageIds.length) return out;
  const rows = await db.select().from(schema.reactions).where(inArray(schema.reactions.messageId, messageIds));
  if (!rows.length) return out;
  const uIds = [...new Set(rows.filter((r) => r.memberType === "user").map((r) => r.memberId))];
  const aIds = [...new Set(rows.filter((r) => r.memberType === "agent").map((r) => r.memberId))];
  const users = uIds.length ? await db.select().from(schema.users).where(inArray(schema.users.id, uIds)) : [];
  const agents = aIds.length ? await db.select().from(schema.agents).where(inArray(schema.agents.id, aIds)) : [];
  const nameOf = (t: string, id: string) => t === "user"
    ? (users.find((u) => u.id === id)?.displayName || users.find((u) => u.id === id)?.name || "?")
    : (agents.find((a) => a.id === id)?.displayName || agents.find((a) => a.id === id)?.name || "?");
  for (const r of rows) {
    const list = out.get(r.messageId) ?? [];
    let e = list.find((x) => x.emoji === r.emoji);
    if (!e) { e = { emoji: r.emoji, count: 0, reactorIds: [], reactorNames: [] }; list.push(e); }
    e.count++; e.reactorIds.push(r.memberId); e.reactorNames.push(nameOf(r.memberType, r.memberId));
    out.set(r.messageId, list);
  }
  return out;
}

async function serializeMessageById(messageId: string) {
  const msg = (await db.select().from(schema.messages).where(eq(schema.messages.id, messageId)))[0];
  if (!msg) return null;
  const mts = await db.select().from(schema.messageMentions).where(eq(schema.messageMentions.messageId, messageId));
  const mentions: Member[] = mts.map((x) => ({ type: x.mentionType as "user" | "agent", id: x.mentionId, name: x.mentionName, displayName: x.mentionName }));
  const atts = await db.select().from(schema.attachments).where(eq(schema.attachments.messageId, messageId));
  const reactions = (await aggregateReactions([messageId])).get(messageId) ?? [];
  return serializeMsg(msg, mentions, atts, reactions);
}

/** Add reaction (add-or-noop): unique index deduplication, broadcast message:updated. */
export async function addReaction(serverId: string, messageId: string, memberType: "user" | "agent", memberId: string, emoji: string) {
  await db.insert(schema.reactions).values({ messageId, memberType, memberId, emoji }).onConflictDoNothing();
  const m = await serializeMessageById(messageId);
  if (m) await publish(serverId, { type: "message:updated", message: m });
  return m;
}
export async function removeReaction(serverId: string, messageId: string, memberType: "user" | "agent", memberId: string, emoji: string) {
  await db.delete(schema.reactions).where(and(eq(schema.reactions.messageId, messageId), eq(schema.reactions.memberType, memberType), eq(schema.reactions.memberId, memberId), eq(schema.reactions.emoji, emoji)));
  const m = await serializeMessageById(messageId);
  if (m) await publish(serverId, { type: "message:updated", message: m });
  return m;
}

// ── Saved messages / bookmarks (/channels/saved) ──
// Private bookmarks: deduplicated per member (unique index), no broadcast. save is idempotent (onConflictDoNothing).
export async function saveMessage(serverId: string, messageId: string, memberType: "user" | "agent", memberId: string) {
  await db.insert(schema.savedMessages).values({ serverId, messageId, memberType, memberId }).onConflictDoNothing();
}
export async function unsaveMessage(serverId: string, messageId: string, memberType: "user" | "agent", memberId: string) {
  await db.delete(schema.savedMessages).where(and(
    eq(schema.savedMessages.serverId, serverId), eq(schema.savedMessages.messageId, messageId),
    eq(schema.savedMessages.memberType, memberType), eq(schema.savedMessages.memberId, memberId)));
}
/** Bulk check which messageIds have been saved by this member (POST /channels/saved/check → {savedIds[]}). */
export async function checkSaved(serverId: string, memberType: "user" | "agent", memberId: string, messageIds: string[]): Promise<string[]> {
  if (!messageIds.length) return [];
  const rows = await db.select({ messageId: schema.savedMessages.messageId }).from(schema.savedMessages).where(and(
    eq(schema.savedMessages.serverId, serverId), eq(schema.savedMessages.memberType, memberType),
    eq(schema.savedMessages.memberId, memberId), inArray(schema.savedMessages.messageId, messageIds)));
  return rows.map((r) => r.messageId);
}
/** List saved messages (GET /channels/saved):
 * envelope {saved[], hasMore}; item is flat, uses messageId, inlines channel + thread parent context; no savedAt/attachments/reactions.
 * Ordered by savedAt (saved row createdAt) descending, limit+offset pagination (limit+1 probe for hasMore). */
export async function listSaved(serverId: string, memberType: "user" | "agent", memberId: string, limit: number, offset: number) {
  const rows = await db.select().from(schema.savedMessages).where(and(
    eq(schema.savedMessages.serverId, serverId), eq(schema.savedMessages.memberType, memberType),
    eq(schema.savedMessages.memberId, memberId))).orderBy(desc(schema.savedMessages.createdAt)).limit(limit + 1).offset(offset);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  if (!page.length) return { saved: [], hasMore: false };
  // Batch-load messages + their channels + (when thread) parent messages and parent channels, avoid N+1
  const msgs = await db.select().from(schema.messages).where(inArray(schema.messages.id, page.map((r) => r.messageId)));
  const msgById = new Map(msgs.map((m) => [m.id, m]));
  const chans = await db.select().from(schema.channels).where(inArray(schema.channels.id, [...new Set(msgs.map((m) => m.channelId))]));
  const chById = new Map(chans.map((c) => [c.id, c]));
  // thread channel → parent message → parent channel
  const parentMsgIds = [...new Set(chans.filter((c) => c.type === "thread" && c.parentMessageId).map((c) => c.parentMessageId!))];
  const parentMsgs = parentMsgIds.length ? await db.select().from(schema.messages).where(inArray(schema.messages.id, parentMsgIds)) : [];
  const parentMsgById = new Map(parentMsgs.map((m) => [m.id, m]));
  const parentChans = parentMsgs.length ? await db.select().from(schema.channels).where(inArray(schema.channels.id, [...new Set(parentMsgs.map((m) => m.channelId))])) : [];
  const parentChById = new Map(parentChans.map((c) => [c.id, c]));
  // IDOR-B5 residual (sec-idor6): read-time channel-access gate. A saved row's message may now live in a
  // channel the saver can no longer read (lost membership / channel turned private) or be an illegitimate
  // pre-write-gate save — re-check access at read time and drop what the caller can't currently see.
  // Hides (does not delete): re-gaining access surfaces it again. Same gate as the write path, per plane.
  const gate = memberType === "user" ? canUserReadChannel : canAgentReadChannel;
  const accessByChannel = new Map<string, boolean>(
    await Promise.all([...new Set(msgs.map((m) => m.channelId))].map(
      async (cid) => [cid, await gate(serverId, cid, memberId)] as const)),
  );
  const saved = page.map((r) => {
    const m = msgById.get(r.messageId);
    if (!m) return null;
    if (!accessByChannel.get(m.channelId)) return null; // read-time channel-access gate (IDOR-B5 residual): drop messages in channels the caller can't currently read
    const ch = chById.get(m.channelId);
    const isThread = ch?.type === "thread";
    const pm = isThread && ch?.parentMessageId ? parentMsgById.get(ch.parentMessageId) : undefined;
    const pch = pm ? parentChById.get(pm.channelId) : undefined;
    return {
      messageId: m.id, content: m.content, createdAt: m.createdAt,
      channelId: m.channelId, channelType: ch?.type ?? "channel", channelName: ch?.name ?? null,
      parentChannelId: pch?.id ?? null, parentChannelType: pch?.type ?? null, parentChannelName: pch?.name ?? null,
      parentMessageId: isThread ? (ch?.parentMessageId ?? null) : null,
      senderId: m.senderId, senderType: m.senderType, senderName: m.senderName,
    };
  }).filter(Boolean);
  return { saved, hasMore };
}

export async function agentConfig(agentId: string) {
  // Skip soft-deleted agents (treated as non-existent → null, which every caller already handles): otherwise the
  // mint branch below would re-set `agentTokenHash` on a deleted row, reverting the clear done on delete (C4).
  const a = (await db.select().from(schema.agents).where(and(eq(schema.agents.id, agentId), isNull(schema.agents.deletedAt))))[0];
  if (!a) return null;
  // Per-agent independent token (sk_agent_* prefix, slice10):
  // cache hit → reuse; first time → mint + store hash + cache raw; agent already running (cache lost after server restart but agent still running) → do not re-mint or send new token (daemon ignores agent:start for running agents, agent continues using old token, server verifies via DB hash) → zero desync.
  let token = agentRawTokens.get(a.id);
  if (!token && !(a.status === "active" && a.agentTokenHash)) {
    token = newKey("sk_agent_");
    agentRawTokens.set(a.id, token);
    await db.update(schema.agents).set({ agentTokenHash: hashToken(token) }).where(eq(schema.agents.id, a.id));
  }
  return {
    name: a.name, displayName: a.displayName, description: a.description,
    model: a.model, runtime: a.runtime, runtimeConfig: a.runtimeConfig, sessionId: a.sessionId ?? undefined,
    serverUrl: SELF_URL, serverId: a.serverId, agentId: a.id, agentToken: token,
  };
}

export async function createMessage(opts: {
  serverId: string; channelId: string;
  senderType: "user" | "agent" | "system"; senderId: string | null; senderName: string;
  content: string; messageType?: string; threadId?: string | null; asTask?: boolean; attachmentIds?: string[];
  actionMetadata?: unknown; // action-card and other platform action payloads (slice09)
}) {
  const seq = await nextSeq(opts.serverId);
  // Channel row fetched once; its type drives task-number scope (per-DM vs per-server), thread auto-follow, mention auto-join, and wake routing below.
  const ch = (await db.select().from(schema.channels).where(eq(schema.channels.id, opts.channelId)))[0];
  const taskNumber = opts.asTask ? await nextTaskNumber(opts.serverId, ch) : null;
  const [msg] = await db.insert(schema.messages).values({
    seq, serverId: opts.serverId, channelId: opts.channelId,
    senderType: opts.senderType, senderId: opts.senderId, senderName: opts.senderName,
    messageType: opts.messageType ?? "chat", content: opts.content,
    actionMetadata: opts.actionMetadata ?? null,
    threadId: opts.threadId ?? null, searchText: opts.content,
    taskStatus: opts.asTask ? "todo" : null, taskNumber,
  }).returning();

  // auto-follow: reply to thread → sender auto-joins; replying after done clears done and brings thread back to inbox
  if (opts.senderId && opts.senderType !== "system" && ch?.type === "thread") {
    await db.insert(schema.channelMembers).values({ channelId: opts.channelId, memberType: opts.senderType, memberId: opts.senderId }).onConflictDoNothing();
    await db.update(schema.channelMembers).set({ threadDoneAt: null }).where(eq(schema.channelMembers.channelId, opts.channelId)); // new reply → reset done for thread followers (thread becomes active again in inbox)
  }

  // Attachments: backfill messageId/channelId onto the attachment uploaded earlier, so it appears in the channel Files list
  let atts: (typeof schema.attachments.$inferSelect)[] = [];
  if (opts.attachmentIds?.length) {
    await db.update(schema.attachments).set({ messageId: msg!.id, channelId: opts.channelId }).where(inArray(schema.attachments.id, opts.attachmentIds));
    atts = await db.select().from(schema.attachments).where(inArray(schema.attachments.id, opts.attachmentIds));
  }

  let members = await channelMembers(opts.channelId);
  // Human-authored Slack-style mention auto-join: @-mentioning someone who isn't in this channel yet pulls them in, so the
  // mention is recorded + delivered (wake / inbox) instead of being silently dropped. A thread inherits its
  // parent channel's @-reach (mentionAutoJoinPool — the same parent-channel inheritance canReadChannel uses),
  // so @-ing a teammate who hasn't replied in the thread yet still wakes them. Public channel → whole
  // workspace; private/dm (and their threads) → existing members only, so an @ to a non-member stays a no-op.
  // Agent-authored text must not mutate channel membership: a model casually mentioning @Reviewer should not
  // pull that agent into a channel and start a reply loop.
  if (ch && canAutoJoinMentionedMembers(opts.senderType) && opts.content.includes("@")) {
    const joined = await autoJoinMentioned(opts.serverId, opts.channelId, opts.content, members, await mentionAutoJoinPool(opts.serverId, ch), seq - 1);
    if (joined.length) members = [...members, ...joined];
  }
  const mentions = parseMentions(opts.content, members);
  if (mentions.length) {
    await db.insert(schema.messageMentions).values(
      mentions.map((x) => ({ messageId: msg!.id, mentionType: x.type, mentionId: x.id, mentionName: x.name })),
    );
  }
  await db.update(schema.channels).set({ lastMessageAt: new Date() }).where(eq(schema.channels.id, opts.channelId));

  // Task creation immediately creates a thread (all tasks have a thread, parentMessageId=task message; created before done)
  if (opts.asTask) {
    const th = await getOrCreateThread(opts.serverId, msg!.id);
    await db.update(schema.messages).set({ threadId: th.id }).where(eq(schema.messages.id, msg!.id));
    msg!.threadId = th.id;
  }
  // Human-side realtime
  await publish(opts.serverId, { type: "message", channelId: opts.channelId, message: { ...serializeMsg(msg!, mentions, atts), channelType: ch?.type ?? null } });
  if (opts.asTask) {
    await publish(opts.serverId, { type: "task", op: "created", task: serializeMsg(msg!, mentions, atts) });
    const actor = (opts.senderType === "user" || opts.senderType === "agent") && opts.senderId ? { type: opts.senderType, id: opts.senderId } : undefined;
    await sysTaskMsg(opts.serverId, opts.channelId, `${opts.senderName} created task #${taskNumber} "${taskTitle(opts.content)}"`, actor); // audit trail (task system messages)
  }

  // Agent-side wake: only wake agents @-mentioned (in channel), or agent members in a DM.
  const isDm = ch?.type === "dm";
  // Message in thread channel → broadcast thread:updated (parentMessageId + replyCount + participantIds)
  await publishThreadUpdated(opts.serverId, ch, opts.senderId, opts.senderType);
  const mentionedAgents = new Set(mentions.filter((m) => m.type === "agent").map((m) => m.id));
  // inbox notice uses human-readable target (#name / dm:@sender), not uuid. threads use channel name.
  const targetName = isDm ? `dm:@${opts.senderName}` : `#${ch?.name ?? opts.channelId}`;
  const msgShort = msg!.id.slice(0, 8);
  const woken: string[] = [];
  for (const mem of members) {
    if (mem.type !== "agent" || mem.id === opts.senderId) continue;
    const mentioned = mentionedAgents.has(mem.id);
    // Channel messages delivered to all agent members (not limited to @; wake even without @, model decides whether to reply).
    // Ambient wake without @ requires inbox:receive scope; @-mentioned or DM always delivers.
    if (!isDm && !mentioned) {
      const a0 = (await db.select({ scopes: schema.agents.scopes }).from(schema.agents).where(eq(schema.agents.id, mem.id)))[0];
      if (!isWakeable({ channelType: ch?.type ?? "channel", mentioned, hasInboxScope: agentHasScope(a0?.scopes, "inbox:receive"), senderType: opts.senderType })) continue;
    }
    const target = await agentStartTarget(opts.serverId, mem.id);
    if (!target.ok) {
      if (target.reason !== "agent not found") await markAgentUnavailable(opts.serverId, mem.id, target.reason);
      continue;
    }
    const replyStreamId = agentReplyStreamId(msg!.id, mem.id);
    await publish(opts.serverId, { type: "agent:reply", agentId: mem.id, channelId: opts.channelId, streamId: replyStreamId, name: mem.displayName || mem.name, triggerMessageId: msg!.id, op: "start" });
    const startSent = sendAgentStart(opts.serverId, target, mem.id);
    const deliverSent = startSent && sendAgentDeliver(opts.serverId, target, { agentId: mem.id, seq, from: opts.senderName, target: opts.channelId, targetName, msgShort, isTask: !!opts.asTask, message: { content: opts.content }, mentioned, streamId: replyStreamId });
    if (!deliverSent) {
      await publish(opts.serverId, { type: "agent:reply", agentId: mem.id, channelId: opts.channelId, streamId: replyStreamId, name: mem.displayName || mem.name, op: "error", text: "machine offline" });
      await markAgentUnavailable(opts.serverId, mem.id, "machine offline");
      continue;
    }
    woken.push(mem.name + (mentioned ? "(@)" : ""));
  }
  log.info("message created", {
    seq, channel: opts.channelId, from: opts.senderName, kind: opts.senderType,
    mentions: mentions.map((x) => x.name),
    wakeAgents: woken,
  });
  return msg!;
}

/** Target resolution: #name / dm:@name / thread #name:shortid or dm:@name:shortid.
 *  Thread suffix shortid = 8-char short id of the parent message → resolve/create the thread channel for that parent message (thread = standalone channel, unified for human/agent). */
// May this AGENT read/act in this channel? The agent-plane mirror of the human `canReadChannel` (socketio.ts):
// a channel member, OR a public channel in the agent's server, OR a thread whose parent channel is accessible.
// Private / DM channels the agent was never added to are refused → private content stays isolated on the agent
// plane too (docs/authorization.md invariant 4). resolveTarget / resolveMessageId / findParent all gate on this,
// so every channel-touching /agent-api/* endpoint inherits the boundary at once.
export async function canAgentReadChannel(serverId: string, channelId: string, agentId: string): Promise<boolean> {
  const member = (await db.select().from(schema.channelMembers).where(and(eq(schema.channelMembers.channelId, channelId), eq(schema.channelMembers.memberType, "agent"), eq(schema.channelMembers.memberId, agentId))))[0];
  if (member) return true;
  const ch = (await db.select().from(schema.channels).where(eq(schema.channels.id, channelId)))[0];
  if (!ch || ch.serverId !== serverId || ch.deletedAt) return false;
  if (ch.type === "channel") return true;                                  // public: any agent in the server may read
  if (ch.parentMessageId) {                                                // thread: visibility follows its parent message's channel
    const parent = (await db.select().from(schema.messages).where(eq(schema.messages.id, ch.parentMessageId)))[0];
    if (parent) return canAgentReadChannel(serverId, parent.channelId, agentId); // depth 1 (a parent channel is never itself a thread)
  }
  return false;                                                            // private / DM the agent is not a member of
}

export async function resolveTarget(serverId: string, target: string, selfAgentId: string): Promise<{ channelId: string; threadId: string | null } | null> {
  let t = target.trim();
  if (t.startsWith("thread:")) {
    const short = t.slice("thread:".length).trim();
    if (!/^[0-9a-f]{6,}$/i.test(short)) return null;
    const parent = (await db.select().from(schema.messages).where(and(
      eq(schema.messages.serverId, serverId),
      like(sql`${schema.messages.id}::text`, short.toLowerCase() + "%"),
    )))[0];
    if (!parent || parent.senderType === "system") return null;
    const existing = (await db.select().from(schema.channels).where(and(
      eq(schema.channels.serverId, serverId),
      eq(schema.channels.type, "thread"),
      eq(schema.channels.parentMessageId, parent.id),
    )))[0];
    if (existing) {
      if (!(await canAgentReadChannel(serverId, existing.id, selfAgentId))) return null;
      return { channelId: existing.id, threadId: null };
    }
    if (!(await canAgentReadChannel(serverId, parent.channelId, selfAgentId))) return null;
    const th = await getOrCreateThread(serverId, parent.id, { type: "agent", id: selfAgentId });
    return { channelId: th.id, threadId: null };
  }
  let threadShort: string | null = null;
  const colon = t.lastIndexOf(":");
  if (colon > 0 && !t.slice(colon + 1).includes("@") && /^[0-9a-f]{6,}$/i.test(t.slice(colon + 1))) {
    threadShort = t.slice(colon + 1); t = t.slice(0, colon);
  }
  // 1) Resolve base channel (DM or named channel)
  let baseChannelId: string | null = null;
  if (t.startsWith("dm:@")) {
    const peer = t.slice(4);
    const uRow = (await db.select().from(schema.users).where(eq(schema.users.name, peer)))[0];
    // The peer user must belong to THIS server (the agent lookup below is already server-scoped); otherwise an
    // agent could open a cross-tenant DM to any global username. users.name is global, so gate on serverMembers.
    const u = uRow && (await db.select().from(schema.serverMembers).where(and(eq(schema.serverMembers.serverId, serverId), eq(schema.serverMembers.userId, uRow.id))))[0] ? uRow : undefined;
    const a = (await db.select().from(schema.agents).where(and(eq(schema.agents.name, peer), eq(schema.agents.serverId, serverId))))[0];
    const peerId = u?.id ?? a?.id; const peerType = u ? "user" : a ? "agent" : null;
    if (!peerId || !peerType) return null;
    baseChannelId = await getOrCreateDM(serverId, selfAgentId, "agent", peerId, peerType);
  } else {
    const ch = (await db.select().from(schema.channels).where(and(eq(schema.channels.serverId, serverId), eq(schema.channels.name, t.replace(/^#/, "")))))[0];
    baseChannelId = ch?.id ?? null;
  }
  if (!baseChannelId) return null;
  // 2) No thread suffix → base channel; has suffix → find parent message (short id prefix) → thread channel of that parent message
  if (!threadShort) {
    // Agent ACL: the agent may only resolve a base channel it can access (public, a DM it just got, or a private
    // it was added to). This gate intentionally happens only for non-thread targets; existing thread membership
    // is enough for the thread case below.
    if (!(await canAgentReadChannel(serverId, baseChannelId, selfAgentId))) return null;
    return { channelId: baseChannelId, threadId: null };
  }
  const parent = (await db.select().from(schema.messages).where(and(eq(schema.messages.serverId, serverId), eq(schema.messages.channelId, baseChannelId), like(sql`${schema.messages.id}::text`, threadShort.toLowerCase() + "%"))))[0];
  // System messages ("X created task / claimed / moved …") are not real conversation anchors and have no
  // "open thread" affordance in the UI — threading onto one buries the reply where no one can reach it.
  // Reject so the caller surfaces a clear error instead of silently creating an unreachable thread.
  if (!parent || parent.senderType === "system") return null;
  const existing = (await db.select().from(schema.channels).where(and(
    eq(schema.channels.serverId, serverId),
    eq(schema.channels.type, "thread"),
    eq(schema.channels.parentMessageId, parent.id),
  )))[0];
  if (existing) {
    if (!(await canAgentReadChannel(serverId, existing.id, selfAgentId))) return null;
    return { channelId: existing.id, threadId: null };
  }
  if (!(await canAgentReadChannel(serverId, baseChannelId, selfAgentId))) return null;
  const th = await getOrCreateThread(serverId, parent.id, { type: "agent", id: selfAgentId });
  return { channelId: th.id, threadId: null };
}

export async function getOrCreateDM(serverId: string, aId: string, aType: string, bId: string, bType: string): Promise<string> {
  // Simplified: DM channel name = dm:<sorted ids>
  const key = "dm:" + [aId, bId].sort().join(":");
  const existing = (await db.select().from(schema.channels).where(and(eq(schema.channels.serverId, serverId), eq(schema.channels.name, key))))[0];
  if (existing) return existing.id;
  // Atomic create: partitioned unique index (serverId, name WHERE type=dm) ensures only one row under concurrency; losing insert returns empty → re-select to get that row.
  const [ch] = await db.insert(schema.channels).values({ serverId, name: key, type: "dm" }).onConflictDoNothing().returning();
  if (!ch) return (await db.select().from(schema.channels).where(and(eq(schema.channels.serverId, serverId), eq(schema.channels.name, key))))[0]!.id;
  await db.insert(schema.channelMembers).values([
    { channelId: ch.id, memberType: aType, memberId: aId },
    { channelId: ch.id, memberType: bType, memberId: bId },
  ]).onConflictDoNothing();
  return ch.id;
}

/** Find/create thread channel (thread = channel with type=thread, carrying parentMessageId). Idempotent. creator added as member = auto follow. */
export async function getOrCreateThread(serverId: string, parentMessageId: string, creator?: { type: "user" | "agent"; id: string }) {
  let thread = (await db.select().from(schema.channels).where(and(eq(schema.channels.serverId, serverId), eq(schema.channels.type, "thread"), eq(schema.channels.parentMessageId, parentMessageId))))[0];
  if (!thread) {
    // Atomic create: partitioned unique index (serverId, parentMessageId WHERE type=thread) ensures only one row under concurrency; losing insert returns empty → re-select.
    const [ch] = await db.insert(schema.channels).values({ serverId, type: "thread", parentMessageId, name: `thread-${parentMessageId.slice(0, 8)}` }).onConflictDoNothing().returning();
    thread = ch ?? (await db.select().from(schema.channels).where(and(eq(schema.channels.serverId, serverId), eq(schema.channels.type, "thread"), eq(schema.channels.parentMessageId, parentMessageId))))[0]!;
    if (ch) { // only add thread root member on the actual new creation (skip for the losing insert)
      const parent = (await db.select().from(schema.messages).where(eq(schema.messages.id, parentMessageId)))[0];
      if (parent?.senderId) await db.insert(schema.channelMembers).values({ channelId: thread.id, memberType: parent.senderType as "user" | "agent", memberId: parent.senderId }).onConflictDoNothing();
    }
  }
  if (creator) await db.insert(schema.channelMembers).values({ channelId: thread.id, memberType: creator.type, memberId: creator.id }).onConflictDoNothing();
  return thread;
}

// ── Tasks (message-as-task): convert / claim / unclaim / status, all emit task:updated ──────
async function taskMentions(messageId: string): Promise<Member[]> {
  const mts = await db.select().from(schema.messageMentions).where(eq(schema.messageMentions.messageId, messageId));
  return mts.map((x) => ({ type: x.mentionType as "user" | "agent", id: x.mentionId, name: x.mentionName, displayName: x.mentionName }));
}
async function emitTaskUpdated(serverId: string, msg: typeof schema.messages.$inferSelect): Promise<void> {
  await publish(serverId, { type: "task", op: "updated", task: serializeMsg(msg, await taskMentions(msg.id)) });
}

/** Mark an existing message as a task (open + assign taskNumber). */
// ── Task lifecycle system messages (convert/claim/unclaim/status each emit one messageType:system audit entry) ──
const taskTitle = (s: string) => { const t = ((s || "").split("\n")[0] ?? "").trim(); return t.length > 40 ? t.slice(0, 40) + "…" : t; };
// Task status system message copy (Title-Case + status emoji prefix). Emojis confirmed for in_progress 🔄 / in_review 👁; todo/done/closed pending confirmation, no guessing.
const STATUS_LABEL: Record<string, string> = { todo: "Todo", in_progress: "In Progress", in_review: "In Review", done: "Done", closed: "Closed" };
const STATUS_EMOJI: Record<string, string> = { in_progress: "🔄", in_review: "👁" };
async function actorName(type: "user" | "agent", id: string): Promise<string> {
  if (type === "agent") { const a = (await db.select().from(schema.agents).where(eq(schema.agents.id, id)))[0]; return a?.displayName || a?.name || "agent"; }
  const u = (await db.select().from(schema.users).where(eq(schema.users.id, id)))[0]; return u?.displayName || u?.name || "someone";
}
// Lightweight system message: only insert + publish message, no wake/no task creation (otherwise every status change wakes all agents = noise)
async function sysTaskMsg(serverId: string, channelId: string, content: string, actor?: { type: "user" | "agent"; id: string }) {
  const seq = await nextSeq(serverId);
  const [m] = await db.insert(schema.messages).values({ seq, serverId, channelId, senderType: "system", senderId: actor?.id ?? null, senderName: "system", messageType: "system", content, searchText: content }).returning();
  const ch = (await db.select().from(schema.channels).where(eq(schema.channels.id, channelId)))[0];
  await db.update(schema.channels).set({ lastMessageAt: new Date() }).where(eq(schema.channels.id, channelId));
  await publish(serverId, { type: "message", channelId, message: { ...serializeMsg(m!, [], []), channelType: ch?.type ?? null } });
  await publishThreadUpdated(serverId, ch, actor?.id ?? null, "system");
  return m!;
}

export async function convertMessageToTask(serverId: string, messageId: string, by?: { type: "user" | "agent"; id: string }) {
  const m = (await db.select().from(schema.messages).where(and(eq(schema.messages.id, messageId), eq(schema.messages.serverId, serverId))))[0];
  if (!m) return null;
  if (m.taskStatus) return m; // already a task, idempotent (fast path)
  // Atomic claim: only change status when not yet a task (whoever's UPDATE matches taskStatus IS NULL wins);
  // prevents concurrent double-convert → wasted task numbers + gaps + duplicate task:created events. Loser returns current state.
  const [claimed] = await db.update(schema.messages).set({ taskStatus: "todo", updatedAt: new Date() })
    .where(and(eq(schema.messages.id, messageId), eq(schema.messages.serverId, serverId), isNull(schema.messages.taskStatus))).returning();
  if (!claimed) return (await db.select().from(schema.messages).where(eq(schema.messages.id, messageId)))[0] ?? null;
  // Winner gets a task number scoped to the channel (per-DM for DMs, per-server otherwise) + creates thread (tasks always have a thread)
  const ch = (await db.select().from(schema.channels).where(eq(schema.channels.id, m.channelId)))[0];
  const taskNumber = await nextTaskNumber(serverId, ch);
  const th = await getOrCreateThread(serverId, messageId);
  const [upd] = await db.update(schema.messages).set({ taskNumber, threadId: th.id }).where(eq(schema.messages.id, messageId)).returning();
  await publish(serverId, { type: "task", op: "created", task: serializeMsg(upd!, await taskMentions(messageId)) });
  const an = by ? await actorName(by.type, by.id) : "Someone";
  await sysTaskMsg(serverId, upd!.channelId, `${an} converted a message to task #${taskNumber} "${taskTitle(upd!.content)}"`, by);
  return upd!;
}

/** Claim a task → in_progress + assignee. */
/**
 * Resolve messageId: accepts full uuid or the 8-char short id from message headers (msg=<shortid>).
 * Agents see short ids and will use them directly for claim/update/reply → previously the endpoint queried the uuid column with a short id and threw 500.
 * Full uuid → verify existence; short id (6+ hex) → prefix match; neither → null (caller returns 404, never 500).
 */
/** Single definition of the agent-facing id convention: full uuid → exact match; 6+ hex chars → serverId-scoped
 *  prefix match; anything else (dashes in a partial, LIKE metachars, too short) → null — never a 500 from casting
 *  a non-uuid into the uuid column. Shared by messages (resolveMessageId) and attachments (attachment/view) so
 *  the convention cannot drift per-resource. Returns the resolved full id; the caller applies its own ACL. */
export async function resolveIdOrPrefix(
  table: typeof schema.messages | typeof schema.attachments,
  serverId: string,
  idOrShort: string | undefined | null,
): Promise<string | null> {
  const s = (idOrShort ?? "").trim().toLowerCase();
  if (!s) return null;
  let r: { id: string } | undefined;
  if (UUID_RE.test(s)) {
    r = (await db.select({ id: table.id }).from(table).where(and(eq(table.id, s), eq(table.serverId, serverId))))[0];
  } else if (/^[0-9a-f]{6,}$/.test(s)) {
    r = (await db.select({ id: table.id }).from(table).where(and(like(sql`${table.id}::text`, s + "%"), eq(table.serverId, serverId))).limit(1))[0];
  }
  return r?.id ?? null;
}
// Resolve a (short or full) message id within a server. ALWAYS pass `agentId` when called on the agent plane
// (/agent-api/*): without it the channel ACL is skipped, so an agent could resolve a message in a channel it
// cannot access. The optional default exists only for non-agent internal callers (there are none today).
export async function resolveMessageId(serverId: string, idOrShort: string | undefined | null, agentId?: string): Promise<string | null> {
  const id = await resolveIdOrPrefix(schema.messages, serverId, idOrShort);
  if (!id) return null;
  const m = (await db.select({ id: schema.messages.id, channelId: schema.messages.channelId }).from(schema.messages).where(eq(schema.messages.id, id)))[0];
  if (!m) return null;
  // Agent ACL: on the agent plane (agentId passed), only resolve a message in a channel the agent can access —
  // otherwise an agent could probe/react/claim any message in the server by its (short) id.
  if (agentId && !(await canAgentReadChannel(serverId, m.channelId, agentId))) return null;
  return m.id;
}

export async function claimTask(serverId: string, messageId: string, assigneeType: "user" | "agent", assigneeId: string) {
  // Atomic claim: conditional UPDATE, succeeds only when the task "has not been claimed by another" (taskAssigneeId is null or already this agent = idempotent).
  // Postgres UPDATE...WHERE acquires a row lock before re-evaluating the predicate → concurrent claims for the same task: only one wins, others get 0 rows → return null (claim failed).
  // Before the fix this was an unconditional UPDATE: two agents both "succeeded" concurrently and both believed they owned the task → duplicate work.
  const [upd] = await db.update(schema.messages)
    .set({ taskStatus: "in_progress", taskAssigneeType: assigneeType, taskAssigneeId: assigneeId, taskClaimedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(schema.messages.id, messageId),
      eq(schema.messages.serverId, serverId),
      isNotNull(schema.messages.taskStatus), // invariant guard: a status mutator only touches an existing task — never promotes a plain message (which would mint a task with no number). Callers convert first.
      or(isNull(schema.messages.taskAssigneeId), eq(schema.messages.taskAssigneeId, assigneeId)),
    )).returning();
  if (!upd) return null; // 0 rows = already claimed by another (or task does not exist) → claim failed, caller should back off
  await emitTaskUpdated(serverId, upd);
  await sysTaskMsg(serverId, upd.channelId, `${await actorName(assigneeType, assigneeId)} claimed #${upd.taskNumber} "${taskTitle(upd.content)}"`, { type: assigneeType, id: assigneeId });
  return upd;
}

export async function unclaimTask(serverId: string, messageId: string, by?: { type: "user" | "agent"; id: string }) {
  const [upd] = await db.update(schema.messages)
    .set({ taskStatus: "todo", taskAssigneeType: null, taskAssigneeId: null, taskClaimedAt: null, updatedAt: new Date() })
    .where(and(eq(schema.messages.id, messageId), eq(schema.messages.serverId, serverId), isNotNull(schema.messages.taskStatus))).returning();
  if (!upd) return null;
  await emitTaskUpdated(serverId, upd);
  await sysTaskMsg(serverId, upd.channelId, `${by ? await actorName(by.type, by.id) : "Someone"} released #${upd.taskNumber} "${taskTitle(upd.content)}"`, by);
  return upd;
}

export async function assignTask(
  serverId: string,
  messageId: string,
  assigneeId: string,
  by?: { type: "user" | "agent"; id: string },
) {
  const target = (await db.select().from(schema.agents).where(and(
    eq(schema.agents.id, assigneeId),
    eq(schema.agents.serverId, serverId),
    isNull(schema.agents.deletedAt),
  )))[0];
  if (!target) return null;

  const cur = (await db.select().from(schema.messages).where(and(
    eq(schema.messages.id, messageId),
    eq(schema.messages.serverId, serverId),
    isNotNull(schema.messages.taskStatus),
  )))[0];
  if (!cur) return null;

  const sameAssignee = cur.taskAssigneeType === "agent" && cur.taskAssigneeId === assigneeId;
  if (sameAssignee) return cur;

  const nextStatus = cur.taskStatus === "todo" ? "in_progress" : cur.taskStatus;
  const [upd] = await db.update(schema.messages)
    .set({
      taskStatus: nextStatus,
      taskAssigneeType: "agent",
      taskAssigneeId: assigneeId,
      taskClaimedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(
      eq(schema.messages.id, messageId),
      eq(schema.messages.serverId, serverId),
      isNotNull(schema.messages.taskStatus),
    ))
    .returning();
  if (!upd) return null;

  await emitTaskUpdated(serverId, upd);
  const th = await getOrCreateThread(serverId, upd.id);
  const threadCh = th.id;
  if (!upd.threadId) {
    await db.update(schema.messages).set({ threadId: threadCh }).where(eq(schema.messages.id, upd.id));
    upd.threadId = threadCh;
  }
  await db.insert(schema.channelMembers).values({ channelId: threadCh, memberType: "agent", memberId: assigneeId }).onConflictDoNothing();

  const actor = by ? await actorName(by.type, by.id) : "Someone";
  const assigneeName = target.displayName || target.name;
  const sysMsg = await sysTaskMsg(serverId, threadCh, `${actor} assigned #${upd.taskNumber} "${taskTitle(upd.content)}" to ${assigneeName}`, by);

  const startTarget = await agentStartTarget(serverId, assigneeId);
  if (startTarget.ok) {
    const startSent = sendAgentStart(serverId, startTarget, assigneeId);
    const deliverSent = startSent && sendAgentDeliver(serverId, startTarget, {
      agentId: assigneeId,
      seq: sysMsg.seq,
      from: actor,
      target: threadCh,
      targetName: `task #${upd.taskNumber}`,
      msgShort: sysMsg.id.slice(0, 8),
      isTask: true,
      message: { content: `#${upd.taskNumber} assigned to you` },
      mentioned: true,
    });
    if (!deliverSent) await markAgentUnavailable(serverId, assigneeId, "machine offline");
  } else if (startTarget.reason !== "agent not found") {
    await markAgentUnavailable(serverId, assigneeId, startTarget.reason);
  }

  return upd;
}

/** Valid task status enum; used by server to reject invalid values with 400. */
export const TASK_STATUSES = ["todo", "in_progress", "in_review", "done", "closed"] as const;

/** Change status (todo|in_progress|in_review|done|closed); done/closed records completedAt; done auto-creates thread. */
export async function setTaskStatus(serverId: string, messageId: string, status: string, by?: { type: "user" | "agent"; id: string }) {
  const finished = status === "done" || status === "closed";
  // Note: thread is already created at task creation/conversion time (findings §8.1 verified: all tasks have a thread, created before done); no need to create it here
  const [upd] = await db.update(schema.messages)
    .set({ taskStatus: status, taskCompletedAt: finished ? new Date() : null, updatedAt: new Date() })
    .where(and(eq(schema.messages.id, messageId), eq(schema.messages.serverId, serverId), isNotNull(schema.messages.taskStatus))).returning();
  if (!upd) return null;
  await emitTaskUpdated(serverId, upd); // task message itself updated (taskStatus) → lands in CHANNEL, updates badge + board in channel (verified: message:updated and task:updated both land in the channel)
  // "moved" system message for status change → lands in the task's THREAD, not channel (message:new channelId=task.threadId).
  const actor = by ? await actorName(by.type, by.id) : "Someone";
  // Ensure task has a thread (tasks always have a thread; create now for legacy data / not yet created) → moved system message lands in thread
  const th = await getOrCreateThread(serverId, upd.id);
  const threadCh = th.id;
  if (!upd.threadId) { await db.update(schema.messages).set({ threadId: threadCh }).where(eq(schema.messages.id, upd.id)); upd.threadId = threadCh; }
  const label = STATUS_LABEL[status] ?? status;
  const emoji = STATUS_EMOJI[status] ? STATUS_EMOJI[status] + " " : ""; // confirmed for in_progress/in_review; others pending confirmation, no guessing
  const sysMsg = await sysTaskMsg(serverId, threadCh, `${emoji}${actor} moved #${upd.taskNumber} "${taskTitle(upd.content)}" to ${label}`, by);
  // Wake the assigned agent (only when changed by someone else). Verified: human changes status → assignee agent fires agent:activity working detail="Message received".
  if (upd.taskAssigneeType === "agent" && upd.taskAssigneeId && by?.id !== upd.taskAssigneeId) {
    await db.insert(schema.channelMembers).values({ channelId: threadCh, memberType: "agent", memberId: upd.taskAssigneeId }).onConflictDoNothing(); // ensure assignee is a thread member, otherwise message check cannot see this system message
    const target = await agentStartTarget(serverId, upd.taskAssigneeId);
    if (target.ok) {
      const startSent = sendAgentStart(serverId, target, upd.taskAssigneeId);
      const deliverSent = startSent && sendAgentDeliver(serverId, target, { type: "agent:deliver", agentId: upd.taskAssigneeId, seq: sysMsg.seq, from: actor, target: threadCh, targetName: `task #${upd.taskNumber}`, msgShort: sysMsg.id.slice(0, 8), isTask: true, message: { content: `#${upd.taskNumber} → ${label}` }, mentioned: true });
      if (!deliverSent) await markAgentUnavailable(serverId, upd.taskAssigneeId, "machine offline");
    } else if (target.reason !== "agent not found") {
      await markAgentUnavailable(serverId, upd.taskAssigneeId, target.reason);
    }
  }
  return upd;
}

/** Delete task: revert to regular message — clear task fields, source message retained; emit task:deleted. */
export async function deleteTask(serverId: string, messageId: string) {
  const [upd] = await db.update(schema.messages)
    .set({ taskStatus: null, taskNumber: null, taskAssigneeType: null, taskAssigneeId: null, taskClaimedAt: null, taskCompletedAt: null, updatedAt: new Date() })
    .where(and(eq(schema.messages.id, messageId), eq(schema.messages.serverId, serverId), isNotNull(schema.messages.taskStatus))).returning();
  if (!upd) return null;
  await publish(serverId, { type: "task", op: "deleted", channelId: upd.channelId, taskId: upd.id });
  return upd;
}

// ── Agent lifecycle: start/stop/reset (target bound machine + update status + emit socket events) ──
async function publishAgentState(serverId: string, agentId: string, detail = ""): Promise<void> {
  const a = (await db.select().from(schema.agents).where(eq(schema.agents.id, agentId)))[0];
  if (a) await publish(serverId, { type: "agent", id: a.id, name: a.name, status: a.status, activity: a.activity, detail });
}
async function markAgentUnavailable(serverId: string, agentId: string, reason: string): Promise<void> {
  await db.update(schema.agents).set({ status: "inactive", activity: "offline" }).where(and(eq(schema.agents.id, agentId), eq(schema.agents.serverId, serverId)));
  await publishAgentState(serverId, agentId, reason);
  log.warn("agent unavailable", { agentId, reason });
}
type AgentStartTarget = { ok: true; machineId: string | null; cfg: NonNullable<Awaited<ReturnType<typeof agentConfig>>> };
type AgentControlTarget = { ok: true; machineId: string | null };

function sendAgentStart(serverId: string, target: AgentStartTarget, agentId: string): boolean {
  const msg = { type: "agent:start", agentId, config: target.cfg };
  if (target.machineId) return sendToMachine(target.machineId, msg);
  if (daemonCount(serverId) === 0) return false;
  broadcastToDaemons(serverId, msg);
  return true;
}

function sendAgentDeliver(serverId: string, target: AgentStartTarget, msg: Record<string, unknown>): boolean {
  if (target.machineId) return sendToMachine(target.machineId, { type: "agent:deliver", ...msg });
  if (daemonCount(serverId) === 0) return false;
  broadcastToDaemons(serverId, { type: "agent:deliver", ...msg });
  return true;
}

function sendAgentControl(serverId: string, target: AgentControlTarget, msg: Record<string, unknown>): boolean {
  if (target.machineId) return sendToMachine(target.machineId, msg);
  if (daemonCount(serverId) === 0) return false;
  broadcastToDaemons(serverId, msg);
  return true;
}

async function agentStartTarget(serverId: string, agentId: string): Promise<AgentStartTarget | { ok: false; reason: string }> {
  const a = (await db.select({
    machineId: schema.agents.machineId,
    runtime: schema.agents.runtime,
    machineStatus: schema.machines.status,
    machineRuntimes: schema.machines.runtimes,
  }).from(schema.agents)
    .leftJoin(schema.machines, eq(schema.agents.machineId, schema.machines.id))
    .where(and(eq(schema.agents.id, agentId), eq(schema.agents.serverId, serverId), isNull(schema.agents.deletedAt))))[0];
  if (!a) return { ok: false, reason: "agent not found" };
  if (!a.machineId) {
    if (daemonCount(serverId) === 0) return { ok: false, reason: "no daemon online" };
    const cfg = await agentConfig(agentId);
    if (!cfg) return { ok: false, reason: "agent not found" };
    return { ok: true, machineId: null, cfg };
  }
  if (a.machineStatus !== "online" || !isMachineConnected(a.machineId)) return { ok: false, reason: "machine offline" };
  const runtime = a.runtime ?? "claude";
  const runtimes = Array.isArray(a.machineRuntimes) ? a.machineRuntimes : [];
  if (!runtimes.includes(runtime)) return { ok: false, reason: `runtime unavailable: ${runtime}` };
  const cfg = await agentConfig(agentId);
  if (!cfg) return { ok: false, reason: "agent not found" };
  return { ok: true, machineId: a.machineId, cfg };
}
async function agentControlTarget(serverId: string, agentId: string): Promise<AgentControlTarget | { ok: false; reason: string }> {
  const a = (await db.select({
    machineId: schema.agents.machineId,
    machineStatus: schema.machines.status,
  }).from(schema.agents)
    .leftJoin(schema.machines, eq(schema.agents.machineId, schema.machines.id))
    .where(and(eq(schema.agents.id, agentId), eq(schema.agents.serverId, serverId), isNull(schema.agents.deletedAt))))[0];
  if (!a) return { ok: false, reason: "agent not found" };
  if (!a.machineId) {
    if (daemonCount(serverId) === 0) return { ok: false, reason: "no daemon online" };
    return { ok: true, machineId: null };
  }
  if (a.machineStatus !== "online" || !isMachineConnected(a.machineId)) return { ok: false, reason: "machine offline" };
  return { ok: true, machineId: a.machineId };
}
/** Start an agent (requires local daemon to be online). */
export async function startAgent(serverId: string, agentId: string): Promise<{ ok: boolean; reason?: string }> {
  const target = await agentStartTarget(serverId, agentId);
  if (!target.ok) {
    if (target.reason !== "agent not found") await markAgentUnavailable(serverId, agentId, target.reason);
    return { ok: false, reason: target.reason };
  }
  if (!sendAgentStart(serverId, target, agentId)) {
    await markAgentUnavailable(serverId, agentId, "machine offline");
    return { ok: false, reason: "machine offline" };
  }
  await db.update(schema.agents).set({ status: "active", activity: "working" }).where(eq(schema.agents.id, agentId));
  await publishAgentState(serverId, agentId);
  return { ok: true };
}
export async function stopAgent(serverId: string, agentId: string): Promise<boolean> {
  const target = await agentControlTarget(serverId, agentId);
  if (target.ok) {
    if (!sendAgentControl(serverId, target, { type: "agent:stop", agentId })) log.warn("agent stop target unavailable", { agentId, reason: "machine offline" });
  } else if (target.reason !== "agent not found") {
    log.warn("agent stop target unavailable", { agentId, reason: target.reason });
  }
  await db.update(schema.agents).set({ status: "inactive", activity: "offline" }).where(and(eq(schema.agents.id, agentId), eq(schema.agents.serverId, serverId)));
  await publishAgentState(serverId, agentId);
  return true;
}
export async function resetAgent(serverId: string, agentId: string, wipeWorkspace = false, clearMemory = false): Promise<boolean> {
  const target = await agentControlTarget(serverId, agentId);
  if (target.ok) {
    if (!sendAgentControl(serverId, target, { type: "agent:reset", agentId, wipeWorkspace, clearMemory })) log.warn("agent reset target unavailable", { agentId, reason: "machine offline" });
  } else if (target.reason !== "agent not found") {
    log.warn("agent reset target unavailable", { agentId, reason: target.reason });
  }
  await db.update(schema.agents).set({ status: "inactive", activity: "offline", sessionId: null }).where(and(eq(schema.agents.id, agentId), eq(schema.agents.serverId, serverId)));
  await publishAgentState(serverId, agentId);
  return true;
}
/** Profile (displayName/description) changed → ask the daemon to sync the workspace MEMORY.md title + `## Role`.
 *  Pass the full current values (not just the changed field); the daemon rewrites only those, preserving the rest. */
export async function syncAgentProfile(serverId: string, agentId: string, displayName: string, description?: string | null): Promise<void> {
  const target = await agentControlTarget(serverId, agentId);
  if (target.ok) {
    if (!sendAgentControl(serverId, target, { type: "agent:profile", agentId, displayName, description: description ?? null })) log.warn("agent profile target unavailable", { agentId, reason: "machine offline" });
  } else if (target.reason !== "agent not found") {
    log.warn("agent profile target unavailable", { agentId, reason: target.reason });
  }
}

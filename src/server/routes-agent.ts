// Agent-side REST: /agent-api/*  (Bearer per-agent token sk_agent_* + x-agent-id; NOT a machine/bootstrap key — see docs/authorization.md §1)
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq, ne, gt, lt, inArray, asc, desc, ilike, like, sql, isNull } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { sendJson, sendErr, readJson, bearer, agentIdHeader } from "./util.js";
import { resolveAgent } from "./auth.js";
import { createMessage, resolveTarget, channelMembers, addReaction, removeReaction, getOrCreateThread, unclaimTask, claimTask, setTaskStatus, convertMessageToTask, TASK_STATUSES, resolveMessageId, canAgentReadChannel, descTooLong, DESC_TOO_LONG } from "./core.js";
import { agentHasScope } from "./scopes.js";
import { parseUpload } from "./attachments.js";
import { readObject } from "./storage.js";

// Freshness-hold draft buffer (prevents agent↔agent duplicate replies): when the agent sends
// and new messages have arrived since last read → save as draft + surface bounded context, do not post immediately.
// Agent can revise (send again to same target) or submit unchanged with `--send-draft`.
// Key = `agentId:channelId`, short-lived in-process (discarded on restart — acceptable, drafts are ephemeral by design).
const drafts = new Map<string, { content: string; attachmentIds: string[] }>();

// /agent-api action → required scope. Default mode grants all; custom mode enforces per granted list.
function requiredScope(p: string): string | null {
  if (p === "/agent-api/message/check") return "inbox:receive";
  if (p === "/agent-api/message/send") return "message:send";
  if (p === "/agent-api/message/read") return "message:read";
  if (p === "/agent-api/message/react") return "message:send";
  if (p === "/agent-api/server/info") return "server:read";
  if (p === "/agent-api/channel/join") return "channel:join";
  if (p === "/agent-api/task/list") return "task:read";
  if (p === "/agent-api/task/claim" || p === "/agent-api/task/update" || p === "/agent-api/task/new") return "task:write";
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

/** Human-readable addressable target: channel → #name; DM → dm:@peer; thread → <parentChannelTarget>:parentMessageShortId. Agent uses this to reply back to the same location. */
export async function addressableTarget(ch: typeof schema.channels.$inferSelect, selfAgentId: string): Promise<string> {
  // Thread channel: render as #parentChannel:shortid (or dm:@peer:shortid) so the agent can reuse it with message send --target
  if (ch.type === "thread" && ch.parentMessageId) {
    const parent = (await db.select().from(schema.messages).where(eq(schema.messages.id, ch.parentMessageId)))[0];
    if (parent) {
      const pch = (await db.select().from(schema.channels).where(eq(schema.channels.id, parent.channelId)))[0];
      if (pch) return `${await addressableTarget(pch, selfAgentId)}:${parent.id.slice(0, 8)}`;
    }
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
export const fmt = (m: typeof schema.messages.$inferSelect, target: string, atts: { filename: string; id: string }[] = []) => {
  const taskSuffix = m.taskStatus ? ` [task #${m.taskNumber} status=${m.taskStatus}]` : "";
  const attSuffix = atts.length ? ` [${atts.length} attachment${atts.length > 1 ? "s" : ""}: ${atts.map((a) => `${a.filename} (id:${a.id})`).join(", ")} — use open-tag attachment view to download]` : "";
  const type = m.senderType === "user" ? "human" : m.senderType; // message header uses "human" for human senders, not "user"
  // A thread-anchor message (m.threadId set = the thread it owns) is rendered as #chan:<this message's id>
  // — NOT the thread channel id — because resolveTarget resolves the suffix as a PARENT MESSAGE id prefix
  // (matches addressableTarget's convention). Using the thread channel id here made the shown target
  // unresolvable (404), so agents reusing it couldn't reply into the thread. See threadTargetRoundtrip test.
  return `[target=${target}${m.threadId ? ":" + m.id.slice(0, 8) : ""} msg=${m.id.slice(0, 8)} time=${localTime(m.createdAt)} type=${type}] @${m.senderName}: ${m.content}${taskSuffix}${attSuffix}`;
};

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
    const cms = await agentChannels(agent.id);
    const out: any[] = [];
    for (const cm of cms) {
      const ch = (await db.select().from(schema.channels).where(eq(schema.channels.id, cm.channelId)))[0];
      if (!ch || ch.deletedAt) continue;
      const msgs = await db.select().from(schema.messages).where(and(eq(schema.messages.channelId, cm.channelId), gt(schema.messages.seq, cm.lastReadSeq))).orderBy(asc(schema.messages.seq)).limit(100);
      const fresh = msgs.filter((m) => m.senderId !== agent.id);
      if (fresh.length) {
        const target = await addressableTarget(ch, agent.id);
        // Batch-load attachments → append attachment suffix to message header
        const atts = await db.select().from(schema.attachments).where(inArray(schema.attachments.messageId, fresh.map((m) => m.id)));
        const byMsg = new Map<string, { filename: string; id: string }[]>();
        for (const a of atts) { const k = a.messageId!; const arr = byMsg.get(k) ?? []; arr.push({ filename: a.filename, id: a.id }); byMsg.set(k, arr); }
        out.push(...fresh.map((m) => ({ ...serialize(m), text: fmt(m, target, byMsg.get(m.id) ?? []) })));
      }
      if (msgs.length) await db.update(schema.channelMembers).set({ lastReadSeq: msgs[msgs.length - 1]!.seq })
        .where(and(eq(schema.channelMembers.channelId, cm.channelId), eq(schema.channelMembers.memberType, "agent"), eq(schema.channelMembers.memberId, agent.id)));
    }
    return (sendJson(res, 200, { messages: out }), true);
  }

  if (p === "/agent-api/message/send" && method === "POST") {
    const b = await readJson(req);
    const atts = Array.isArray(b.attachmentIds) ? b.attachmentIds.filter(Boolean) : [];
    if (!b.target) return (sendErr(res, 400, "target required"), true);
    const tgt = await resolveTarget(serverId, b.target, agent.id);
    if (!tgt) return (sendErr(res, 404, "target not found", { code: "TARGET_FAILED" }), true);
    const draftKey = `${agent.id}:${tgt.channelId}`;
    const post = async (content: string, attachmentIds: string[]) => {
      drafts.delete(draftKey);
      const msg = await createMessage({ serverId, channelId: tgt.channelId, senderType: "agent", senderId: agent.id, senderName: agent.name, content, threadId: tgt.threadId, attachmentIds: attachmentIds.length ? attachmentIds : undefined });
      return (sendJson(res, 200, { ok: true, id: msg.id, seq: msg.seq, target: b.target }), true);
    };
    // --send-draft: submit existing draft as-is, bypassing freshness check
    if (b.sendDraft) {
      const d = drafts.get(draftKey);
      const content = d?.content ?? b.content ?? ""; const dAtts = (d?.attachmentIds?.length ? d.attachmentIds : atts);
      if (!content && !dAtts.length) return (sendErr(res, 400, "no draft to send"), true);
      return post(content, dAtts);
    }
    if (!b.content && !atts.length) return (sendErr(res, 400, "target + content (or attachmentIds) required"), true);
    // Freshness-hold: new messages arrived since agent last read (not self / not system) → save draft + surface bounded context, do not post immediately (prevents agent↔agent duplicate replies)
    const cm = (await db.select().from(schema.channelMembers).where(and(eq(schema.channelMembers.channelId, tgt.channelId), eq(schema.channelMembers.memberType, "agent"), eq(schema.channelMembers.memberId, agent.id))))[0];
    const lastRead = cm?.lastReadSeq ?? 0;
    const newer = (await db.select().from(schema.messages).where(and(eq(schema.messages.channelId, tgt.channelId), gt(schema.messages.seq, lastRead))).orderBy(asc(schema.messages.seq)).limit(20)).filter((m) => m.senderId !== agent.id && m.senderType !== "system");
    if (newer.length && cm) {
      drafts.set(draftKey, { content: b.content || "", attachmentIds: atts });
      await db.update(schema.channelMembers).set({ lastReadSeq: newer[newer.length - 1]!.seq }).where(and(eq(schema.channelMembers.channelId, tgt.channelId), eq(schema.channelMembers.memberType, "agent"), eq(schema.channelMembers.memberId, agent.id))); // Mark this batch as read → next send won't hold again unless further new messages arrive
      const ch = (await db.select().from(schema.channels).where(eq(schema.channels.id, tgt.channelId)))[0]!;
      const tname = await addressableTarget(ch, agent.id);
      const history = newer.map((m) => fmt(m, tname)).join("\n");
      const n = newer.length, pl = n > 1 ? "s" : "";
      const text = `Freshness hold: showing latest ${n} of ${n} newer message${pl}.\nYour message has been saved as a draft. Review the bounded context shown here, then choose one path.\n\n## Message History for ${tname} (${n} message${pl})\n\n${history}\n\nTo update the draft, send revised content normally:\n  open-tag message send --target "${b.target}" <<'MSG'\n  revised message\n  MSG\nTo send the current draft unchanged:\n  open-tag message send --send-draft --target "${b.target}"`;
      return (sendJson(res, 200, { held: true, draft: true, newerCount: n, messages: newer.map((m) => ({ ...serialize(m), text: fmt(m, tname) })), text }), true);
    }
    return post(b.content || "", atts);
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
    const out = b.remove ? await removeReaction(serverId, mid, "agent", agent.id, emoji) : await addReaction(serverId, mid, "agent", agent.id, emoji);
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
    const cid = eq(schema.messages.channelId, tgt.channelId);
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
      agents: agents.map((a) => ({ name: a.name, status: a.status, description: a.description ?? null })),
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
    await db.insert(schema.channelMembers).values({ channelId: ch.id, memberType: "agent", memberId: agent.id }).onConflictDoNothing();
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
  if (p === "/agent-api/task/list" && method === "GET") {
    const tgt = await resolveTarget(serverId, url.searchParams.get("channel") ?? "", agent.id);
    if (!tgt) return (sendErr(res, 404, "channel not found"), true);
    const tasks = await db.select().from(schema.messages).where(and(eq(schema.messages.channelId, tgt.channelId))).orderBy(asc(schema.messages.taskNumber));
    return (sendJson(res, 200, { tasks: tasks.filter((m) => m.taskStatus).map((m) => ({ number: m.taskNumber, status: m.taskStatus, content: m.content, id: m.id, assigneeId: m.taskAssigneeId })) }), true);
  }
  if (p === "/agent-api/task/claim" && method === "POST") {
    const b = await readJson(req);
    // Supports --channel "#ch" --number N (agent sees task as #N), or --message-id (short/full id)
    let mid: string | null = null;
    if (b.number != null && b.channel) {
      const tgt = await resolveTarget(serverId, String(b.channel), agent.id);
      if (tgt) mid = (await db.select({ id: schema.messages.id }).from(schema.messages).where(and(eq(schema.messages.channelId, tgt.channelId), eq(schema.messages.taskNumber, Number(b.number)))))[0]?.id ?? null;
    } else {
      mid = await resolveMessageId(serverId, b.messageId, agent.id); // Tolerates 8-character short id
    }
    if (!mid) return (sendErr(res, 404, "task not found"), true);
    await ensureTaskForAgent(mid); // claiming a plain message converts it to a task first (so it gets a number), then claims
    const r = await claimTask(serverId, mid, "agent", agent.id); // Atomic claim: returns null if already taken
    if (!r) return (sendErr(res, 409, "already claimed", { code: "CLAIM_FAILED" }), true);
    // Guide agent to follow up in the task's thread (report in task thread, not the main channel)
    const tm = (await db.select().from(schema.messages).where(eq(schema.messages.id, mid)))[0];
    const tch = tm ? (await db.select().from(schema.channels).where(eq(schema.channels.id, tm.channelId)))[0] : null;
    const threadTarget = tch ? `${await addressableTarget(tch, agent.id)}:${mid.slice(0, 8)}` : null;
    return (sendJson(res, 200, { ok: true, claimed: mid, number: tm?.taskNumber ?? null, threadTarget,
      followUp: threadTarget ? `Follow up in the task's thread: open-tag message send --target "${threadTarget}"` : null }), true);
  }
  if (p === "/agent-api/task/update" && method === "POST") {
    const b = await readJson(req);
    // Supports --channel + --number (agent sees task as #N), or --message-id
    let mid: string | null = null;
    if (b.number != null && b.channel) {
      const tgt = await resolveTarget(serverId, String(b.channel), agent.id);
      if (tgt) mid = (await db.select({ id: schema.messages.id }).from(schema.messages).where(and(eq(schema.messages.channelId, tgt.channelId), eq(schema.messages.taskNumber, Number(b.number)))))[0]?.id ?? null;
    } else {
      mid = await resolveMessageId(serverId, b.messageId, agent.id);
    }
    if (!mid) return (sendErr(res, 404, "message not found"), true);
    if (!(TASK_STATUSES as readonly string[]).includes(String(b.status))) return (sendErr(res, 400, `valid status is required (${TASK_STATUSES.join(", ")})`), true);
    await ensureTaskForAgent(mid); // updating the status of a plain message converts it to a task first (so it gets a number), then sets status
    // Reuse human-side setTaskStatus: done/closed writes completedAt + emits task:updated socket
    // (previously a bare db.update bypassed core → the web kanban did not refresh in real time for agent status changes)
    const upd = await setTaskStatus(serverId, mid, b.status, { type: "agent", id: agent.id });
    if (!upd) return (sendErr(res, 404, "task not found"), true);
    return (sendJson(res, 200, { ok: true, status: upd.taskStatus }), true);
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
    return parent;
  };
  if (p === "/agent-api/thread/reply" && method === "POST") {
    const b = await readJson(req);
    if (!b.parent || !b.content) return (sendErr(res, 400, "parent + content required"), true);
    const parent = await findParent(b.parent, b.channel ?? b.target ?? null);
    if (!parent) return (sendErr(res, 404, "parent message not found"), true);
    const th = await getOrCreateThread(serverId, parent.id, { type: "agent", id: agent.id });
    const msg = await createMessage({ serverId, channelId: th.id, senderType: "agent", senderId: agent.id, senderName: agent.name, content: b.content });
    return (sendJson(res, 200, { ok: true, threadChannelId: th.id, id: msg.id, seq: msg.seq }), true);
  }
  if (p === "/agent-api/thread/read" && method === "GET") {
    const parent = await findParent(url.searchParams.get("parent") ?? "", url.searchParams.get("channel"));
    if (!parent) return (sendErr(res, 404, "parent message not found"), true);
    const th = (await db.select().from(schema.channels).where(and(eq(schema.channels.serverId, serverId), eq(schema.channels.type, "thread"), eq(schema.channels.parentMessageId, parent.id))))[0];
    const tstr = `thread:${parent.id.slice(0, 8)}`;
    if (!th) return (sendJson(res, 200, { parent: { senderName: parent.senderName, content: parent.content }, messages: [] }), true);
    const msgs = await db.select().from(schema.messages).where(eq(schema.messages.channelId, th.id)).orderBy(asc(schema.messages.seq)).limit(100);
    return (sendJson(res, 200, { parent: { senderName: parent.senderName, content: parent.content }, messages: msgs.map((m) => ({ ...serialize(m), text: fmt(m, tstr) })) }), true);
  }
  // Full-text search (agent self-queries context): searches only channels the agent belongs to, ilike substring match
  if (p === "/agent-api/search" && method === "GET") {
    const q = (url.searchParams.get("q") || url.searchParams.get("query") || "").trim();
    if (!q) return (sendErr(res, 400, "q required"), true);
    const joined = (await agentChannels(agent.id)).map((c) => c.channelId);
    if (!joined.length) return (sendJson(res, 200, { results: [] }), true);
    const rows = await db.select().from(schema.messages)
      .where(and(eq(schema.messages.serverId, serverId), inArray(schema.messages.channelId, joined), ilike(schema.messages.content, `%${q}%`)))
      .orderBy(desc(schema.messages.seq)).limit(20);
    return (sendJson(res, 200, { results: rows.map((m) => ({ id: m.id, channelId: m.channelId, senderType: m.senderType, senderName: m.senderName, content: m.content, createdAt: m.createdAt })) }), true);
  }

  // profile show: own profile or @handle lookup
  if (p === "/agent-api/profile/show" && method === "GET") {
    const who = (url.searchParams.get("handle") || "").replace(/^@/, "");
    const a = who
      ? (await db.select().from(schema.agents).where(and(eq(schema.agents.serverId, serverId), eq(schema.agents.name, who))))[0]
      : (await db.select().from(schema.agents).where(eq(schema.agents.id, agent.id)))[0];
    if (a) return (sendJson(res, 200, { type: "agent", name: a.name, displayName: a.displayName, description: a.description, runtime: a.runtime, model: a.model, status: a.status }), true);
    const u = who ? (await db.select().from(schema.users).where(eq(schema.users.name, who)))[0] : null;
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
    const m = (await db.select().from(schema.messages).where(and(eq(schema.messages.serverId, serverId), raw.length >= 32 ? eq(schema.messages.id, raw) : like(sql`${schema.messages.id}::text`, raw.toLowerCase() + "%"))))[0];
    if (!m) return (sendErr(res, 404, "message not found", { code: "RESOLVE_FAILED" }), true);
    // Agent ACL: resolve has its own message lookup (not resolveMessageId), so gate the resolved message's
    // channel here too — otherwise it leaks any message's content by (short) id (C7).
    if (!(await canAgentReadChannel(serverId, m.channelId, agent.id))) return (sendErr(res, 404, "message not found", { code: "RESOLVE_FAILED" }), true);
    const ch = (await db.select().from(schema.channels).where(eq(schema.channels.id, m.channelId)))[0];
    return (sendJson(res, 200, { ...serialize(m), text: fmt(m, ch ? await addressableTarget(ch, agent.id) : m.channelId) }), true);
  }
  // channel members
  if (p === "/agent-api/channel/members" && method === "GET") {
    const tgt = await resolveTarget(serverId, url.searchParams.get("channel") ?? "", agent.id);
    if (!tgt) return (sendErr(res, 404, "channel not found"), true);
    const mems = await channelMembers(tgt.channelId);
    return (sendJson(res, 200, { members: mems.map((m) => ({ type: m.type, name: m.name, displayName: m.displayName })) }), true);
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
    const a = (await db.select().from(schema.attachments).where(and(eq(schema.attachments.id, id), eq(schema.attachments.serverId, serverId))))[0];
    if (!a) return (sendErr(res, 404, "attachment not found"), true);
    // Agent ACL: the agent may view an attachment only if it uploaded it, or it can access the channel the
    // attachment was posted in — otherwise an attachment id leaks a private channel's file. 404 (don't reveal).
    const canView = (a.uploaderType === "agent" && a.uploaderId === agent.id) || (!!a.channelId && await canAgentReadChannel(serverId, a.channelId, agent.id));
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

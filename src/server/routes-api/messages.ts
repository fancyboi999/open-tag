// Auto-extracted from the former routes-api.ts monolith — bodies are verbatim.
import type { ServerCtx } from "./ctx.js";
import { and, asc, desc, eq, gt, ilike, inArray, isNull, lt } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { addReaction, checkSaved, createMessage, listSaved, removeReaction, saveMessage, unsaveMessage } from "../core.js";
import { parseMsgPageParams } from "../messagePage.js";
import { publish } from "../realtime.js";
import { isUuid, readJson, sendErr, sendJson } from "../util.js";
import { attachMentions, userChannels } from "./shared.js";
import { canUserReadChannel } from "../channelAccess.js";

export async function handleMessages(ctx: ServerCtx): Promise<boolean> {
  const { req, res, url, method, p, userId, serverId } = ctx;
  if (p === "/api/mentions" && method === "GET") {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 30), 100);
    const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
    const rows = await db
      .select({
        messageId: schema.messages.id, seq: schema.messages.seq, content: schema.messages.content, createdAt: schema.messages.createdAt,
        senderType: schema.messages.senderType, senderId: schema.messages.senderId, senderName: schema.messages.senderName,
        channelId: schema.channels.id, channelName: schema.channels.name, channelType: schema.channels.type, parentMessageId: schema.channels.parentMessageId,
        lastReadSeq: schema.channelMembers.lastReadSeq,
      })
      .from(schema.messageMentions)
      .innerJoin(schema.messages, eq(schema.messages.id, schema.messageMentions.messageId))
      .innerJoin(schema.channels, eq(schema.channels.id, schema.messages.channelId))
      .innerJoin(schema.channelMembers, and(eq(schema.channelMembers.channelId, schema.channels.id), eq(schema.channelMembers.memberType, "user"), eq(schema.channelMembers.memberId, userId)))
      .where(and(eq(schema.messageMentions.mentionType, "user"), eq(schema.messageMentions.mentionId, userId), eq(schema.channels.serverId, serverId), isNull(schema.channels.deletedAt)))
      .orderBy(desc(schema.messages.seq))
      .limit(limit + 1).offset(offset); // fetch one extra row to detect a next page without a second COUNT (Saved-style hasMore)
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    // Thread mentions: resolve the parent channel so a row can deep-link to the parent channel + open the thread panel.
    const parentMsgIds = [...new Set(page.filter((r) => r.channelType === "thread" && r.parentMessageId).map((r) => r.parentMessageId!))];
    const parentMsgs = parentMsgIds.length ? await db.select().from(schema.messages).where(inArray(schema.messages.id, parentMsgIds)) : [];
    const parentChs = parentMsgs.length ? await db.select().from(schema.channels).where(inArray(schema.channels.id, [...new Set(parentMsgs.map((m) => m.channelId))])) : [];
    const mitems = page.map((r) => {
      let parentChannelId: string | null = null, parentChannelName: string | null = null;
      if (r.channelType === "thread" && r.parentMessageId) {
        const pm = parentMsgs.find((m) => m.id === r.parentMessageId);
        if (pm) { parentChannelId = pm.channelId; parentChannelName = parentChs.find((c) => c.id === pm.channelId)?.name ?? null; }
      }
      // dm channel.name is an internal composite id; a DM mention always comes from the peer, so label it with the sender.
      const channelName = r.channelType === "dm" ? r.senderName : r.channelType === "thread" ? (parentChannelName ?? r.channelName) : r.channelName;
      return {
        messageId: r.messageId, channelId: r.channelId, channelName, channelType: r.channelType,
        parentMessageId: r.channelType === "thread" ? r.parentMessageId : null, parentChannelId, parentChannelName,
        senderType: r.senderType, senderId: r.senderId, senderName: r.senderName,
        preview: (r.content ?? "").slice(0, 140), createdAt: r.createdAt, seq: r.seq,
        read: r.seq <= (r.lastReadSeq ?? 0),
      };
    });
    return (sendJson(res, 200, { items: mitems, hasMore }), true);
  }
  // ── Saved messages / bookmarks (/channels/saved; envelope {saved[], hasMore}) ──
  // List: query {limit=20, offset}; envelope {saved[], hasMore}
  if (p === "/api/channels/saved" && method === "GET") {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 100);
    const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
    return (sendJson(res, 200, await listSaved(serverId, "user", userId, limit, offset)), true);
  }
  // Save: body {messageId}; idempotent (unique index deduplicates).
  if (p === "/api/channels/saved" && method === "POST") {
    const b = await readJson(req).catch(() => ({}));
    const messageId = String(b.messageId ?? "").trim();
    if (!messageId) return (sendErr(res, 400, "messageId required"), true);
    if (!isUuid(messageId)) return (sendErr(res, 404, "message not found"), true); // non-uuid (e.g. the web client's agent-reply:* streaming-preview id) would throw casting into the uuid column → 500
    const m = (await db.select().from(schema.messages).where(and(eq(schema.messages.id, messageId), eq(schema.messages.serverId, serverId))))[0];
    if (!m) return (sendErr(res, 404, "message not found"), true);
    if (!(await canUserReadChannel(serverId, m.channelId, userId))) return (sendErr(res, 404, "message not found"), true); // invariant 3 (IDOR-B5): non-members can't bookmark (and thereby read via GET /saved) a private/DM channel's message (404 hides existence, matches reactions B2 / tasks B4)
    await saveMessage(serverId, messageId, "user", userId);
    return (sendJson(res, 200, { ok: true }), true);
  }
  // Bulk saved check: body {messageIds[]} → {savedIds[]}
  if (p === "/api/channels/saved/check" && method === "POST") {
    const b = await readJson(req).catch(() => ({}));
    const ids = Array.isArray(b.messageIds) ? b.messageIds.map((x: unknown) => String(x)).filter(isUuid) : []; // drop non-uuid ids (can't be saved; would throw in the uuid inArray → 500)
    const savedIds = await checkSaved(serverId, "user", userId, ids);
    return (sendJson(res, 200, { savedIds }), true);
  }
  // Unsave: DELETE /channels/saved/:messageId
  const cunsave = /^\/api\/channels\/saved\/([^/]+)$/.exec(p);
  if (cunsave && method === "DELETE") {
    if (!isUuid(cunsave[1]!)) return (sendErr(res, 404, "message not found"), true);
    await unsaveMessage(serverId, cunsave[1]!, "user", userId);
    return (sendJson(res, 200, { ok: true }), true);
  }
  // Contract stub (returns empty response for unbuilt features): active announcements
  if (p === "/api/messages/search" && method === "GET") {
    const q = (url.searchParams.get("q") ?? "").trim();
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 50);
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
    if (!q) return (sendJson(res, 200, { hasMore: false, results: [] }), true);
    const mems = await db.select().from(schema.channelMembers).where(and(eq(schema.channelMembers.memberType, "user"), eq(schema.channelMembers.memberId, userId)));
    const chIds = mems.map((m) => m.channelId);
    if (!chIds.length) return (sendJson(res, 200, { hasMore: false, results: [] }), true);
    const rows = await db.select().from(schema.messages)
      .where(and(eq(schema.messages.serverId, serverId), inArray(schema.messages.channelId, chIds), ilike(schema.messages.content, `%${q}%`)))
      .orderBy(desc(schema.messages.seq)).limit(limit + 1).offset(offset);
    const hasMore = rows.length > limit;
    const chs = await db.select().from(schema.channels).where(inArray(schema.channels.id, chIds));
    const cname = (cid: string) => chs.find((c) => c.id === cid)?.name ?? "";
    const snip = (s: string) => { const i = s.toLowerCase().indexOf(q.toLowerCase()); return i < 0 ? s.slice(0, 90) : (i > 24 ? "…" : "") + s.slice(Math.max(0, i - 24), i + 66); };
    const results = rows.slice(0, limit).map((m) => ({ id: m.id, seq: m.seq, channelId: m.channelId, channelName: cname(m.channelId), senderType: m.senderType, senderName: m.senderName, content: m.content, snippet: snip(m.content), createdAt: m.createdAt }));
    return (sendJson(res, 200, { hasMore, results }), true);
  }
  const cmsg = /^\/api\/messages\/channel\/([^/]+)$/.exec(p);
  if (cmsg && method === "GET") {
    if (!(await canUserReadChannel(serverId, cmsg[1]!, userId))) return (sendErr(res, 403, "forbidden"), true); // invariant 3: private/DM channels non-members are refused
    const { limit, before } = parseMsgPageParams(url.searchParams); // `before` = keyset cursor on seq → the older page (frontend scroll-to-top "load more")
    const conds = [eq(schema.messages.serverId, serverId), eq(schema.messages.channelId, cmsg[1]!)]; // serverId scope: a foreign channel UUID must not read another tenant's messages (cross-tenant read)
    if (before != null) conds.push(lt(schema.messages.seq, before)); // hits messages_channel_idx (channelId, seq) — keyset, no offset drift
    const rows = await db.select().from(schema.messages).where(and(...conds)).orderBy(desc(schema.messages.seq)).limit(limit + 1); // +1 sentinel row: detect a further page without the exact-page-boundary false positive (mirrors the search/mentions routes)
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return (sendJson(res, 200, { messages: (await attachMentions(page.reverse())), hasMore }), true);
  }
  if (p === "/api/messages" && method === "POST") {
    const b = await readJson(req);
    const hasAtt = Array.isArray(b.attachmentIds) && b.attachmentIds.length > 0;
    if (!b.channelId || (!b.content && !hasAtt)) return (sendErr(res, 400, "channelId + content (or attachmentIds) required"), true);
    if (!(await canUserReadChannel(serverId, b.channelId, userId))) return (sendErr(res, 403, "forbidden"), true); // invariant 3: non-members must not write to private/DM channels
    const u = (await db.select().from(schema.users).where(eq(schema.users.id, userId)))[0];
    const msg = await createMessage({ serverId, channelId: b.channelId, senderType: "user", senderId: userId, senderName: u!.name, content: b.content || "", asTask: !!b.asTask, attachmentIds: hasAtt ? b.attachmentIds : undefined });
    return (sendJson(res, 200, { ok: true, id: msg.id, seq: msg.seq }), true);
  }
  // Emoji reactions: POST to add / DELETE to remove, same path body {emoji}; both broadcast message:updated (full message including reactions[])
  const react = /^\/api\/messages\/([^/]+)\/reactions$/.exec(p);
  if (react && (method === "POST" || method === "DELETE")) {
    const b = await readJson(req).catch(() => ({}));
    const emoji = String(b.emoji ?? "").trim();
    if (!emoji) return (sendErr(res, 400, "emoji required"), true);
    if (!isUuid(react[1]!)) return (sendErr(res, 404, "message not found"), true); // the prod-observed 500: reacting to a not-yet-persisted agent-reply:* preview cast a non-uuid into the uuid column
    const m = (await db.select().from(schema.messages).where(and(eq(schema.messages.id, react[1]!), eq(schema.messages.serverId, serverId))))[0];
    if (!m) return (sendErr(res, 404, "message not found"), true);
    // invariant 3: non-members must not react to messages in private/DM channels (IDOR-B2)
    if (!(await canUserReadChannel(serverId, m.channelId, userId))) return (sendErr(res, 404, "message not found"), true);
    const out = method === "POST" ? await addReaction(serverId, react[1]!, "user", userId, emoji) : await removeReaction(serverId, react[1]!, "user", userId, emoji);
    return (sendJson(res, 200, out), true);
  }
  // Mark action card as executed (POST /actions/:messageId/mark-executed).
  // Actual creation goes through existing POST /api/channels|/api/agents (as user); this endpoint only marks the card as executed and leaves an audit trail; no new privileged execution path.
  const amark = /^\/api\/actions\/([^/]+)\/mark-executed$/.exec(p);
  if (amark && method === "POST") {
    const b = await readJson(req).catch(() => ({}));
    if (!isUuid(amark[1]!)) return (sendErr(res, 404, "action not found"), true);
    const m = (await db.select().from(schema.messages).where(and(eq(schema.messages.id, amark[1]!), eq(schema.messages.serverId, serverId))))[0];
    if (!m) return (sendErr(res, 404, "action not found"), true);
    if (!(await canUserReadChannel(serverId, m.channelId, userId))) return (sendErr(res, 404, "action not found"), true); // invariant 3 (IDOR-B4): non-members of a private/DM channel can't mark its action cards (404 hides existence, matches reactions B2)
    const meta = m.actionMetadata as any;
    if (!meta || meta.kind !== "action-card") return (sendErr(res, 400, "not an action card"), true);
    if (meta.state === "executed") return (sendJson(res, 200, { ok: true, already: true }), true); // idempotent
    const u = (await db.select().from(schema.users).where(eq(schema.users.id, userId)))[0];
    const updated = { ...meta, state: "executed", executedAt: new Date().toISOString(), executedByUserId: userId, executedByUserName: u?.displayName || u?.name || "someone", result: b.result ?? null };
    await db.update(schema.messages).set({ actionMetadata: updated, updatedAt: new Date() }).where(eq(schema.messages.id, m.id));
    const [serialized] = await attachMentions([{ ...m, actionMetadata: updated }]);
    await publish(serverId, { type: "message:updated", message: serialized });
    return (sendJson(res, 200, { ok: true }), true);
  }
  if (p === "/api/messages/sync" && method === "GET") {
    const since = Number(url.searchParams.get("since") ?? 0);
    const { chs, joined } = await userChannels(serverId, userId);
    const chIds = chs.filter((c) => joined.has(c.id)).map((c) => c.id);
    if (!chIds.length) return (sendJson(res, 200, { messages: [], maxSeq: since }), true);
    const msgs = await db.select().from(schema.messages).where(and(eq(schema.messages.serverId, serverId), gt(schema.messages.seq, since), inArray(schema.messages.channelId, chIds))).orderBy(asc(schema.messages.seq)).limit(500);
    const withM = await attachMentions(msgs);
    return (sendJson(res, 200, { messages: withM, maxSeq: msgs.length ? msgs[msgs.length - 1]!.seq : since }), true);
  }
  // Single message by id (serialized like the channel feed). Lets the client open a thread panel whose parent
  // message isn't in the loaded page (the "jump to unread thread" banner). Declared after /search and /sync so
  // the bare-id regex never shadows them. Tenant-scoped + channel-read gated (invariant 3).
  const cone = /^\/api\/messages\/([^/]+)$/.exec(p);
  if (cone && method === "GET") {
    if (!isUuid(cone[1]!)) return (sendErr(res, 404, "message not found"), true);
    const m = (await db.select().from(schema.messages).where(and(eq(schema.messages.id, cone[1]!), eq(schema.messages.serverId, serverId))))[0];
    if (!m) return (sendErr(res, 404, "message not found"), true);
    if (!(await canUserReadChannel(serverId, m.channelId, userId))) return (sendErr(res, 404, "message not found"), true); // non-members of private/DM channels are refused (don't leak existence)
    const [serialized] = await attachMentions([m]);
    return (sendJson(res, 200, { message: serialized }), true);
  }
  return false;
}

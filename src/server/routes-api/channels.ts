// Auto-extracted from the former routes-api.ts monolith — bodies are verbatim.
import type { ServerCtx } from "./ctx.js";
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { requireCap } from "../capabilities.js";
import { getOrCreateDM, getOrCreateThread } from "../core.js";
import { publish } from "../realtime.js";
import { readJson, sendErr, sendJson } from "../util.js";
import { canUserReadChannel } from "../channelAccess.js";
import { userChannels } from "./shared.js";

export async function handleChannels(ctx: ServerCtx): Promise<boolean> {
  const { req, res, url, method, p, userId, serverId } = ctx;
  // ── Threads: a thread is a channel with type=thread (and a parentMessageId); there is no separate /api/threads endpoint ──
  if (p === "/api/channels/threads/followed" && method === "GET") {
    const cms = await db.select().from(schema.channelMembers).where(and(eq(schema.channelMembers.memberType, "user"), eq(schema.channelMembers.memberId, userId)));
    const chIds = cms.map((c) => c.channelId);
    const threads = chIds.length ? await db.select().from(schema.channels).where(and(eq(schema.channels.serverId, serverId), eq(schema.channels.type, "thread"), inArray(schema.channels.id, chIds))) : [];
    const out = [];
    for (const th of threads) {
      const myCm = cms.find((c) => c.channelId === th.id);
      if (myCm?.threadDoneAt) continue; // remove done threads from active inbox (thread stays until explicitly marked done)
      const replies = await db.select({ seq: schema.messages.seq, createdAt: schema.messages.createdAt }).from(schema.messages).where(eq(schema.messages.channelId, th.id)).orderBy(asc(schema.messages.seq));
      const parent = th.parentMessageId ? (await db.select().from(schema.messages).where(eq(schema.messages.id, th.parentMessageId)))[0] : null;
      const pch = parent ? (await db.select().from(schema.channels).where(eq(schema.channels.id, parent.channelId)))[0] : null;
      out.push({ threadChannelId: th.id, parentMessageId: th.parentMessageId, parentChannelId: parent?.channelId ?? null, parentChannelName: pch?.name ?? null, parentPreview: (parent?.content ?? "").slice(0, 80), replyCount: replies.length, unreadCount: replies.filter((r) => r.seq > (myCm?.lastReadSeq ?? 0)).length, lastReplyAt: replies.length ? replies[replies.length - 1]!.createdAt : null });
    }
    return (sendJson(res, 200, { threads: out }), true);
  }
  // Thread follow/unfollow/done/undone. follow = join as member (channelMember); done = per-user mark as complete, removes from inbox.
  if (p === "/api/channels/threads/follow" && method === "POST") {
    const tid = (await readJson(req).catch(() => ({})))?.threadChannelId;
    if (tid) await db.insert(schema.channelMembers).values({ channelId: String(tid), memberType: "user", memberId: userId }).onConflictDoNothing();
    return (sendJson(res, 200, { ok: true }), true);
  }
  if (p === "/api/channels/threads/unfollow" && method === "POST") {
    const tid = (await readJson(req).catch(() => ({})))?.threadChannelId;
    if (tid) await db.delete(schema.channelMembers).where(and(eq(schema.channelMembers.channelId, String(tid)), eq(schema.channelMembers.memberType, "user"), eq(schema.channelMembers.memberId, userId)));
    return (sendJson(res, 200, { ok: true }), true);
  }
  if ((p === "/api/channels/threads/done" || p === "/api/channels/threads/undone") && method === "POST") {
    const tid = (await readJson(req).catch(() => ({})))?.threadChannelId;
    const doneAt = p.endsWith("/done") ? new Date() : null;
    if (tid) await db.update(schema.channelMembers).set({ threadDoneAt: doneAt }).where(and(eq(schema.channelMembers.channelId, String(tid)), eq(schema.channelMembers.memberType, "user"), eq(schema.channelMembers.memberId, userId)));
    return (sendJson(res, 200, { ok: true }), true);
  }
  const cthreads = /^\/api\/channels\/([^/]+)\/threads$/.exec(p);
  if (cthreads && method === "POST") {
    const b = await readJson(req);
    if (!b.parentMessageId) return (sendErr(res, 400, "parentMessageId required"), true);
    const parent = (await db.select().from(schema.messages).where(and(eq(schema.messages.id, b.parentMessageId), eq(schema.messages.serverId, serverId))))[0];
    if (!parent) return (sendErr(res, 404, "parent message not found"), true);
    // Channel visibility gate — non-members must not create threads on private/DM channels (IDOR-B3)
    if (!(await canUserReadChannel(serverId, parent.channelId, userId))) return (sendErr(res, 403, "forbidden"), true);
    const th = await getOrCreateThread(serverId, b.parentMessageId, { type: "user", id: userId });
    const replies = await db.select({ createdAt: schema.messages.createdAt }).from(schema.messages).where(eq(schema.messages.channelId, th.id));
    const parts = await db.select().from(schema.channelMembers).where(eq(schema.channelMembers.channelId, th.id));
    return (sendJson(res, 200, { threadChannelId: th.id, parentMessageId: b.parentMessageId, replyCount: replies.length, lastReplyAt: replies.at(-1)?.createdAt ?? null, participantIds: parts.map((pp) => pp.memberId) }), true);
  }
  if (cthreads && method === "GET") {
    // Channel visibility gate — non-members must not enumerate thread metadata on private/DM channels (IDOR-B3)
    if (!(await canUserReadChannel(serverId, cthreads[1]!, userId))) return (sendErr(res, 403, "forbidden"), true);
    const pids = (url.searchParams.get("parentMessageIds") || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!pids.length) return (sendJson(res, 200, {}), true);
    const threads = await db.select().from(schema.channels).where(and(eq(schema.channels.serverId, serverId), eq(schema.channels.type, "thread"), inArray(schema.channels.parentMessageId, pids)));
    const map: Record<string, any> = {};
    for (const th of threads) {
      const replies = await db.select({ seq: schema.messages.seq, createdAt: schema.messages.createdAt }).from(schema.messages).where(eq(schema.messages.channelId, th.id)).orderBy(asc(schema.messages.seq));
      const myCm = (await db.select().from(schema.channelMembers).where(and(eq(schema.channelMembers.channelId, th.id), eq(schema.channelMembers.memberType, "user"), eq(schema.channelMembers.memberId, userId))))[0];
      map[th.parentMessageId!] = { threadChannelId: th.id, replyCount: replies.length, unreadCount: myCm ? replies.filter((r) => r.seq > (myCm.lastReadSeq ?? 0)).length : 0, lastReplyAt: replies.length ? replies[replies.length - 1]!.createdAt : null };
    }
    return (sendJson(res, 200, map), true);
  }
  // /channels only lists regular/private channels (bare array, no unread); DMs go through /channels/dm; unread counts through /channels/unread
  if (p === "/api/channels" && method === "GET") {
    const { chs, joined } = await userChannels(serverId, userId);
    const archIncl = url.searchParams.get("archived") === "include"; // ?archived=include; archived channels hidden by default
    // Public channels visible to all; private channels visible to members only; archived hidden by default
    const list = chs.filter((c) => !c.deletedAt && (archIncl || !c.archivedAt) && (c.type === "channel" || (c.type === "private" && joined.has(c.id))));
    return (sendJson(res, 200, list.map((c) => ({
      id: c.id, serverId: c.serverId, name: c.name, description: c.description, type: c.type,
      parentMessageId: c.parentMessageId, createdAt: c.createdAt, archivedAt: c.archivedAt, deletedAt: c.deletedAt,
      joined: joined.has(c.id), lastMessageAt: c.lastMessageAt,
    }))), true);
  }
  if (p === "/api/channels/dm" && method === "GET") {
    const myMems = await db.select().from(schema.channelMembers).where(and(eq(schema.channelMembers.memberType, "user"), eq(schema.channelMembers.memberId, userId)));
    const myIds = new Set(myMems.map((m) => m.channelId));
    const dms = (await db.select().from(schema.channels).where(and(eq(schema.channels.serverId, serverId), eq(schema.channels.type, "dm")))).filter((c) => !c.deletedAt && myIds.has(c.id));
    if (!dms.length) return (sendJson(res, 200, []), true);
    const dmMembers = await db.select().from(schema.channelMembers).where(inArray(schema.channelMembers.channelId, dms.map((d) => d.id)));
    const agentsAll = await db.select().from(schema.agents).where(eq(schema.agents.serverId, serverId));
    const usersAll = await db.select().from(schema.users);
    const out = dms.map((c) => {
      const peer = dmMembers.find((m) => m.channelId === c.id && !(m.memberType === "user" && m.memberId === userId));
      const src = peer ? (peer.memberType === "agent" ? agentsAll.find((a) => a.id === peer.memberId) : usersAll.find((u) => u.id === peer.memberId)) : null;
      return {
        id: c.id, name: src?.name ?? c.name, type: "dm", description: c.description, createdAt: c.createdAt, lastMessageAt: c.lastMessageAt,
        peerId: peer?.memberId ?? null, peerName: src?.name ?? null, peerDisplayName: src?.displayName ?? null, peerType: peer?.memberType ?? null, peerAvatarUrl: (src as any)?.avatarUrl ?? null,
      };
    }).filter((o) => o.peerId); // deleted agents leave DM (channelMembers removed) → no peer → exclude from list (do not show DMs with deleted agents, no more "unknown user")
    return (sendJson(res, 200, out), true);
  }
  if (p === "/api/channels/unread" && method === "GET") {
    const myMems = await db.select().from(schema.channelMembers).where(and(eq(schema.channelMembers.memberType, "user"), eq(schema.channelMembers.memberId, userId)));
    const map: Record<string, number> = {};
    for (const m of myMems) {
      const [r] = await db.select({ n: count() }).from(schema.messages).where(and(eq(schema.messages.channelId, m.channelId), gt(schema.messages.seq, m.lastReadSeq), ne(schema.messages.senderId, userId)));
      const n = Number(r?.n ?? 0);
      if (n > 0) map[m.channelId] = n;
    }
    return (sendJson(res, 200, map), true);
  }
  // Unified inbox (GET /api/channels/inbox?filter=all|unread|mentions): aggregates all channels/DMs/threads the user has joined, with last message + unread count + mentions. User-side equivalent of the agent's inbox-notice.
  if (p === "/api/channels/inbox" && method === "GET") {
    const filter = url.searchParams.get("filter") ?? "all";
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 30), 100);
    const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
    const myMems = await db.select().from(schema.channelMembers).where(and(eq(schema.channelMembers.memberType, "user"), eq(schema.channelMembers.memberId, userId)));
    if (!myMems.length) return (sendJson(res, 200, { items: [] }), true);
    const chs = (await db.select().from(schema.channels).where(inArray(schema.channels.id, myMems.map((m) => m.channelId)))).filter((c) => c.serverId === serverId && !c.deletedAt);
    if (!chs.length) return (sendJson(res, 200, { items: [] }), true);
    const allMembers = await db.select().from(schema.channelMembers).where(inArray(schema.channelMembers.channelId, chs.map((c) => c.id)));
    const agentsAll = await db.select().from(schema.agents).where(eq(schema.agents.serverId, serverId));
    const usersAll = await db.select().from(schema.users);
    const items: any[] = [];
    for (const c of chs) {
      const cm = myMems.find((m) => m.channelId === c.id)!;
      const last = (await db.select().from(schema.messages).where(eq(schema.messages.channelId, c.id)).orderBy(desc(schema.messages.seq)).limit(1))[0];
      if (!last) continue; // empty channels are excluded from the inbox
      const [ur] = await db.select({ n: count() }).from(schema.messages).where(and(eq(schema.messages.channelId, c.id), gt(schema.messages.seq, cm.lastReadSeq), ne(schema.messages.senderId, userId)));
      const unreadCount = Number(ur?.n ?? 0);
      let firstUnreadMessageId: string | null = null;
      let hasMention = false;
      if (unreadCount > 0) {
        const unread = await db.select({ id: schema.messages.id }).from(schema.messages).where(and(eq(schema.messages.channelId, c.id), gt(schema.messages.seq, cm.lastReadSeq), ne(schema.messages.senderId, userId))).orderBy(asc(schema.messages.seq));
        firstUnreadMessageId = unread[0]?.id ?? null;
        const [mc] = await db.select({ n: count() }).from(schema.messageMentions).where(and(inArray(schema.messageMentions.messageId, unread.map((u) => u.id)), eq(schema.messageMentions.mentionType, "user"), eq(schema.messageMentions.mentionId, userId)));
        hasMention = Number(mc?.n ?? 0) > 0;
      }
      const kind = c.type === "dm" ? "dm" : c.type === "thread" ? "thread" : "channel";
      let channelName = c.name;
      // Thread entry: populate parent message/channel info so the frontend can navigate to the parent channel and expand the thread panel
      let parentMessageId: string | null = null, parentChannelId: string | null = null, parentChannelName: string | null = null;
      if (c.type === "dm") {
        const peer = allMembers.find((m) => m.channelId === c.id && !(m.memberType === "user" && m.memberId === userId));
        if (!peer) continue; // peer agent was deleted (left DM, no longer in channelMembers) → exclude from inbox
        const src = peer.memberType === "agent" ? agentsAll.find((a) => a.id === peer.memberId) : usersAll.find((u) => u.id === peer.memberId);
        channelName = src?.name ?? c.name;
      } else if (c.type === "thread" && c.parentMessageId) {
        parentMessageId = c.parentMessageId;
        const pm = (await db.select().from(schema.messages).where(eq(schema.messages.id, c.parentMessageId)))[0];
        if (pm) { parentChannelId = pm.channelId; const pch = (await db.select().from(schema.channels).where(eq(schema.channels.id, pm.channelId)))[0]; parentChannelName = pch?.name ?? null; }
      }
      items.push({
        kind, channelId: c.id, channelName, channelType: c.type,
        parentMessageId, parentChannelId, parentChannelName,
        lastMessageId: last.id, firstUnreadMessageId,
        lastMessageAt: last.createdAt, lastMessagePreview: (last.content ?? "").slice(0, 140),
        lastMessageSenderType: last.senderType, lastMessageSenderId: last.senderId, lastMessageSenderName: last.senderName,
        unreadCount, hasMention,
      });
    }
    items.sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime());
    let filtered = items;
    if (filter === "unread") filtered = items.filter((i) => i.unreadCount > 0);
    // The Mentions tab is its own message-grained stream (GET /api/mentions below — every @ of me, read or
    // not), not a channel aggregate. hasMention above still drives the per-row @ badge on the all/unread tabs.
    return (sendJson(res, 200, { items: filtered.slice(offset, offset + limit) }), true);
  }
  // Mentions activity stream (GET /api/mentions?limit=&offset=): every message that @-mentions the current
  // user — message-grained, read AND unread alike. The channel-aggregated inbox above only surfaces an @ that
  // still sits in an unread channel (hasMention is computed inside `if (unreadCount > 0)`), so a mention you've
  // already read vanishes from it. This is the canonical "who pinged me" history (Slack/Tag "Mentions &
  // reactions"), backed by mentions_target_idx (mention_type, mention_id). INNER JOIN channel_members both
  // scopes results to channels the user can still access (never leak a private/thread they were removed from)
  // and yields lastReadSeq for the read flag.
  if (p === "/api/announcements/active" && method === "GET") return (sendJson(res, 200, { announcements: [] }), true);
  const cmem = /^\/api\/channels\/([^/]+)\/members$/.exec(p);
  if (cmem && method === "GET") {
    // serverId scope: channel_members has no serverId column, so confirm the channel belongs to this tenant
    // before enumerating its members — otherwise a foreign channel UUID leaks its roster.
    const own = (await db.select({ id: schema.channels.id }).from(schema.channels).where(and(eq(schema.channels.id, cmem[1]!), eq(schema.channels.serverId, serverId))))[0];
    if (!own) return (sendErr(res, 404, "channel not found"), true);
    // invariant 3: private/DM channel member list must not be accessible to non-members (IDOR-B2)
    if (!(await canUserReadChannel(serverId, cmem[1]!, userId))) return (sendErr(res, 404, "channel not found"), true);
    const rows = await db.select().from(schema.channelMembers).where(eq(schema.channelMembers.channelId, cmem[1]!));
    const aIds = rows.filter((r) => r.memberType === "agent").map((r) => r.memberId);
    const uIds = rows.filter((r) => r.memberType === "user").map((r) => r.memberId);
    const ags = aIds.length ? await db.select().from(schema.agents).where(inArray(schema.agents.id, aIds)) : [];
    const usrs = uIds.length ? await db.select().from(schema.users).where(inArray(schema.users.id, uIds)) : [];
    return (sendJson(res, 200, {
      agents: ags.map((a) => ({ id: a.id, name: a.name, displayName: a.displayName, status: a.status, activity: a.activity, avatarUrl: a.avatarUrl })),
      humans: usrs.map((u) => ({ userId: u.id, name: u.name, displayName: u.displayName, avatarUrl: u.avatarUrl })),
    }), true);
  }
  if (cmem && method === "POST") { // add agent/user to channel (managing channel membership = owner/admin)
    if (!await requireCap(serverId, userId, "manageChannels")) return (sendErr(res, 403, "need manageChannels capability"), true); // members must not add anyone (incl. themselves) to a channel — this is the private-channel invite path
    const own = (await db.select({ id: schema.channels.id }).from(schema.channels).where(and(eq(schema.channels.id, cmem[1]!), eq(schema.channels.serverId, serverId))))[0];
    if (!own) return (sendErr(res, 404, "channel not found"), true); // and only this tenant's channels
    const b = await readJson(req);
    const mt = b.userId ? "user" : "agent"; const mid = b.userId || b.agentId;
    if (!mid) return (sendErr(res, 400, "agentId or userId required"), true);
    await db.insert(schema.channelMembers).values({ channelId: cmem[1]!, memberType: mt, memberId: mid }).onConflictDoNothing();
    await publish(serverId, { type: "channel:members-updated", channelId: cmem[1]! }); // realtime: membership change → all clients refresh member/channel list and new member joins the room (G-E)
    return (sendJson(res, 200, { ok: true }), true);
  }
  if (cmem && method === "DELETE") { // remove from channel (owner/admin only)
    if (!await requireCap(serverId, userId, "manageChannels")) return (sendErr(res, 403, "need manageChannels capability"), true);
    const own = (await db.select({ id: schema.channels.id }).from(schema.channels).where(and(eq(schema.channels.id, cmem[1]!), eq(schema.channels.serverId, serverId))))[0];
    if (!own) return (sendErr(res, 404, "channel not found"), true);
    const b = await readJson(req).catch(() => ({}));
    const mt = b.userId ? "user" : "agent"; const mid = b.userId || b.agentId;
    if (mid) await db.delete(schema.channelMembers).where(and(eq(schema.channelMembers.channelId, cmem[1]!), eq(schema.channelMembers.memberType, mt), eq(schema.channelMembers.memberId, mid)));
    await publish(serverId, { type: "channel:members-updated", channelId: cmem[1]! });
    return (sendJson(res, 200, { ok: true }), true);
  }
  // Attachment upload (multipart, fields: files + channelId) → save to disk + insert attachment row (messageId is backfilled when the message is sent)
  const cfiles = /^\/api\/channels\/([^/]+)\/files$/.exec(p);
  if (cfiles && method === "GET") {
    // invariant 3: private/DM channel file list must not be accessible to non-members (IDOR-B2)
    if (!(await canUserReadChannel(serverId, cfiles[1]!, userId))) return (sendErr(res, 404, "channel not found"), true);
    const rows = await db.select().from(schema.attachments).where(and(eq(schema.attachments.channelId, cfiles[1]!), eq(schema.attachments.serverId, serverId), isNotNull(schema.attachments.messageId))).orderBy(desc(schema.attachments.createdAt)).limit(100); // serverId scope: don't list another tenant's channel files by raw channel UUID
    const aIds = rows.filter((r) => r.uploaderType === "agent" && r.uploaderId).map((r) => r.uploaderId!) as string[];
    const uIds = rows.filter((r) => r.uploaderType === "user" && r.uploaderId).map((r) => r.uploaderId!) as string[];
    const ags = aIds.length ? await db.select().from(schema.agents).where(inArray(schema.agents.id, aIds)) : [];
    const usrs = uIds.length ? await db.select().from(schema.users).where(inArray(schema.users.id, uIds)) : [];
    const who = (t: string | null, id: string | null) => (t === "agent" ? ags.find((a) => a.id === id) : usrs.find((u) => u.id === id));
    return (sendJson(res, 200, {
      files: rows.map((a) => {
        const src: any = who(a.uploaderType, a.uploaderId);
        return { id: a.id, messageId: a.messageId, channelId: a.channelId, filename: a.filename, mimeType: a.mimeType, sizeBytes: a.sizeBytes, width: null, height: null, thumbnailUrl: null, createdAt: a.createdAt, uploader: { type: a.uploaderType, id: a.uploaderId, name: src?.name ?? null, displayName: src?.displayName ?? null }, source: { type: "channel", channelId: a.channelId, parentMessageId: null } };
      }), nextCursor: null,
    }), true);
  }
  if (p === "/api/channels" && method === "POST") {
    if (!await requireCap(serverId, userId, "manageChannels")) return (sendErr(res, 403, "need manageChannels capability"), true);
    const b = await readJson(req);
    const name = String(b.name ?? "").trim().replace(/^#/, "").toLowerCase().replace(/\s+/g, "-");
    if (!name) return (sendErr(res, 400, "name required"), true);
    const dup = (await db.select().from(schema.channels).where(and(eq(schema.channels.serverId, serverId), eq(schema.channels.name, name))))[0];
    if (dup && !dup.deletedAt) return (sendErr(res, 409, "channel name exists"), true);
    // Frontend sends visibility public/private → backend stores as type channel/private (backward-compatible with legacy type field)
    const type = (b.visibility === "private" || b.type === "private") ? "private" : "channel";
    const [ch] = await db.insert(schema.channels).values({ serverId, name, description: b.description ?? null, type }).returning();
    // Initial members: creator + body.agentIds/userIds (validated against the same server before inserting into channel_members)
    const rows: { channelId: string; memberType: string; memberId: string }[] = [{ channelId: ch!.id, memberType: "user", memberId: userId }];
    const agentIds = Array.isArray(b.agentIds) ? b.agentIds.filter(Boolean) : [];
    const userIds = Array.isArray(b.userIds) ? b.userIds.filter(Boolean) : [];
    if (agentIds.length) {
      const valid = await db.select().from(schema.agents).where(and(eq(schema.agents.serverId, serverId), inArray(schema.agents.id, agentIds), isNull(schema.agents.deletedAt)));
      for (const a of valid) rows.push({ channelId: ch!.id, memberType: "agent", memberId: a.id });
    }
    if (userIds.length) {
      const valid = await db.select().from(schema.serverMembers).where(and(eq(schema.serverMembers.serverId, serverId), inArray(schema.serverMembers.userId, userIds)));
      for (const m of valid) if (m.userId !== userId) rows.push({ channelId: ch!.id, memberType: "user", memberId: m.userId });
    }
    await db.insert(schema.channelMembers).values(rows).onConflictDoNothing();
    return (sendJson(res, 200, { id: ch!.id, name: ch!.name, type: ch!.type }), true);
  }
  if (p === "/api/channels/dm" && method === "POST") {
    const b = await readJson(req);
    // body is { agentId } or { userId }
    const peerType = b.userId ? "user" : "agent";
    const peerId = b.userId || b.agentId;
    if (!peerId) return (sendErr(res, 400, "Either agentId or userId is required"), true);
    const ok = peerType === "agent"
      ? (await db.select().from(schema.agents).where(and(eq(schema.agents.id, peerId), eq(schema.agents.serverId, serverId))))[0]
      : (await db.select().from(schema.serverMembers).where(and(eq(schema.serverMembers.userId, peerId), eq(schema.serverMembers.serverId, serverId))))[0];
    if (!ok) return (sendErr(res, 404, "peer not found in server"), true);
    const channelId = await getOrCreateDM(serverId, userId, "user", peerId, peerType);
    await publish(serverId, { type: "dm:new", channelId, participantUserIds: peerType === "user" ? [userId, peerId] : [userId] }); // realtime: new DM → peer refreshes DM list and joins room (G-E)
    return (sendJson(res, 200, { id: channelId }), true);
  }
  // Channel lifecycle: archive/unarchive/rename+description+visibility/delete. All gated by manageChannels.
  const cops = /^\/api\/channels\/([^/]+)\/(archive|unarchive)$/.exec(p);
  if (cops && method === "POST") {
    if (!await requireCap(serverId, userId, "manageChannels")) return (sendErr(res, 403, "need manageChannels capability"), true);
    // Thread channels follow their parent message's lifecycle; direct archive/unarchive is not allowed.
    const archTarget = (await db.select({ type: schema.channels.type }).from(schema.channels)
      .where(and(eq(schema.channels.id, cops[1]!), eq(schema.channels.serverId, serverId))))[0];
    if (archTarget?.type === "thread") return (sendErr(res, 403, "thread channels cannot be archived directly"), true);
    await db.update(schema.channels).set({ archivedAt: cops[2] === "archive" ? new Date() : null }).where(and(eq(schema.channels.id, cops[1]!), eq(schema.channels.serverId, serverId)));
    await publish(serverId, { type: "channel:updated", channelId: cops[1]! });
    return (sendJson(res, 200, { ok: true }), true);
  }
  const cone = /^\/api\/channels\/([^/]+)$/.exec(p);
  if (cone && (method === "PATCH" || method === "DELETE")) {
    if (!await requireCap(serverId, userId, "manageChannels")) return (sendErr(res, 403, "need manageChannels capability"), true);
    // Fetch the channel first: thread channels must not be modified via this endpoint — their
    // lifecycle is managed by their parent message (getOrCreateThread / thread follow API).
    const targetCh = (await db.select({ type: schema.channels.type }).from(schema.channels)
      .where(and(eq(schema.channels.id, cone[1]!), eq(schema.channels.serverId, serverId))))[0];
    if (targetCh?.type === "thread") return (sendErr(res, 403, "thread channels cannot be modified directly"), true);
    if (method === "DELETE") {
      await db.update(schema.channels).set({ deletedAt: new Date() }).where(and(eq(schema.channels.id, cone[1]!), eq(schema.channels.serverId, serverId))); // soft delete
      await publish(serverId, { type: "channel:deleted", channelId: cone[1]! });
      return (sendJson(res, 200, { ok: true }), true);
    }
    const b = await readJson(req).catch(() => ({})); const patch: Record<string, unknown> = {};
    if (b.name) patch.name = String(b.name).trim().replace(/^#/, "").toLowerCase().replace(/\s+/g, "-");
    if (b.description !== undefined) patch.description = b.description;
    if (b.visibility) patch.type = b.visibility === "private" ? "private" : "channel";
    if (Object.keys(patch).length) await db.update(schema.channels).set(patch).where(and(eq(schema.channels.id, cone[1]!), eq(schema.channels.serverId, serverId)));
    await publish(serverId, { type: "channel:updated", channelId: cone[1]! });
    return (sendJson(res, 200, { ok: true }), true);
  }
  const cjoin = /^\/api\/channels\/([^/]+)\/(join|leave|read)$/.exec(p);
  if (cjoin && method === "POST") {
    const [, chId, action] = cjoin;
    const ch = (await db.select().from(schema.channels).where(and(eq(schema.channels.id, chId!), eq(schema.channels.serverId, serverId))))[0];
    if (!ch) return (sendErr(res, 404, "channel not found"), true);
    if (action === "join") {
      if (ch.type === "private") return (sendErr(res, 403, "private channel is invite-only"), true); // private channels require owner/admin invitation (cmem POST); self-join is not allowed
      if (ch.type === "thread") return (sendErr(res, 403, "thread channels cannot be joined directly — use the thread follow API"), true);
      await db.insert(schema.channelMembers).values({ channelId: chId!, memberType: "user", memberId: userId }).onConflictDoNothing();
    } else if (action === "leave") {
      if (ch.type === "thread") return (sendErr(res, 403, "thread channels cannot be left directly — use the thread unfollow API"), true);
      await db.delete(schema.channelMembers).where(and(eq(schema.channelMembers.channelId, chId!), eq(schema.channelMembers.memberType, "user"), eq(schema.channelMembers.memberId, userId)));
    } else { // read: advance cursor to the latest seq
      const b = await readJson(req).catch(() => ({}));
      let seq = Number(b?.seq ?? 0);
      if (!seq) { const [m] = await db.select({ s: schema.messages.seq }).from(schema.messages).where(eq(schema.messages.channelId, chId!)).orderBy(desc(schema.messages.seq)).limit(1); seq = Number(m?.s ?? 0); }
      await db.update(schema.channelMembers).set({ lastReadSeq: seq }).where(and(eq(schema.channelMembers.channelId, chId!), eq(schema.channelMembers.memberType, "user"), eq(schema.channelMembers.memberId, userId)));
    }
    return (sendJson(res, 200, { ok: true }), true);
  }
  // Single member profile (GET /servers/:sid/members/:uid/profile): profile + role + agents created by that member. Requester is already validated as a server member by middleware.
  return false;
}

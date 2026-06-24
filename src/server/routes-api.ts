// User-facing REST: /api/*  (Bearer JWT + x-server-id)
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq, gt, ne, or, inArray, asc, desc, count, isNotNull, isNull, ilike } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { sendJson, sendErr, readJson, bearer, serverIdHeader } from "./util.js";
import { verifyUser, signUser, hashPassword, verifyPassword, newKey, hashToken } from "./auth.js";
import { createMessage, getOrCreateDM, getOrCreateThread, convertMessageToTask, claimTask, unclaimTask, setTaskStatus, deleteTask, TASK_STATUSES, startAgent, stopAgent, resetAgent, syncAgentProfile, addReaction, removeReaction, aggregateReactions, saveMessage, unsaveMessage, checkSaved, listSaved, descTooLong, DESC_TOO_LONG, invalidAgentName, INVALID_AGENT_NAME, createServer } from "./core.js";
import { publish } from "./realtime.js";
import { requestDaemon } from "./daemonHub.js";
import { parseUpload } from "./attachments.js";
import { readObject } from "./storage.js";
import { SCOPES, ALL_SCOPE_KEYS, isScopeLiteral, effectiveScopes } from "./scopes.js";
import { can, requireCap, capabilitiesFor } from "./capabilities.js";

async function attachMentions(msgs: (typeof schema.messages.$inferSelect)[]) {
  if (!msgs.length) return msgs.map((m) => ({ ...m, mentions: [] as any[], attachments: [] as any[], reactions: [] as any[] }));
  const ids = msgs.map((m) => m.id);
  const mts = await db.select().from(schema.messageMentions).where(inArray(schema.messageMentions.messageId, ids));
  const atts = await db.select().from(schema.attachments).where(inArray(schema.attachments.messageId, ids));
  const reactions = await aggregateReactions(ids);
  return msgs.map((m) => ({
    ...m,
    mentions: mts.filter((x) => x.messageId === m.id).map((x) => ({ type: x.mentionType, id: x.mentionId, name: x.mentionName })),
    attachments: atts.filter((a) => a.messageId === m.id).map((a) => ({ id: a.id, filename: a.filename, mimeType: a.mimeType, sizeBytes: a.sizeBytes })),
    reactions: reactions.get(m.id) ?? [],
  }));
}
async function userChannels(serverId: string, userId: string) {
  const cms = await db.select().from(schema.channelMembers).where(and(eq(schema.channelMembers.memberType, "user"), eq(schema.channelMembers.memberId, userId)));
  const chs = await db.select().from(schema.channels).where(eq(schema.channels.serverId, serverId));
  const joined = new Set(cms.map((c) => c.channelId));
  return { chs, joined };
}

export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean> {
  const p = url.pathname;
  if (!p.startsWith("/api/")) return false;

  // ---- auth ----
  if (p === "/api/auth/dev-login" && method === "POST") {
    const { name = "you" } = await readJson(req);
    let u = (await db.select().from(schema.users).where(eq(schema.users.name, name)))[0];
    if (!u) [u] = await db.insert(schema.users).values({ name, displayName: name, email: `${name}@dev.local` }).returning();
    // Multi-tenant: each user has isolated data — ensure the user has their own server (creates an empty one if absent, zero channels/agents; "you" owns the seeded default workspace)
    const mine = (await db.select().from(schema.servers).where(eq(schema.servers.ownerId, u!.id)))[0];
    if (!mine) await createServer(`${name}'s workspace`, `u-${u!.id.slice(0, 8)}`, u!.id);
    if (!u) return (sendErr(res, 500, "dev-login failed"), true);
    return (sendJson(res, 200, { token: signUser(u!.id), user: { id: u!.id, name: u!.name, displayName: u!.displayName } }), true);
  }
  if (p === "/api/auth/register" && method === "POST") {
    const b = await readJson(req);
    if (!b.name || !b.email || !b.password) return (sendErr(res, 400, "name/email/password required"), true);
    const dup = (await db.select().from(schema.users).where(or(eq(schema.users.email, b.email), eq(schema.users.name, b.name))))[0];
    if (dup) return (sendErr(res, 409, dup.email === b.email ? "email already registered" : "username already taken"), true);
    const [u] = await db.insert(schema.users).values({ name: b.name, displayName: b.displayName ?? b.name, email: b.email, passwordHash: hashPassword(b.password) }).returning();
    await createServer(`${b.name}'s workspace`, `u-${u!.id.slice(0, 8)}`, u!.id); // Create personal workspace on registration (aligned with dev-login; without it, entering the app with no server causes bootstrap to crash)
    return (sendJson(res, 200, { token: signUser(u!.id), user: { id: u!.id, name: u!.name } }), true);
  }
  if (p === "/api/auth/login" && method === "POST") {
    const b = await readJson(req);
    const u = (await db.select().from(schema.users).where(eq(schema.users.email, b.email ?? "")))[0];
    if (!u || !verifyPassword(b.password ?? "", u.passwordHash)) return (sendErr(res, 401, "bad credentials"), true);
    return (sendJson(res, 200, { token: signUser(u.id), user: { id: u.id, name: u.name } }), true);
  }
  // Invite info (public, no auth required): the /join/:token landing page uses this to display "X invited you to join workspace Y"
  if (p === "/api/auth/invite-info" && method === "GET") {
    const token = url.searchParams.get("token") ?? "";
    const link = token ? (await db.select().from(schema.joinLinks).where(eq(schema.joinLinks.token, token)))[0] : undefined;
    if (!link) return (sendJson(res, 200, { valid: false }), true);
    const expired = !!link.expiresAt && new Date(link.expiresAt as any).getTime() < Date.now();
    const exhausted = link.maxUses != null && link.useCount >= link.maxUses;
    const srv = (await db.select().from(schema.servers).where(eq(schema.servers.id, link.serverId)))[0];
    const inviter = link.createdByUserId ? (await db.select().from(schema.users).where(eq(schema.users.id, link.createdByUserId)))[0] : null;
    return (sendJson(res, 200, { valid: !expired && !exhausted && !!srv, serverName: srv?.name, serverSlug: srv?.slug, inviterName: inviter?.displayName || inviter?.name || null, role: link.role }), true);
  }

  // Attachment download/preview: browsers cannot set headers for anchor/img tags, so the token is passed as a query param (same approach as SSE). Placed before the auth check.
  const adl = /^\/api\/attachments\/([^/]+?)(\/preview)?$/.exec(p);
  if (adl && adl[1] !== "upload" && method === "GET") {
    const uid = verifyUser(url.searchParams.get("token") ?? bearer(req));
    if (!uid) return (sendErr(res, 401, "unauthorized"), true);
    const a = (await db.select().from(schema.attachments).where(eq(schema.attachments.id, adl[1]!)))[0];
    if (!a) return (sendErr(res, 404, "attachment not found"), true);
    let data: Buffer;
    try { data = await readObject(a.storageKey); } catch { return (sendErr(res, 404, "file missing"), true); }
    if (adl[2]) { // /preview: text preview
      if (data.includes(0) || (a.sizeBytes ?? 0) > 256 * 1024) return (sendJson(res, 200, { kind: "binary" }), true);
      return (sendJson(res, 200, { kind: "text", text: data.toString("utf8") }), true);
    }
    res.writeHead(200, { "content-type": a.mimeType || "application/octet-stream", "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(a.filename)}` });
    res.end(data); return true;
  }

  // ---- The following routes require authentication ----
  const userId = verifyUser(bearer(req));
  if (!userId) return (sendErr(res, 401, "unauthorized"), true);

  // Accept invite (requires auth): join a workspace via a join-link token. Idempotent.
  if (p === "/api/auth/accept-invite" && method === "POST") {
    const b = await readJson(req);
    const link = b.token ? (await db.select().from(schema.joinLinks).where(eq(schema.joinLinks.token, String(b.token))))[0] : undefined;
    if (!link) return (sendErr(res, 404, "invalid invite"), true);
    if (link.expiresAt && new Date(link.expiresAt as any).getTime() < Date.now()) return (sendErr(res, 410, "invite expired"), true);
    if (link.maxUses != null && link.useCount >= link.maxUses) return (sendErr(res, 410, "invite exhausted"), true);
    const srv = (await db.select().from(schema.servers).where(eq(schema.servers.id, link.serverId)))[0];
    if (!srv) return (sendErr(res, 404, "server gone"), true);
    const existing = (await db.select().from(schema.serverMembers).where(and(eq(schema.serverMembers.serverId, link.serverId), eq(schema.serverMembers.userId, userId))))[0];
    if (!existing) {
      await db.insert(schema.serverMembers).values({ serverId: link.serverId, userId, role: link.role });
      await db.update(schema.joinLinks).set({ useCount: link.useCount + 1 }).where(eq(schema.joinLinks.id, link.id));
      const all = (await db.select().from(schema.channels).where(and(eq(schema.channels.serverId, link.serverId), eq(schema.channels.name, "all"))))[0];
      if (all) await db.insert(schema.channelMembers).values({ channelId: all.id, memberType: "user", memberId: userId }).onConflictDoNothing();
    }
    return (sendJson(res, 200, { serverSlug: srv.slug, serverId: srv.id, already: !!existing }), true);
  }

  if (p === "/api/auth/me" && method === "GET") {
    const u = (await db.select().from(schema.users).where(eq(schema.users.id, userId)))[0];
    return (u ? sendJson(res, 200, { id: u.id, name: u.name, displayName: u.displayName, email: u.email, description: u.description, avatarUrl: u.avatarUrl }) : sendErr(res, 404, "not found"), true);
  }
  if (p === "/api/auth/me" && method === "PATCH") {
    const b = await readJson(req); const patch: Record<string, unknown> = {};
    if (descTooLong(b.description)) return (sendErr(res, 400, DESC_TOO_LONG), true);
    for (const k of ["displayName", "description", "avatarUrl"]) if (b[k] !== undefined) patch[k] = b[k];
    if (Object.keys(patch).length) await db.update(schema.users).set(patch).where(eq(schema.users.id, userId));
    const u = (await db.select().from(schema.users).where(eq(schema.users.id, userId)))[0];
    return (sendJson(res, 200, { id: u!.id, name: u!.name, displayName: u!.displayName, email: u!.email, description: u!.description }), true);
  }
  if (p === "/api/servers" && method === "GET") {
    const mems = await db.select().from(schema.serverMembers).where(eq(schema.serverMembers.userId, userId));
    const ids = mems.map((m) => m.serverId);
    const servers = ids.length ? await db.select().from(schema.servers).where(inArray(schema.servers.id, ids)) : [];
    return (sendJson(res, 200, servers.map((s) => { const role = mems.find((m) => m.serverId === s.id)?.role; return { id: s.id, name: s.name, slug: s.slug, avatarUrl: s.avatarUrl, role, capabilities: capabilitiesFor(role) }; })), true);
  }
  // Create workspace (community). No x-server-id needed: the server does not exist yet; creator becomes owner.
  if (p === "/api/servers" && method === "POST") {
    const b = await readJson(req);
    const name = String(b.name ?? "").trim();
    if (!name) return (sendErr(res, 400, "name required"), true);
    const base = String(b.slug ?? name).trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "community";
    let slug = base; // slug must be unique: append -N suffix on collision
    for (let n = 2; (await db.select().from(schema.servers).where(eq(schema.servers.slug, slug)))[0]; n++) slug = `${base}-${n}`;
    const srv = await createServer(name, slug, userId);
    return (sendJson(res, 200, { id: srv.id, name: srv.name, slug: srv.slug }), true);
  }
  // Cross-server unread aggregation: server switcher badge. No x-server-id; placed before the :id regex to avoid being consumed by it.
  if (p === "/api/servers/unread-summary" && method === "GET") {
    const mems = await db.select().from(schema.serverMembers).where(eq(schema.serverMembers.userId, userId));
    const myCms = await db.select().from(schema.channelMembers).where(and(eq(schema.channelMembers.memberType, "user"), eq(schema.channelMembers.memberId, userId)));
    const perServer: Record<string, number> = {};
    if (myCms.length) {
      const chs = await db.select({ id: schema.channels.id, serverId: schema.channels.serverId, deletedAt: schema.channels.deletedAt }).from(schema.channels).where(inArray(schema.channels.id, myCms.map((c) => c.channelId)));
      const chServer = new Map(chs.filter((c) => !c.deletedAt).map((c) => [c.id, c.serverId]));
      for (const cm of myCms) {
        const sid = chServer.get(cm.channelId); if (!sid) continue;
        const [r] = await db.select({ n: count() }).from(schema.messages).where(and(eq(schema.messages.channelId, cm.channelId), gt(schema.messages.seq, cm.lastReadSeq), ne(schema.messages.senderId, userId)));
        perServer[sid] = (perServer[sid] ?? 0) + Number(r?.n ?? 0);
      }
    }
    return (sendJson(res, 200, mems.map((m) => ({ serverId: m.serverId, unreadCount: perServer[m.serverId] ?? 0 }))), true);
  }
  const srv = /^\/api\/servers\/([^/]+)$/.exec(p);
  if (srv && (method === "GET" || method === "PATCH")) {
    const mem = (await db.select().from(schema.serverMembers).where(and(eq(schema.serverMembers.serverId, srv[1]!), eq(schema.serverMembers.userId, userId))))[0];
    if (!mem) return (sendErr(res, 403, "not a member"), true);
    if (method === "PATCH") {
      if (!can(mem.role, "manageServer")) return (sendErr(res, 403, "need manageServer capability"), true);
      const b = await readJson(req); const patch: Record<string, unknown> = {};
      if (b.name !== undefined) patch.name = b.name;
      if (b.slug !== undefined) patch.slug = String(b.slug).trim().toLowerCase().replace(/\s+/g, "-");
      if (Object.keys(patch).length) await db.update(schema.servers).set(patch).where(eq(schema.servers.id, srv[1]!));
    }
    const s = (await db.select().from(schema.servers).where(eq(schema.servers.id, srv[1]!)))[0];
    return (s ? sendJson(res, 200, { id: s.id, name: s.name, slug: s.slug, plan: s.plan, role: mem.role, createdAt: s.createdAt }) : sendErr(res, 404, "not found"), true);
  }

  // ---- Routes that require server context ----
  const serverId = serverIdHeader(req);
  if (!serverId) return (sendErr(res, 400, "x-server-id header required"), true);
  const member = (await db.select().from(schema.serverMembers).where(and(eq(schema.serverMembers.serverId, serverId), eq(schema.serverMembers.userId, userId))))[0];
  if (!member) return (sendErr(res, 403, "not a member of this server"), true);

  if (p === "/api/agents" && method === "GET") {
    const machineId = url.searchParams.get("machineId"); // computer page filters by machine
    let agents = await db.select().from(schema.agents).where(and(eq(schema.agents.serverId, serverId), isNull(schema.agents.deletedAt)));
    if (machineId) agents = agents.filter((a) => a.machineId === machineId);
    return (sendJson(res, 200, agents.map((a) => ({ id: a.id, name: a.name, displayName: a.displayName, description: a.description, status: a.status, activity: a.activity, model: a.model, runtime: a.runtime, machineId: a.machineId }))), true);
  }
  if (p === "/api/agents" && method === "POST") {
    if (!await requireCap(serverId, userId, "manageAgents")) return (sendErr(res, 403, "need manageAgents capability"), true);
    const b = await readJson(req);
    if (!b.name) return (sendErr(res, 400, "name required"), true);
    if (invalidAgentName(b.name)) return (sendErr(res, 400, INVALID_AGENT_NAME), true);
    if (descTooLong(b.description)) return (sendErr(res, 400, DESC_TOO_LONG), true);
    const [agent] = await db.insert(schema.agents).values({
      serverId, name: b.name, displayName: b.displayName || b.name, description: b.description ?? null,
      model: b.model || "sonnet", runtime: b.runtime || "claude", machineId: b.machineId ?? null,
      runtimeConfig: { provider: b.provider ?? "default", model: b.model ?? null, reasoningEffort: b.reasoning ?? null, mode: b.fastMode ? "fast" : "default" },
      envVars: b.envVars ?? {}, executionMode: b.fastMode ? "fast" : "auto", creatorType: "user", creatorId: userId,
    }).returning();
    const all = (await db.select().from(schema.channels).where(and(eq(schema.channels.serverId, serverId), eq(schema.channels.name, "all"))))[0];
    if (all) await db.insert(schema.channelMembers).values({ channelId: all.id, memberType: "agent", memberId: agent!.id }).onConflictDoNothing();
    await publish(serverId, { type: "agent:created", agent: { id: agent!.id, name: agent!.name, displayName: agent!.displayName, description: agent!.description, status: agent!.status, activity: agent!.activity, model: agent!.model, runtime: agent!.runtime, machineId: agent!.machineId } });
    // Start immediately on create: the client only POSTs /agents (no separate start call); the "start after create" logic lives in the backend. If no daemon is online startAgent returns ok:false and does not block creation. A successful startAgent calls publishAgentState to push status to active.
    const started = await startAgent(serverId, agent!.id);
    return (sendJson(res, 200, { id: agent!.id, name: agent!.name, started: started.ok }), true);
  }
  const am = /^\/api\/agents\/([^/]+)$/.exec(p);
  if (am && method === "GET") {
    const a = (await db.select().from(schema.agents).where(and(eq(schema.agents.id, am[1]!), eq(schema.agents.serverId, serverId))))[0];
    return (a ? sendJson(res, 200, a) : sendErr(res, 404, "agent not found"), true);
  }
  if (am && method === "PATCH") {
    if (!await requireCap(serverId, userId, "manageAgents")) return (sendErr(res, 403, "need manageAgents capability"), true);
    const b = await readJson(req); const patch: Record<string, unknown> = {};
    if (descTooLong(b.description)) return (sendErr(res, 400, DESC_TOO_LONG), true);
    for (const k of ["displayName", "description", "model", "runtime", "avatarUrl"]) if (b[k] !== undefined) patch[k] = b[k];
    if (b.envVars !== undefined) patch.envVars = b.envVars;
    await db.update(schema.agents).set(patch).where(and(eq(schema.agents.id, am[1]!), eq(schema.agents.serverId, serverId)));
    // Title/role changed → push the current profile to the daemon so it syncs the workspace MEMORY.md.
    if (patch.displayName !== undefined || patch.description !== undefined) {
      const a = (await db.select().from(schema.agents).where(and(eq(schema.agents.id, am[1]!), eq(schema.agents.serverId, serverId))))[0];
      if (a) syncAgentProfile(serverId, am[1]!, a.displayName, a.description);
    }
    return (sendJson(res, 200, { ok: true }), true);
  }
  if (am && method === "DELETE") {
    if (!await requireCap(serverId, userId, "manageAgents")) return (sendErr(res, 403, "need manageAgents capability"), true);
    await stopAgent(serverId, am[1]!).catch(() => {}); // stop the local process before deleting
    await db.delete(schema.channelMembers).where(and(eq(schema.channelMembers.memberType, "agent"), eq(schema.channelMembers.memberId, am[1]!)));
    await db.update(schema.agents).set({ deletedAt: new Date(), status: "inactive", activity: "offline" }).where(and(eq(schema.agents.id, am[1]!), eq(schema.agents.serverId, serverId))); // soft delete: row is kept so historical messages/DM names remain resolvable by id, no orphans
    await publish(serverId, { type: "agent:deleted", id: am[1]! });
    return (sendJson(res, 200, { ok: true }), true);
  }
  // Agent lifecycle: start / stop / reset
  const alc = /^\/api\/agents\/([^/]+)\/(start|stop|reset|restart)$/.exec(p);
  if (alc && method === "POST") {
    if (!await requireCap(serverId, userId, "manageAgents")) return (sendErr(res, 403, "need manageAgents capability"), true);
    const [, agId, action] = alc;
    if (action === "start") { const r = await startAgent(serverId, agId!); return (r.ok ? sendJson(res, 200, { ok: true }) : sendErr(res, 503, r.reason ?? "cannot start")), true; }
    if (action === "stop") { await stopAgent(serverId, agId!); return (sendJson(res, 200, { ok: true }), true); }
    if (action === "restart") { await stopAgent(serverId, agId!); const r = await startAgent(serverId, agId!); return (r.ok ? sendJson(res, 200, { ok: true }) : sendErr(res, 503, r.reason ?? "cannot start")), true; } // preserves session and workspace; restarts only the process
    const b = await readJson(req).catch(() => ({})); await resetAgent(serverId, agId!, !!b?.wipeWorkspace, !!b?.clearMemory);
    if (b?.restart) await startAgent(serverId, agId!); // reset & restart: restart after clearing; all three reset tiers support "& Restart"
    return (sendJson(res, 200, { ok: true }), true);
  }
  // Agent workspace file browser (reads local disk via daemon WS-RPC)
  const awsList = /^\/api\/agents\/([^/]+)\/workspace-files$/.exec(p);
  const awsFile = /^\/api\/agents\/([^/]+)\/workspace-files\/read$/.exec(p);
  if ((awsList || awsFile) && method === "GET") {
    const agId = (awsList || awsFile)![1]!;
    const a = (await db.select().from(schema.agents).where(and(eq(schema.agents.id, agId), eq(schema.agents.serverId, serverId))))[0];
    if (!a) return (sendErr(res, 404, "agent not found"), true);
    if (awsList) {
      const r = await requestDaemon(serverId, { type: "agent:workspace:list", agentId: agId });
      return (sendJson(res, 200, r.error ? { error: r.error } : { files: r.files ?? [] }), true);
    }
    const r = await requestDaemon(serverId, { type: "agent:workspace:read", agentId: agId, path: url.searchParams.get("path") ?? "" });
    return (sendJson(res, 200, r.error ? { error: r.error } : { path: r.path, content: r.content }), true);
  }
  // Agent activity log: chronological [{timestamp, entry}]
  const alog = /^\/api\/agents\/([^/]+)\/activity-log$/.exec(p);
  if (alog && method === "GET") {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
    const rows = await db.select().from(schema.agentActivityLog).where(eq(schema.agentActivityLog.agentId, alog[1]!)).orderBy(desc(schema.agentActivityLog.ts)).limit(limit);
    return (sendJson(res, 200, rows.reverse().map((r) => ({ timestamp: r.ts, entry: { kind: r.kind === "tool" ? "tool_start" : r.kind, activity: r.activity, detail: r.detail, text: r.text, toolName: r.toolName, toolInput: r.toolInput } }))), true);
  }
  // ── Agent Permissions (scopes) ── GET to read / PUT to replace entirely. Default mode = grant all.
  const ascope = /^\/api\/agents\/([^/]+)\/scopes$/.exec(p);
  if (ascope && (method === "GET" || method === "PUT")) {
    const agId = ascope[1]!;
    const a = (await db.select().from(schema.agents).where(and(eq(schema.agents.id, agId), eq(schema.agents.serverId, serverId))))[0];
    if (!a) return (sendErr(res, 404, "agent not found"), true);
    if (method === "GET") { const eff = effectiveScopes(a.scopes); return (sendJson(res, 200, { agentId: agId, ...eff, catalog: SCOPES }), true); }
    const b = await readJson(req);
    if (!Array.isArray(b.scopes) || !b.scopes.every(isScopeLiteral)) return (sendErr(res, 400, "scopes must be an array of scope literals"), true);
    const granted = [...new Set(b.scopes as string[])].filter((s) => ALL_SCOPE_KEYS.includes(s));
    const next = { granted, mode: "custom" as const, revision: (a.scopes?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
    await db.update(schema.agents).set({ scopes: next }).where(eq(schema.agents.id, agId));
    return (sendJson(res, 200, { agentId: agId, ...next }), true);
  }
  // Agent Skills (used by Profile tab): daemon reads ~/.claude/skills on the machine + .claude/skills in the workspace
  const askill = /^\/api\/agents\/([^/]+)\/skills$/.exec(p);
  if (askill && method === "GET") {
    const a = (await db.select().from(schema.agents).where(and(eq(schema.agents.id, askill[1]!), eq(schema.agents.serverId, serverId))))[0];
    if (!a) return (sendErr(res, 404, "agent not found"), true);
    try { const r = await requestDaemon(serverId, { type: "agent:skills:list", agentId: askill[1]! }); return (sendJson(res, 200, { global: r.global ?? [], workspace: r.workspace ?? [] }), true); }
    catch { return (sendJson(res, 200, { global: [], workspace: [] }), true); }
  }
  // Apps tab (connected third-party integrations): no integrations implemented yet, returns empty array
  const aint = /^\/api\/integrations\/agents\/([^/]+)$/.exec(p);
  if (aint && method === "GET") return (sendJson(res, 200, []), true);
  // Agent DMs tab: derived from channels (DMs where this agent participates and the peer is also an agent)
  const adms = /^\/api\/agents\/([^/]+)\/agent-dms$/.exec(p);
  if (adms && method === "GET") {
    const agId = adms[1]!;
    const mine = await db.select().from(schema.channelMembers).where(and(eq(schema.channelMembers.memberType, "agent"), eq(schema.channelMembers.memberId, agId)));
    const out: any[] = [];
    for (const cm of mine) {
      const ch = (await db.select().from(schema.channels).where(and(eq(schema.channels.id, cm.channelId), eq(schema.channels.type, "dm"))))[0];
      if (!ch) continue;
      const peers = (await db.select().from(schema.channelMembers).where(eq(schema.channelMembers.channelId, ch.id))).filter((m) => !(m.memberType === "agent" && m.memberId === agId));
      const peer = peers.find((m) => m.memberType === "agent"); // only include agent↔agent DMs
      if (!peer) continue;
      const pa = (await db.select().from(schema.agents).where(eq(schema.agents.id, peer.memberId)))[0];
      out.push({ id: ch.id, name: pa?.name ?? "agent", peerId: peer.memberId, peerType: "agent", lastMessageAt: ch.lastMessageAt });
    }
    return (sendJson(res, 200, out), true);
  }
  const rm = /^\/api\/servers\/[^/]+\/machines\/[^/]+\/runtime-models\/([^/]+)$/.exec(p);
  if (rm && method === "GET") {
    // Model candidates: codex = slugs matching codex-rs + GPT-5.5 as default; claude = Claude Code aliases;
    // gemini/opencode likewise. For codex/claude/gemini the runtime uses its native CLI (no gateway model list); the frontend supplies these lists.
    const MODELS: Record<string, { id: string; label: string }[]> = {
      claude: [{ id: "sonnet", label: "Sonnet" }, { id: "opus", label: "Opus" }, { id: "haiku", label: "Haiku" }],
      codex: [
        { id: "gpt-5.5", label: "GPT-5.5" }, { id: "gpt-5.4", label: "GPT-5.4" },
        { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" }, { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" },
        { id: "gpt-5.2-codex", label: "GPT-5.2 Codex" }, { id: "gpt-5.2", label: "GPT-5.2" },
        { id: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max" }, { id: "gpt-5.1-codex", label: "GPT-5.1 Codex" },
        { id: "gpt-5-codex", label: "GPT-5 Codex" },
      ],
      gemini: [{ id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" }, { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" }],
      kimi: [{ id: "kimi-k2", label: "Kimi K2" }],
      opencode: [{ id: "default", label: "Default" }],
    };
    return (sendJson(res, 200, { models: MODELS[rm[1]!] ?? [{ id: "default", label: "Default" }] }), true);
  }
  // Reminders (read-only for users): reminders can only be created by the agent side via CLI; user side GETs to list them. ?ownerAgentId=&status=scheduled
  if (p === "/api/reminders" && method === "GET") {
    const ownerAgentId = url.searchParams.get("ownerAgentId") || url.searchParams.get("agentId");
    const status = url.searchParams.get("status"); // scheduled = not yet fired
    let rows = await db.select().from(schema.reminders).where(eq(schema.reminders.serverId, serverId)).orderBy(asc(schema.reminders.remindAt));
    if (ownerAgentId) rows = rows.filter((r) => r.ownerType === "agent" && r.ownerId === ownerAgentId);
    if (status) rows = rows.filter((r) => r.status === status);
    return (sendJson(res, 200, { reminders: rows.map((r) => ({ id: r.id, content: r.content, status: r.status, recurrence: r.recurrence, anchorMessageId: r.anchorMessageId, remindAt: r.remindAt, firedAt: r.firedAt, channelId: r.channelId, ownerType: r.ownerType, ownerId: r.ownerId, createdAt: r.createdAt })) }), true);
  }
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
    const th = await getOrCreateThread(serverId, b.parentMessageId, { type: "user", id: userId });
    const replies = await db.select({ createdAt: schema.messages.createdAt }).from(schema.messages).where(eq(schema.messages.channelId, th.id));
    const parts = await db.select().from(schema.channelMembers).where(eq(schema.channelMembers.channelId, th.id));
    return (sendJson(res, 200, { threadChannelId: th.id, parentMessageId: b.parentMessageId, replyCount: replies.length, lastReplyAt: replies.at(-1)?.createdAt ?? null, participantIds: parts.map((pp) => pp.memberId) }), true);
  }
  if (cthreads && method === "GET") {
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
    else if (filter === "mentions") filtered = items.filter((i) => i.hasMention);
    return (sendJson(res, 200, { items: filtered.slice(offset, offset + limit) }), true);
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
    const m = (await db.select().from(schema.messages).where(and(eq(schema.messages.id, messageId), eq(schema.messages.serverId, serverId))))[0];
    if (!m) return (sendErr(res, 404, "message not found"), true);
    await saveMessage(serverId, messageId, "user", userId);
    return (sendJson(res, 200, { ok: true }), true);
  }
  // Bulk saved check: body {messageIds[]} → {savedIds[]}
  if (p === "/api/channels/saved/check" && method === "POST") {
    const b = await readJson(req).catch(() => ({}));
    const ids = Array.isArray(b.messageIds) ? b.messageIds.map((x: unknown) => String(x)) : [];
    const savedIds = await checkSaved(serverId, "user", userId, ids);
    return (sendJson(res, 200, { savedIds }), true);
  }
  // Unsave: DELETE /channels/saved/:messageId
  const cunsave = /^\/api\/channels\/saved\/([^/]+)$/.exec(p);
  if (cunsave && method === "DELETE") {
    await unsaveMessage(serverId, cunsave[1]!, "user", userId);
    return (sendJson(res, 200, { ok: true }), true);
  }
  // Contract stub (returns empty response for unbuilt features): active announcements
  if (p === "/api/announcements/active" && method === "GET") return (sendJson(res, 200, { announcements: [] }), true);
  const cmem = /^\/api\/channels\/([^/]+)\/members$/.exec(p);
  if (cmem && method === "GET") {
    const rows = await db.select().from(schema.channelMembers).where(eq(schema.channelMembers.channelId, cmem[1]!));
    const aIds = rows.filter((r) => r.memberType === "agent").map((r) => r.memberId);
    const uIds = rows.filter((r) => r.memberType === "user").map((r) => r.memberId);
    const ags = aIds.length ? await db.select().from(schema.agents).where(inArray(schema.agents.id, aIds)) : [];
    const usrs = uIds.length ? await db.select().from(schema.users).where(inArray(schema.users.id, uIds)) : [];
    return (sendJson(res, 200, {
      agents: ags.map((a) => ({ id: a.id, name: a.name, displayName: a.displayName, status: a.status, activity: a.activity })),
      humans: usrs.map((u) => ({ userId: u.id, name: u.name, displayName: u.displayName })),
    }), true);
  }
  if (cmem && method === "POST") { // add agent/user to channel (public = direct join, private = invite)
    const b = await readJson(req);
    const mt = b.userId ? "user" : "agent"; const mid = b.userId || b.agentId;
    if (!mid) return (sendErr(res, 400, "agentId or userId required"), true);
    await db.insert(schema.channelMembers).values({ channelId: cmem[1]!, memberType: mt, memberId: mid }).onConflictDoNothing();
    await publish(serverId, { type: "channel:members-updated", channelId: cmem[1]! }); // realtime: membership change → all clients refresh member/channel list and new member joins the room (G-E)
    return (sendJson(res, 200, { ok: true }), true);
  }
  if (cmem && method === "DELETE") { // remove from channel
    const b = await readJson(req).catch(() => ({}));
    const mt = b.userId ? "user" : "agent"; const mid = b.userId || b.agentId;
    if (mid) await db.delete(schema.channelMembers).where(and(eq(schema.channelMembers.channelId, cmem[1]!), eq(schema.channelMembers.memberType, mt), eq(schema.channelMembers.memberId, mid)));
    await publish(serverId, { type: "channel:members-updated", channelId: cmem[1]! });
    return (sendJson(res, 200, { ok: true }), true);
  }
  // Attachment upload (multipart, fields: files + channelId) → save to disk + insert attachment row (messageId is backfilled when the message is sent)
  if (p === "/api/attachments/upload" && method === "POST") {
    const { fields, files } = await parseUpload(req);
    const out: any[] = [];
    for (const f of files) {
      const [a] = await db.insert(schema.attachments).values({ serverId, channelId: fields.channelId || null, uploaderType: "user", uploaderId: userId, filename: f.filename, mimeType: f.mimeType, sizeBytes: f.size, storageKey: f.storageKey }).returning();
      out.push({ attachmentId: a!.id, id: a!.id, filename: a!.filename, mimeType: a!.mimeType, sizeBytes: a!.sizeBytes });
    }
    return (sendJson(res, 200, { attachments: out, attachmentId: out[0]?.attachmentId }), true);
  }
  // Agent avatar upload: manageAgents capability required → stored as attachment → agents.avatarUrl
  const agavatar = /^\/api\/agents\/([^/]+)\/avatar$/.exec(p);
  if (agavatar && method === "POST") {
    if (!await requireCap(serverId, userId, "manageAgents")) return (sendErr(res, 403, "need manageAgents capability"), true);
    const agentId = agavatar[1]!;
    const { files } = await parseUpload(req);
    const f = files[0];
    if (!f) return (sendErr(res, 400, "no file"), true);
    if (!(f.mimeType || "").startsWith("image/")) return (sendErr(res, 400, "avatar must be an image"), true);
    const [att] = await db.insert(schema.attachments).values({ serverId, channelId: null, uploaderType: "user", uploaderId: userId, filename: f.filename, mimeType: f.mimeType, sizeBytes: f.size, storageKey: f.storageKey }).returning();
    const avatarUrl = `/api/attachments/${att!.id}`;
    await db.update(schema.agents).set({ avatarUrl }).where(and(eq(schema.agents.id, agentId), eq(schema.agents.serverId, serverId)));
    return (sendJson(res, 200, { avatarUrl }), true);
  }
  // Current user avatar upload → stored as attachment → users.avatarUrl
  if (p === "/api/auth/me/avatar" && method === "POST") {
    const { files } = await parseUpload(req);
    const f = files[0];
    if (!f) return (sendErr(res, 400, "no file"), true);
    if (!(f.mimeType || "").startsWith("image/")) return (sendErr(res, 400, "avatar must be an image"), true);
    const [att] = await db.insert(schema.attachments).values({ serverId, channelId: null, uploaderType: "user", uploaderId: userId, filename: f.filename, mimeType: f.mimeType, sizeBytes: f.size, storageKey: f.storageKey }).returning();
    const avatarUrl = `/api/attachments/${att!.id}`;
    await db.update(schema.users).set({ avatarUrl }).where(eq(schema.users.id, userId));
    return (sendJson(res, 200, { avatarUrl }), true);
  }
  // Workspace avatar upload: owner/admin uploads image → stored as attachment → servers.avatarUrl
  const savatar = /^\/api\/servers\/([^/]+)\/avatar$/.exec(p);
  if (savatar && method === "POST") {
    const sid = savatar[1]!;
    const mem = (await db.select().from(schema.serverMembers).where(and(eq(schema.serverMembers.serverId, sid), eq(schema.serverMembers.userId, userId))))[0];
    if (!mem || !can(mem.role, "manageServer")) return (sendErr(res, 403, "need manageServer capability"), true);
    const { files } = await parseUpload(req);
    const f = files[0];
    if (!f) return (sendErr(res, 400, "no file"), true);
    if (!(f.mimeType || "").startsWith("image/")) return (sendErr(res, 400, "avatar must be an image"), true);
    const [a] = await db.insert(schema.attachments).values({ serverId: sid, channelId: null, uploaderType: "user", uploaderId: userId, filename: f.filename, mimeType: f.mimeType, sizeBytes: f.size, storageKey: f.storageKey }).returning();
    const avatarUrl = `/api/attachments/${a!.id}`;
    await db.update(schema.servers).set({ avatarUrl }).where(eq(schema.servers.id, sid));
    return (sendJson(res, 200, { avatarUrl }), true);
  }
  // Channel file list (attachments linked to messages)
  const cfiles = /^\/api\/channels\/([^/]+)\/files$/.exec(p);
  if (cfiles && method === "GET") {
    const rows = await db.select().from(schema.attachments).where(and(eq(schema.attachments.channelId, cfiles[1]!), isNotNull(schema.attachments.messageId))).orderBy(desc(schema.attachments.createdAt)).limit(100);
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
    await db.update(schema.channels).set({ archivedAt: cops[2] === "archive" ? new Date() : null }).where(and(eq(schema.channels.id, cops[1]!), eq(schema.channels.serverId, serverId)));
    await publish(serverId, { type: "channel:updated", channelId: cops[1]! });
    return (sendJson(res, 200, { ok: true }), true);
  }
  const cone = /^\/api\/channels\/([^/]+)$/.exec(p);
  if (cone && (method === "PATCH" || method === "DELETE")) {
    if (!await requireCap(serverId, userId, "manageChannels")) return (sendErr(res, 403, "need manageChannels capability"), true);
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
      await db.insert(schema.channelMembers).values({ channelId: chId!, memberType: "user", memberId: userId }).onConflictDoNothing();
    } else if (action === "leave") {
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
  const mprof = /^\/api\/servers\/[^/]+\/members\/([^/]+)\/profile$/.exec(p);
  if (mprof && method === "GET") {
    const uid = mprof[1]!;
    const mem = (await db.select().from(schema.serverMembers).where(and(eq(schema.serverMembers.serverId, serverId), eq(schema.serverMembers.userId, uid))))[0];
    const u = mem ? (await db.select().from(schema.users).where(eq(schema.users.id, uid)))[0] : null;
    if (!mem || !u) return (sendErr(res, 404, "member not found"), true);
    const created = await db.select().from(schema.agents).where(and(eq(schema.agents.serverId, serverId), eq(schema.agents.creatorId, uid)));
    return (sendJson(res, 200, {
      userId: u.id, name: u.name, displayName: u.displayName, description: u.description,
      avatarUrl: u.avatarUrl, email: u.email, gravatarHash: u.gravatarHash,
      role: mem.role, joinedAt: mem.joinedAt,
      createdAgents: created.map((a) => ({ id: a.id, name: a.name, displayName: a.displayName, avatarUrl: a.avatarUrl, runtime: a.runtime, status: a.status })),
    }), true);
  }
  // Join links (/servers/:id/join-links, manageMembers). serverId comes from middleware (x-server-id).
  const jl = /^\/api\/servers\/[^/]+\/join-links$/.exec(p);
  if (jl && (method === "GET" || method === "POST")) {
    if (!await requireCap(serverId, userId, "manageMembers")) return (sendErr(res, 403, "need manageMembers capability"), true);
    if (method === "GET") {
      const links = await db.select().from(schema.joinLinks).where(eq(schema.joinLinks.serverId, serverId));
      return (sendJson(res, 200, links.map((l) => ({ id: l.id, token: l.token, role: l.role, maxUses: l.maxUses, useCount: l.useCount, expiresAt: l.expiresAt, createdAt: l.createdAt }))), true);
    }
    const b = await readJson(req);
    const role = b.role === "admin" ? "admin" : "member"; // joining via link only grants admin/member; never owner (prevents privilege escalation via leaked link)
    const [link] = await db.insert(schema.joinLinks).values({ serverId, token: newKey("inv_"), createdByUserId: userId, role, maxUses: b.maxUses != null ? Number(b.maxUses) : null, expiresAt: b.expiresAt ? new Date(b.expiresAt) : null }).returning();
    return (sendJson(res, 200, { id: link!.id, token: link!.token, role: link!.role, maxUses: link!.maxUses, useCount: 0, expiresAt: link!.expiresAt, createdAt: link!.createdAt }), true);
  }
  const jld = /^\/api\/servers\/[^/]+\/join-links\/([^/]+)$/.exec(p);
  if (jld && method === "DELETE") {
    if (!await requireCap(serverId, userId, "manageMembers")) return (sendErr(res, 403, "need manageMembers capability"), true);
    await db.delete(schema.joinLinks).where(and(eq(schema.joinLinks.id, jld[1]!), eq(schema.joinLinks.serverId, serverId)));
    return (sendJson(res, 200, { ok: true }), true);
  }
  // Member role management (PATCH/DELETE /servers/:id/members/:uid). Constraints: matching capability + cannot modify self + last owner cannot be demoted or removed.
  const mrole = /^\/api\/servers\/[^/]+\/members\/([^/]+)$/.exec(p);
  if (mrole && (method === "PATCH" || method === "DELETE")) {
    const cap = method === "PATCH" ? "changeMemberRoles" : "manageMembers";
    if (!await requireCap(serverId, userId, cap)) return (sendErr(res, 403, `need ${cap} capability`), true);
    const targetId = mrole[1]!;
    if (targetId === userId) return (sendErr(res, 400, "cannot change your own membership"), true);
    const target = (await db.select().from(schema.serverMembers).where(and(eq(schema.serverMembers.serverId, serverId), eq(schema.serverMembers.userId, targetId))))[0];
    if (!target) return (sendErr(res, 404, "member not found"), true);
    if (target.role === "owner") { // last owner guard
      const owners = await db.select().from(schema.serverMembers).where(and(eq(schema.serverMembers.serverId, serverId), eq(schema.serverMembers.role, "owner")));
      if (owners.length <= 1) return (sendErr(res, 400, "cannot demote/remove the last owner"), true);
    }
    if (method === "PATCH") {
      const b = await readJson(req);
      if (!["owner", "admin", "member"].includes(b.role)) return (sendErr(res, 400, "invalid role"), true);
      await db.update(schema.serverMembers).set({ role: b.role }).where(and(eq(schema.serverMembers.serverId, serverId), eq(schema.serverMembers.userId, targetId)));
      await publish(serverId, { type: "server:members-updated" });
      return (sendJson(res, 200, { ok: true, role: b.role }), true);
    }
    // DELETE: remove member (also removes them from all channels in this server)
    const chs = await db.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.serverId, serverId));
    if (chs.length) await db.delete(schema.channelMembers).where(and(eq(schema.channelMembers.memberType, "user"), eq(schema.channelMembers.memberId, targetId), inArray(schema.channelMembers.channelId, chs.map((c) => c.id))));
    await db.delete(schema.serverMembers).where(and(eq(schema.serverMembers.serverId, serverId), eq(schema.serverMembers.userId, targetId)));
    await publish(serverId, { type: "server:members-updated" });
    return (sendJson(res, 200, { ok: true }), true);
  }
  let mm = /^\/api\/servers\/[^/]+\/(members|machines)$/.exec(p);
  if (mm && method === "GET") {
    if (mm[1] === "members") {
      const rows = await db.select().from(schema.serverMembers).where(eq(schema.serverMembers.serverId, serverId));
      const uids = rows.map((r) => r.userId);
      const users = uids.length ? await db.select().from(schema.users).where(inArray(schema.users.id, uids)) : [];
      return (sendJson(res, 200, users.map((u) => ({ userId: u.id, name: u.name, displayName: u.displayName, description: u.description, avatarUrl: u.avatarUrl, role: rows.find((r) => r.userId === u.id)?.role }))), true);
    }
    const machines = await db.select().from(schema.machines).where(eq(schema.machines.serverId, serverId));
    return (sendJson(res, 200, { machines: machines.map((m) => ({ id: m.id, name: m.name, hostname: m.hostname, os: m.os, runtimes: m.runtimes, status: m.status, daemonVersion: m.daemonVersion, isComputer: m.isComputer, apiKeyPrefix: m.apiKeyPrefix, lastHeartbeat: m.lastHeartbeat })), latestDaemonVersion: "0.1.0" }), true);
  }
  // Notification settings (GET/PATCH /api/servers/:id/notification-settings): per-user push mute setting for this server
  const nset = /^\/api\/servers\/[^/]+\/notification-settings$/.exec(p);
  if (nset && (method === "GET" || method === "PATCH" || method === "PUT")) {
    if (method !== "GET") {
      const b = await readJson(req).catch(() => ({}));
      if (typeof b.serverPushMuted === "boolean") {
        await db.update(schema.serverMembers).set({ pushMuted: b.serverPushMuted }).where(and(eq(schema.serverMembers.serverId, serverId), eq(schema.serverMembers.userId, userId)));
      }
    }
    const mrow = (await db.select().from(schema.serverMembers).where(and(eq(schema.serverMembers.serverId, serverId), eq(schema.serverMembers.userId, userId))))[0];
    return (sendJson(res, 200, { serverPushMuted: mrow?.pushMuted ?? false }), true);
  }
  // Sidebar preferences (GET/PUT /api/servers/:id/sidebar-order): pin / sort / hide DMs, per user per server.
  const sbo = /^\/api\/servers\/[^/]+\/sidebar-order$/.exec(p);
  if (sbo && (method === "GET" || method === "PUT" || method === "PATCH")) {
    const DEFAULTS = {
      channelOrder: [] as string[], agentOrder: [] as string[], dmOrder: [] as string[],
      channelSortMode: "manual", jointChannelSortMode: "manual", dmSortMode: "manual", pinnedSortMode: "manual",
      pinnedChannelIds: [] as string[], pinnedAgentIds: [] as string[], pinnedOrder: [] as string[],
      hiddenDmIds: [] as string[], channelPanelTabOrder: [] as string[], agentPanelTabOrder: [] as string[],
    };
    if (method !== "GET") {
      const b = await readJson(req).catch(() => ({}));
      const cur = (await db.select().from(schema.serverSidebarPrefs).where(and(eq(schema.serverSidebarPrefs.serverId, serverId), eq(schema.serverSidebarPrefs.userId, userId))))[0];
      const merged = { ...DEFAULTS, ...(cur?.prefs as object ?? {}), ...(b && typeof b === "object" ? b : {}) };
      await db.insert(schema.serverSidebarPrefs).values({ serverId, userId, prefs: merged })
        .onConflictDoUpdate({ target: [schema.serverSidebarPrefs.serverId, schema.serverSidebarPrefs.userId], set: { prefs: merged, updatedAt: new Date() } });
      return (sendJson(res, 200, merged), true);
    }
    const row = (await db.select().from(schema.serverSidebarPrefs).where(and(eq(schema.serverSidebarPrefs.serverId, serverId), eq(schema.serverSidebarPrefs.userId, userId))))[0];
    return (sendJson(res, 200, { ...DEFAULTS, ...(row?.prefs as object ?? {}) }), true);
  }
  // Connect a machine (add computer flow): generate sk_machine_* key + pre-create offline machine record
  // Key is returned in plaintext exactly once; daemon uses it to connect via /daemon/connect?key=; onReady claims this row by apiKeyHash
  if (mm && mm[1] === "machines" && method === "POST") {
    const b = await readJson(req).catch(() => ({}));
    const name = String(b.name ?? "").trim() || "new machine";
    const key = newKey("sk_machine_");
    const [m] = await db.insert(schema.machines).values({
      serverId, userId, name, apiKeyHash: hashToken(key), apiKeyPrefix: key.slice(0, 14), status: "offline", isComputer: false,
    }).returning();
    return (sendJson(res, 200, { id: m!.id, name: m!.name, apiKeyPrefix: m!.apiKeyPrefix, key }), true);
  }
  // Delete machine: reject if agents are present, prompting removal of all agents first
  const dmach = /^\/api\/servers\/[^/]+\/machines\/([^/]+)$/.exec(p);
  if (dmach && method === "DELETE") {
    const mid = dmach[1]!;
    const m = (await db.select().from(schema.machines).where(and(eq(schema.machines.id, mid), eq(schema.machines.serverId, serverId))))[0];
    if (!m) return (sendErr(res, 404, "machine not found"), true);
    const onIt = await db.select().from(schema.agents).where(and(eq(schema.agents.serverId, serverId), eq(schema.agents.machineId, mid), isNull(schema.agents.deletedAt)));
    if (onIt.length) return (sendErr(res, 409, `This machine still has ${onIt.length} agent(s) attached. Please remove them before deleting the machine.`, { agentCount: onIt.length }), true);
    await db.delete(schema.machines).where(eq(schema.machines.id, mid));
    await publish(serverId, { type: "machine", online: false, machineId: mid, removed: true });
    return (sendJson(res, 200, { ok: true }), true);
  }

  // Full-text search (GET /api/messages/search): searches only channels visible to the user, returns a snippet
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
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
    const msgs = await db.select().from(schema.messages).where(eq(schema.messages.channelId, cmsg[1]!)).orderBy(desc(schema.messages.seq)).limit(limit);
    return (sendJson(res, 200, { messages: (await attachMentions(msgs.reverse())) }), true);
  }
  if (p === "/api/messages" && method === "POST") {
    const b = await readJson(req);
    const hasAtt = Array.isArray(b.attachmentIds) && b.attachmentIds.length > 0;
    if (!b.channelId || (!b.content && !hasAtt)) return (sendErr(res, 400, "channelId + content (or attachmentIds) required"), true);
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
    const m = (await db.select().from(schema.messages).where(and(eq(schema.messages.id, react[1]!), eq(schema.messages.serverId, serverId))))[0];
    if (!m) return (sendErr(res, 404, "message not found"), true);
    const out = method === "POST" ? await addReaction(serverId, react[1]!, "user", userId, emoji) : await removeReaction(serverId, react[1]!, "user", userId, emoji);
    return (sendJson(res, 200, out), true);
  }
  // Mark action card as executed (POST /actions/:messageId/mark-executed).
  // Actual creation goes through existing POST /api/channels|/api/agents (as user); this endpoint only marks the card as executed and leaves an audit trail; no new privileged execution path.
  const amark = /^\/api\/actions\/([^/]+)\/mark-executed$/.exec(p);
  if (amark && method === "POST") {
    const b = await readJson(req).catch(() => ({}));
    const m = (await db.select().from(schema.messages).where(and(eq(schema.messages.id, amark[1]!), eq(schema.messages.serverId, serverId))))[0];
    if (!m) return (sendErr(res, 404, "action not found"), true);
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

  // ---- Tasks (messages as tasks) ----
  const tch = /^\/api\/tasks\/channel\/([^/]+)$/.exec(p);
  if (tch && method === "GET") {
    const rows = await db.select().from(schema.messages)
      .where(and(eq(schema.messages.channelId, tch[1]!), isNotNull(schema.messages.taskStatus)))
      .orderBy(asc(schema.messages.taskNumber));
    return (sendJson(res, 200, { tasks: await attachMentions(rows) }), true);
  }
  if (tch && method === "POST") { // New Task: bulk create tasks, body { tasks: [{ title }] }
    const b = await readJson(req);
    const titles = (Array.isArray(b.tasks) ? b.tasks : []).map((t: any) => String(t?.title ?? "").trim()).filter(Boolean);
    if (!titles.length) return (sendErr(res, 400, "tasks[].title required"), true);
    const u = (await db.select().from(schema.users).where(eq(schema.users.id, userId)))[0];
    const created: (typeof schema.messages.$inferSelect)[] = [];
    for (const title of titles) created.push(await createMessage({ serverId, channelId: tch[1]!, senderType: "user", senderId: userId, senderName: u!.name, content: title, asTask: true }));
    return (sendJson(res, 200, { tasks: await attachMentions(created) }), true);
  }
  if (p === "/api/tasks/server" && method === "GET") {
    const rows = await db.select().from(schema.messages)
      .where(and(eq(schema.messages.serverId, serverId), isNotNull(schema.messages.taskStatus)))
      .orderBy(asc(schema.messages.taskNumber));
    return (sendJson(res, 200, { tasks: await attachMentions(rows) }), true);
  }
  if (p === "/api/tasks/convert-message" && method === "POST") {
    const b = await readJson(req);
    if (!b.messageId) return (sendErr(res, 400, "messageId required"), true);
    const t = await convertMessageToTask(serverId, b.messageId, { type: "user", id: userId });
    return (t ? sendJson(res, 200, { ok: true, id: t.id, taskNumber: t.taskNumber }) : sendErr(res, 404, "message not found"), true);
  }
  const tact = /^\/api\/tasks\/([^/]+)\/(claim|unclaim|status)$/.exec(p);
  if (tact && method === "PATCH") { // claim/unclaim/status are all PATCH
    const [, taskId, action] = tact;
    let r;
    if (action === "claim") {
      r = await claimTask(serverId, taskId!, "user", userId);
      if (!r) return (sendErr(res, 409, "already claimed", { code: "CLAIM_FAILED" }), true); // atomic claim failed: someone else got there first
    }
    else if (action === "unclaim") r = await unclaimTask(serverId, taskId!, { type: "user", id: userId });
    else { const b = await readJson(req).catch(() => ({})); const st = String(b?.status ?? ""); if (!(TASK_STATUSES as readonly string[]).includes(st)) return (sendErr(res, 400, `valid status is required (${TASK_STATUSES.join(", ")})`), true); r = await setTaskStatus(serverId, taskId!, st, { type: "user", id: userId }); }
    return (r ? sendJson(res, 200, { ok: true, taskStatus: r.taskStatus }) : sendErr(res, 404, "task not found"), true);
  }
  const tdel = /^\/api\/tasks\/([^/]+)$/.exec(p);
  if (tdel && method === "DELETE") { // delete task = revert to plain message (clear task fields); source message is preserved
    const r = await deleteTask(serverId, tdel[1]!);
    return (r ? sendJson(res, 200, { ok: true }) : sendErr(res, 404, "task not found"), true);
  }
  return (sendErr(res, 404, "not found"), true);
}

// Auto-extracted from the former routes-api.ts monolith — bodies are verbatim.
import type { UserCtx, ServerCtx } from "./ctx.js";
import { and, count, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { hashToken, newKey } from "../auth.js";
import { can, capabilitiesFor, requireCap } from "../capabilities.js";
import { createServer } from "../core.js";
import { publish } from "../realtime.js";
import { DYNAMIC_RUNTIMES, getDynamicModels } from "../runtimeModels.js";
import { readJson, sendErr, sendJson } from "../util.js";

export async function handleServersUserScope(ctx: UserCtx): Promise<boolean> {
  const { req, res, method, p, userId } = ctx;
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
  return false;
}

export async function handleServersServerScope(ctx: ServerCtx): Promise<boolean> {
  const { req, res, method, p, userId, serverId } = ctx;
  const rm = /^\/api\/servers\/[^/]+\/machines\/([^/]+)\/runtime-models\/([^/]+)$/.exec(p);
  if (rm && method === "GET") {
    const machineId = rm[1]!, runtime = rm[2]!;
    // The static lists below are the FALLBACK. opencode/cursor/pi are probed live on the machine (further
    // down) and only use these on miss/offline/timeout. claude/codex use their native CLI (no gateway
    // model list), so their catalog is curated here. copilot/kimi have no list command — live per-account
    // discovery would need an ACP probe (tracked in docs/tech-debt-tracker.md); "auto" is first/default
    // for copilot so it picks an accessible model (one the account lacks fails loudly at runtime).
    const MODELS: Record<string, { id: string; label: string }[]> = {
      claude: [{ id: "sonnet", label: "Sonnet" }, { id: "opus", label: "Opus" }, { id: "haiku", label: "Haiku" }],
      codex: [
        { id: "gpt-5.5", label: "GPT-5.5" }, { id: "gpt-5.4", label: "GPT-5.4" },
        { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" }, { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" },
        { id: "gpt-5.2-codex", label: "GPT-5.2 Codex" }, { id: "gpt-5.2", label: "GPT-5.2" },
        { id: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max" }, { id: "gpt-5.1-codex", label: "GPT-5.1 Codex" },
        { id: "gpt-5-codex", label: "GPT-5 Codex" },
      ],
      copilot: [
        { id: "auto", label: "Auto (recommended)" },
        { id: "gpt-5.5", label: "GPT-5.5" }, { id: "gpt-5.4", label: "GPT-5.4" }, { id: "gpt-5.2-codex", label: "GPT-5.2 Codex" },
        { id: "claude-opus-4.7", label: "Claude Opus 4.7" }, { id: "claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
        { id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" }, { id: "claude-haiku-4.5", label: "Claude Haiku 4.5" },
      ],
      kimi: [{ id: "default", label: "Default (config.toml)" }],
      opencode: [{ id: "default", label: "Default" }],
      cursor: [{ id: "default", label: "Default (Composer)" }, { id: "sonnet-4", label: "Sonnet 4" }, { id: "sonnet-4-thinking", label: "Sonnet 4 (thinking)" }, { id: "gpt-5", label: "GPT-5" }],
    };
    // Live discovery for runtimes whose CLI lists its own models: ask THAT machine's daemon to probe,
    // cache briefly, serve the static list on any miss/offline/timeout (machineId "none" = unbound agent).
    // Tenant isolation: machineId is client-supplied, so confirm it belongs to THIS server before routing
    // a probe to it — otherwise a cross-tenant id could enumerate another server's machine model list.
    if (DYNAMIC_RUNTIMES.has(runtime) && machineId !== "none") {
      const owns = (await db.select().from(schema.machines).where(and(eq(schema.machines.id, machineId), eq(schema.machines.serverId, serverId))))[0];
      if (owns) {
        const models = await getDynamicModels(machineId, runtime);
        if (models?.length) return (sendJson(res, 200, { models }), true);
      }
    }
    return (sendJson(res, 200, { models: MODELS[runtime] ?? [{ id: "default", label: "Default" }] }), true);
  }
  // Reminders (read-only for users): reminders can only be created by the agent side via CLI; user side GETs to list them. ?ownerAgentId=&status=scheduled
  const mprof = /^\/api\/servers\/[^/]+\/members\/([^/]+)\/profile$/.exec(p);
  if (mprof && method === "GET") {
    const uid = mprof[1]!;
    const mem = (await db.select().from(schema.serverMembers).where(and(eq(schema.serverMembers.serverId, serverId), eq(schema.serverMembers.userId, uid))))[0];
    const u = mem ? (await db.select().from(schema.users).where(eq(schema.users.id, uid)))[0] : null;
    if (!mem || !u) return (sendErr(res, 404, "member not found"), true);
    const created = await db.select().from(schema.agents).where(and(eq(schema.agents.serverId, serverId), eq(schema.agents.creatorId, uid), isNull(schema.agents.deletedAt))); // exclude soft-deleted agents, same as GET /api/agents — otherwise deleted agents leak into the profile's "Created Agents" card
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
    if (!await requireCap(serverId, userId, "manageMachines")) return (sendErr(res, 403, "need manageMachines capability"), true);
    const b = await readJson(req).catch(() => ({}));
    const name = String(b.name ?? "").trim() || "new machine";
    const key = newKey("sk_machine_");
    const [m] = await db.insert(schema.machines).values({
      serverId, userId, name, apiKeyHash: hashToken(key), apiKeyPrefix: key.slice(0, 14), status: "offline", isComputer: false,
    }).returning();
    return (sendJson(res, 200, { id: m!.id, name: m!.name, apiKeyPrefix: m!.apiKeyPrefix, key }), true);
  }
  // Reconnect a machine: rotate the connection key on the SAME row. Lets an offline machine whose one-time
  // key was lost come back online without spawning a duplicate row (the old key stops resolving → its daemon
  // gets a permanent-rejection close). Returns the new key in plaintext exactly once, same shape as create.
  const recon = /^\/api\/servers\/[^/]+\/machines\/([^/]+)\/reconnect$/.exec(p);
  if (recon && method === "POST") {
    if (!await requireCap(serverId, userId, "manageMachines")) return (sendErr(res, 403, "need manageMachines capability"), true);
    const mid = recon[1]!;
    const m = (await db.select().from(schema.machines).where(and(eq(schema.machines.id, mid), eq(schema.machines.serverId, serverId))))[0];
    if (!m) return (sendErr(res, 404, "machine not found"), true);
    // Rotating the key orphans whatever daemon currently holds it; an online machine has a live daemon, so
    // refuse and tell the operator to stop it first (the UI only offers Reconnect on offline machines anyway).
    if (m.status === "online") return (sendErr(res, 409, "machine is online; stop its daemon before rotating the key"), true);
    const key = newKey("sk_machine_");
    await db.update(schema.machines).set({ apiKeyHash: hashToken(key), apiKeyPrefix: key.slice(0, 14) }).where(eq(schema.machines.id, mid));
    return (sendJson(res, 200, { id: m.id, name: m.name, apiKeyPrefix: key.slice(0, 14), key }), true);
  }
  // Delete machine: reject if agents are present, prompting removal of all agents first
  const dmach = /^\/api\/servers\/[^/]+\/machines\/([^/]+)$/.exec(p);
  if (dmach && method === "DELETE") {
    if (!await requireCap(serverId, userId, "manageMachines")) return (sendErr(res, 403, "need manageMachines capability"), true);
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
  return false;
}

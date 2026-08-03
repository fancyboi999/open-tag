// Auto-extracted from the former routes-api.ts monolith — bodies are verbatim.
import type { ServerCtx } from "./ctx.js";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { requireCap } from "../capabilities.js";
import { DESC_TOO_LONG, INVALID_AGENT_NAME, addChannelMembers, descTooLong, invalidAgentName, dequeueAgent, resetAgent, startAgent, stopAgent, syncAgentProfile } from "../core.js";
import { PROJECT_DIRECTORY_CAPABILITY, projectDirectoryBlockReason, requestDaemon, requestDaemonByMachine } from "../daemonHub.js";
import { publish } from "../realtime.js";
import { ALL_SCOPE_KEYS, SCOPES, effectiveScopes, isScopeLiteral } from "../scopes.js";
import { isUuid, readJson, sendErr, sendJson } from "../util.js";

async function canonicalProjectPath(serverId: string, machineId: string, value: unknown): Promise<{ projectPath: string | null } | { error: string; status: number }> {
  if (value === undefined || value === null || value === "") return { projectPath: null };
  if (typeof value !== "string") return { error: "projectPath must be a string", status: 400 };
  if (value.length > 4096) return { error: "project directory is too long", status: 400 };
  const blocked = projectDirectoryBlockReason(serverId, machineId);
  if (blocked) return { error: blocked, status: 503 };
  const result = await requestDaemonByMachine(machineId, { type: "project:resolve", path: value }, 6000, {
    serverId,
    capabilities: [PROJECT_DIRECTORY_CAPABILITY],
  });
  if (result?.error) {
    const error = String(result.error);
    const status = /does not support|daemon|machine offline|send failed/i.test(error) ? 503 : 400;
    return { error, status };
  }
  if (result?.type !== "project:resolved" || typeof result.projectPath !== "string") return { error: "invalid project-directory response", status: 503 };
  return { projectPath: result.projectPath };
}

export async function handleAgents(ctx: ServerCtx): Promise<boolean> {
  const { req, res, url, method, p, userId, serverId } = ctx;
  const requestAgentDaemon = (a: { machineId: string | null }, msg: Record<string, unknown>) =>
    a.machineId ? requestDaemonByMachine(a.machineId, msg) : requestDaemon(serverId, msg);
  if (p === "/api/agents" && method === "GET") {
    const machineId = url.searchParams.get("machineId"); // computer page filters by machine
    let agents = await db.select().from(schema.agents).where(and(eq(schema.agents.serverId, serverId), isNull(schema.agents.deletedAt)));
    if (machineId) agents = agents.filter((a) => a.machineId === machineId);
    // creatorType lets the client distinguish system-seeded showcase agents (creatorType="system") from
    // real members — they stay in the store so #showcase history renders their avatar/name, but are filtered
    // out of member rosters and agent pickers (see web/src/store.tsx visibleAgents).
    return (sendJson(res, 200, agents.map((a) => ({ id: a.id, name: a.name, displayName: a.displayName, description: a.description, status: a.status, activity: a.activity, model: a.model, runtime: a.runtime, machineId: a.machineId, avatarUrl: a.avatarUrl, creatorType: a.creatorType }))), true);
  }
  if (p === "/api/agents" && method === "POST") {
    if (!await requireCap(serverId, userId, "manageAgents")) return (sendErr(res, 403, "need manageAgents capability"), true);
    const b = await readJson(req);
    if (!b.name) return (sendErr(res, 400, "name required"), true);
    if (invalidAgentName(b.name)) return (sendErr(res, 400, INVALID_AGENT_NAME), true);
    if (descTooLong(b.description)) return (sendErr(res, 400, DESC_TOO_LONG), true);
    // A new agent must be created bound to a machine — an unbound (machineId=null) agent can only run via the
    // legacy broadcastToDaemons fallback (any daemon connected to the server may pick it up), which is a
    // one-way door (no rebind API yet, see tech-debt I77) and non-deterministic once >1 machine is connected.
    // The web client's create modal now requires picking one; enforce it here too so no caller can slip past it.
    if (!b.machineId) return (sendErr(res, 400, "machineId required"), true);
    if (!isUuid(String(b.machineId))) return (sendErr(res, 404, "machine not found"), true); // non-uuid would throw casting into the uuid column → 500
    const machine = (await db.select({ id: schema.machines.id }).from(schema.machines)
      .where(and(eq(schema.machines.id, b.machineId), eq(schema.machines.serverId, serverId))))[0];
    if (!machine) return (sendErr(res, 404, "machine not found"), true); // 404, not 400: existence-hiding for a cross-tenant/bogus id, consistent with this repo's other ownership pre-checks
    const resolvedProject = await canonicalProjectPath(serverId, machine.id, b.projectPath);
    if ("error" in resolvedProject) return (sendErr(res, resolvedProject.status, resolvedProject.error), true);
    // A live agent name must be unique per server — it is the @mention / dm:@<name> routing key, so a duplicate
    // becomes an unreachable routing blind spot. ON CONFLICT against the agents_name_uniq partial index is
    // race-proof (no SELECT-then-INSERT gap): a duplicate live name inserts no row → friendly 409. Soft-deleted
    // names are excluded by the index predicate, so a deleted agent's name can be reused.
    const [agent] = await db.insert(schema.agents).values({
      serverId, name: b.name, displayName: b.displayName || b.name, description: b.description ?? null,
      model: b.model || null, runtime: b.runtime || "claude", machineId: b.machineId, projectPath: resolvedProject.projectPath,
      runtimeConfig: { provider: b.provider ?? "default", model: b.model ?? null, reasoningEffort: b.reasoning ?? null, mode: b.fastMode ? "fast" : "default" },
      envVars: b.envVars ?? {}, executionMode: b.fastMode ? "fast" : "auto", creatorType: "user", creatorId: userId,
    }).onConflictDoNothing({ target: [schema.agents.serverId, schema.agents.name], where: isNull(schema.agents.deletedAt) }).returning();
    if (!agent) return (sendErr(res, 409, `an agent named "${b.name}" already exists`), true);
    const all = (await db.select().from(schema.channels).where(and(eq(schema.channels.serverId, serverId), eq(schema.channels.name, "all"))))[0];
    // Join #all at the channel watermark, NOT lastReadSeq=0 — a newly created agent must not have its first
    // `message check` flooded with the channel's entire pre-existing history (it only needs messages from now on).
    if (all) await addChannelMembers(all.id, [{ type: "agent", id: agent!.id }]);
    await publish(serverId, { type: "agent:created", agent: { id: agent!.id, name: agent!.name, displayName: agent!.displayName, description: agent!.description, status: agent!.status, activity: agent!.activity, model: agent!.model, runtime: agent!.runtime, machineId: agent!.machineId } });
    // Start immediately on create: the client only POSTs /agents (no separate start call); the "start after create" logic lives in the backend. If no daemon is online startAgent returns ok:false and does not block creation. A successful startAgent calls publishAgentState to push status to active.
    const started = await startAgent(serverId, agent!.id);
    return (sendJson(res, 200, { id: agent!.id, name: agent!.name, started: started.ok }), true);
  }
  const am = /^\/api\/agents\/([^/]+)$/.exec(p);
  if (am && !isUuid(am[1]!)) return (sendErr(res, 404, "agent not found"), true); // covers GET/PATCH/DELETE — non-uuid would throw casting into the uuid column
  if (am && method === "GET") {
    const a = (await db.select().from(schema.agents).where(and(eq(schema.agents.id, am[1]!), eq(schema.agents.serverId, serverId))))[0];
    if (!a) return (sendErr(res, 404, "agent not found"), true);
    const canManage = await requireCap(serverId, userId, "manageAgents");
    return (sendJson(res, 200, {
      id: a.id, name: a.name, displayName: a.displayName, avatarUrl: a.avatarUrl, description: a.description,
      status: a.status, activity: a.activity, sessionId: a.sessionId, model: a.model, runtime: a.runtime,
      runtimeConfig: a.runtimeConfig, executionMode: a.executionMode, machineId: a.machineId,
      creatorType: a.creatorType, creatorId: a.creatorId, createdAt: a.createdAt,
      projectBound: Boolean(a.projectPath),
      projectPath: canManage ? a.projectPath : null,
    }), true);
  }
  if (am && method === "PATCH") {
    if (!await requireCap(serverId, userId, "manageAgents")) return (sendErr(res, 403, "need manageAgents capability"), true);
    const b = await readJson(req); const patch: Record<string, unknown> = {};
    if (descTooLong(b.description)) return (sendErr(res, 400, DESC_TOO_LONG), true);
    const current = (await db.select().from(schema.agents).where(and(eq(schema.agents.id, am[1]!), eq(schema.agents.serverId, serverId), isNull(schema.agents.deletedAt))))[0];
    if (!current) return (sendErr(res, 404, "agent not found"), true);
    for (const k of ["displayName", "description", "model", "runtime", "avatarUrl"]) if (b[k] !== undefined) patch[k] = b[k];
    if (b.envVars !== undefined) patch.envVars = b.envVars;
    let projectPathChanged = false;
    if (b.projectPath !== undefined) {
      if (current.status !== "inactive") return (sendErr(res, 409, "stop the agent before changing its project directory"), true);
      if (!current.machineId) return (sendErr(res, 409, "agent must be bound to a machine before setting a project directory"), true);
      const resolvedProject = await canonicalProjectPath(serverId, current.machineId, b.projectPath);
      if ("error" in resolvedProject) return (sendErr(res, resolvedProject.status, resolvedProject.error), true);
      projectPathChanged = resolvedProject.projectPath !== current.projectPath;
      patch.projectPath = resolvedProject.projectPath;
      if (projectPathChanged) patch.sessionId = null;
    }
    const [updated] = await db.update(schema.agents).set(patch)
      .where(and(eq(schema.agents.id, am[1]!), eq(schema.agents.serverId, serverId), ...(b.projectPath !== undefined ? [eq(schema.agents.status, "inactive")] : [])))
      .returning();
    if (!updated) return (sendErr(res, 409, "agent state changed; stop it before changing its project directory"), true);
    // Title/role changed → push the current profile to the daemon so it syncs the workspace MEMORY.md.
    if (patch.displayName !== undefined || patch.description !== undefined) {
      await syncAgentProfile(serverId, am[1]!, updated.displayName, updated.description);
    }
    return (sendJson(res, 200, { ok: true, projectPath: updated.projectPath, sessionCleared: projectPathChanged }), true);
  }
  if (am && method === "DELETE") {
    if (!await requireCap(serverId, userId, "manageAgents")) return (sendErr(res, 403, "need manageAgents capability"), true);
    const current = (await db.select().from(schema.agents).where(and(
      eq(schema.agents.id, am[1]!), eq(schema.agents.serverId, serverId), isNull(schema.agents.deletedAt),
    )))[0];
    if (!current) return (sendErr(res, 404, "agent not found"), true);
    // A project-bound process can keep modifying an operator-owned repository after its machine
    // disconnects. Never hide/revoke the agent until its daemon has confirmed stop, even when the
    // DB status looks inactive (that status can be stale after a network partition).
    const mustConfirmStopped = Boolean(current.projectPath) || ["starting", "active", "queued"].includes(current.status);
    if (mustConfirmStopped) {
      const stopped = await stopAgent(serverId, am[1]!);
      if (!stopped.ok) return (sendErr(res, 503, `cannot safely delete before stop: ${stopped.reason ?? "stop not confirmed"}`), true);
    }
    await db.delete(schema.channelMembers).where(and(eq(schema.channelMembers.memberType, "agent"), eq(schema.channelMembers.memberId, am[1]!)));
    await db.update(schema.agents).set({ deletedAt: new Date(), status: "inactive", activity: "offline", agentTokenHash: null }).where(and(eq(schema.agents.id, am[1]!), eq(schema.agents.serverId, serverId))); // soft delete: row is kept so historical messages/DM names remain resolvable by id, no orphans; clear the token hash so a still-running deleted agent can no longer authenticate (C4, with resolveAgent's deletedAt filter)
    await publish(serverId, { type: "agent:deleted", id: am[1]! });
    return (sendJson(res, 200, { ok: true }), true);
  }
  // Agent lifecycle: start / stop / reset
  const alc = /^\/api\/agents\/([^/]+)\/(start|stop|reset|restart)$/.exec(p);
  if (alc && !isUuid(alc[1]!)) return (sendErr(res, 404, "agent not found"), true);
  if (alc && method === "POST") {
    if (!await requireCap(serverId, userId, "manageAgents")) return (sendErr(res, 403, "need manageAgents capability"), true);
    const [, agId, action] = alc;
    if (action === "start") { const r = await startAgent(serverId, agId!); return (r.ok ? sendJson(res, 200, { ok: true }) : sendErr(res, 503, r.reason ?? "cannot start")), true; }
    if (action === "stop") { const r = await stopAgent(serverId, agId!); return (r.ok ? sendJson(res, 200, { ok: true }) : sendErr(res, 503, r.reason ?? "cannot stop")), true; }
    if (action === "restart") {
      const stopped = await stopAgent(serverId, agId!);
      if (!stopped.ok) return (sendErr(res, 503, stopped.reason ?? "cannot stop"), true);
      const started = await startAgent(serverId, agId!);
      return (started.ok ? sendJson(res, 200, { ok: true }) : sendErr(res, 503, started.reason ?? "cannot start")), true;
    } // preserves session and workspace; restarts only the process
    const b = await readJson(req).catch(() => ({}));
    const reset = await resetAgent(serverId, agId!, !!b?.wipeWorkspace, !!b?.clearMemory);
    if (!reset.ok) return (sendErr(res, 503, reset.reason ?? "cannot reset"), true);
    if (b?.restart) {
      const started = await startAgent(serverId, agId!);
      if (!started.ok) return (sendErr(res, 503, started.reason ?? "cannot start"), true);
    }
    return (sendJson(res, 200, { ok: true }), true);
  }
  // Dequeue: cancel a queued start (separate from lifecycle — not a running-agent action)
  const adq = /^\/api\/agents\/([^/]+)\/dequeue$/.exec(p);
  if (adq && method === "POST") {
    if (!await requireCap(serverId, userId, "manageAgents")) return (sendErr(res, 403, "need manageAgents capability"), true);
    const agId = adq[1]!;
    const a = (await db.select().from(schema.agents).where(and(eq(schema.agents.id, agId), eq(schema.agents.serverId, serverId))))[0];
    if (!a) return (sendErr(res, 404, "agent not found"), true);
    await dequeueAgent(serverId, agId);
    return (sendJson(res, 200, { ok: true }), true);
  }
  // Agent workspace file browser (reads local disk via daemon WS-RPC)
  const awsList = /^\/api\/agents\/([^/]+)\/workspace-files$/.exec(p);
  const awsFile = /^\/api\/agents\/([^/]+)\/workspace-files\/read$/.exec(p);
  if ((awsList || awsFile) && !isUuid((awsList || awsFile)![1]!)) return (sendErr(res, 404, "agent not found"), true);
  if ((awsList || awsFile) && method === "GET") {
    if (!await requireCap(serverId, userId, "manageAgents")) return (sendErr(res, 403, "need manageAgents capability"), true); // reading an agent's workspace (source / secrets / MEMORY.md) is owner/admin-only
    const agId = (awsList || awsFile)![1]!;
    const a = (await db.select().from(schema.agents).where(and(eq(schema.agents.id, agId), eq(schema.agents.serverId, serverId))))[0];
    if (!a) return (sendErr(res, 404, "agent not found"), true);
    if (awsList) {
      const r = await requestAgentDaemon(a, { type: "agent:workspace:list", agentId: agId });
      return (sendJson(res, 200, r.error ? { error: r.error } : { files: r.files ?? [], root: r.root }), true);
    }
    const r = await requestAgentDaemon(a, { type: "agent:workspace:read", agentId: agId, path: url.searchParams.get("path") ?? "" });
    return (sendJson(res, 200, r.error ? { error: r.error } : { path: r.path, content: r.content }), true);
  }
  // Personality/skills files live on the agent's OWN machine (agents.machineId): route the RPC to that
  // machine's daemon instead of a serverId-wide broadcast, where any connected daemon answers first —
  // wrong disk on a multi-machine server, and a silent timeout when an outdated daemon swallows the type.
  // Agents without a machine binding (legacy rows, seed-dev's @dev-bot) keep the broadcast fallback.
  // Agent personality: read/write/delete personality.md via daemon workspace
  const aper = /^\/api\/agents\/([^/]+)\/personality$/.exec(p);
  if (aper && method === "GET") {
    if (!await requireCap(serverId, userId, "manageAgents")) return (sendErr(res, 403, "need manageAgents capability"), true);
    const agId = aper[1]!;
    const a = (await db.select().from(schema.agents).where(and(eq(schema.agents.id, agId), eq(schema.agents.serverId, serverId))))[0];
    if (!a) return (sendErr(res, 404, "agent not found"), true);
    const r = await requestAgentDaemon(a, { type: "agent:workspace:read", agentId: agId, path: "personality.md" });
    return (sendJson(res, 200, { content: r.content ?? "", error: r.error }), true);
  }
  if (aper && method === "PUT") {
    if (!await requireCap(serverId, userId, "manageAgents")) return (sendErr(res, 403, "need manageAgents capability"), true);
    const agId = aper[1]!;
    const a = (await db.select().from(schema.agents).where(and(eq(schema.agents.id, agId), eq(schema.agents.serverId, serverId))))[0];
    if (!a) return (sendErr(res, 404, "agent not found"), true);
    const b = await readJson(req);
    if (typeof b.content !== "string") return (sendErr(res, 400, "content required"), true);
    if (b.content.length > 50_000) return (sendErr(res, 413, "personality.md too large (max 50 KB)"), true);
    const r = await requestAgentDaemon(a, { type: "agent:workspace:write", agentId: agId, path: "personality.md", content: b.content });
    if (r.error) return (sendErr(res, 500, r.error), true);
    await syncAgentProfile(serverId, agId, a.displayName, a.description);
    return (sendJson(res, 200, { ok: true }), true);
  }
  if (aper && method === "DELETE") {
    if (!await requireCap(serverId, userId, "manageAgents")) return (sendErr(res, 403, "need manageAgents capability"), true);
    const agId = aper[1]!;
    const a = (await db.select().from(schema.agents).where(and(eq(schema.agents.id, agId), eq(schema.agents.serverId, serverId))))[0];
    if (!a) return (sendErr(res, 404, "agent not found"), true);
    const r = await requestAgentDaemon(a, { type: "agent:workspace:delete", agentId: agId, path: "personality.md" });
    if (r.error && !r.error.includes("ENOENT")) return (sendErr(res, 500, r.error), true);
    await syncAgentProfile(serverId, agId, a.displayName, a.description);
    return (sendJson(res, 200, { ok: true }), true);
  }
  // Agent activity log: chronological [{timestamp, entry}]
  const alog = /^\/api\/agents\/([^/]+)\/activity-log$/.exec(p);
  if (alog && !isUuid(alog[1]!)) return (sendErr(res, 404, "agent not found"), true);
  if (alog && method === "GET") {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
    const rows = await db.select().from(schema.agentActivityLog).where(and(eq(schema.agentActivityLog.agentId, alog[1]!), eq(schema.agentActivityLog.serverId, serverId))).orderBy(desc(schema.agentActivityLog.ts)).limit(limit); // serverId scope: never leak another tenant's agent activity by raw agentId
    return (sendJson(res, 200, rows.reverse().map((r) => ({ timestamp: r.ts, entry: { kind: r.kind === "tool" ? "tool_start" : r.kind, activity: r.activity, detail: r.detail, text: r.text, toolName: r.toolName, toolInput: r.toolInput } }))), true);
  }
  // ── Agent Permissions (scopes) ── GET to read / PUT to replace entirely. Default mode = grant all.
  const ascope = /^\/api\/agents\/([^/]+)\/scopes$/.exec(p);
  if (ascope && !isUuid(ascope[1]!)) return (sendErr(res, 404, "agent not found"), true);
  if (ascope && (method === "GET" || method === "PUT")) {
    const agId = ascope[1]!;
    const a = (await db.select().from(schema.agents).where(and(eq(schema.agents.id, agId), eq(schema.agents.serverId, serverId))))[0];
    if (!a) return (sendErr(res, 404, "agent not found"), true);
    if (method === "GET") { const eff = effectiveScopes(a.scopes); return (sendJson(res, 200, { agentId: agId, ...eff, catalog: SCOPES }), true); }
    if (!await requireCap(serverId, userId, "manageAgents")) return (sendErr(res, 403, "need manageAgents capability"), true); // changing an agent's permission scopes is owner/admin-only (reading is fine for members)
    const b = await readJson(req);
    if (!Array.isArray(b.scopes) || !b.scopes.every(isScopeLiteral)) return (sendErr(res, 400, "scopes must be an array of scope literals"), true);
    const granted = [...new Set(b.scopes as string[])].filter((s) => ALL_SCOPE_KEYS.includes(s));
    const next = { granted, mode: "custom" as const, revision: (a.scopes?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
    await db.update(schema.agents).set({ scopes: next }).where(eq(schema.agents.id, agId));
    return (sendJson(res, 200, { agentId: agId, ...next }), true);
  }
  // Agent Skills (used by Profile tab): daemon reads the runtime's own skills dir on the machine
  // (claude → ~/.claude/skills, codex → ~/.codex/skills, …) + the matching dir in the workspace.
  const askill = /^\/api\/agents\/([^/]+)\/skills$/.exec(p);
  if (askill && !isUuid(askill[1]!)) return (sendErr(res, 404, "agent not found"), true);
  if (askill && method === "GET") {
    const a = (await db.select().from(schema.agents).where(and(eq(schema.agents.id, askill[1]!), eq(schema.agents.serverId, serverId))))[0];
    if (!a) return (sendErr(res, 404, "agent not found"), true);
    if (a.projectPath && !await requireCap(serverId, userId, "manageAgents")) {
      return (sendErr(res, 403, "need manageAgents capability to inspect project-local skills"), true);
    }
    try { const r = await requestAgentDaemon(a, { type: "agent:skills:list", agentId: askill[1]!, runtime: a.runtime, projectPath: a.projectPath }); return (sendJson(res, 200, { global: r.global ?? [], workspace: r.workspace ?? [] }), true); }
    catch { return (sendJson(res, 200, { global: [], workspace: [] }), true); }
  }
  // Agent Skills write/delete (upload/remove SKILL.md in the workspace <runtime>/skills/ dir)
  const askillOp = /^\/api\/agents\/([^/]+)\/skills\/([^/]+)$/.exec(p);
  if (askillOp && (method === "PUT" || method === "DELETE")) {
    if (!await requireCap(serverId, userId, "manageAgents")) return (sendErr(res, 403, "need manageAgents capability"), true);
    const agId = askillOp[1]!; const skillName = askillOp[2]!;
    const a = (await db.select().from(schema.agents).where(and(eq(schema.agents.id, agId), eq(schema.agents.serverId, serverId))))[0];
    if (!a) return (sendErr(res, 404, "agent not found"), true);
    if (a.projectPath) return (sendErr(res, 409, "project-local skills are read-only; manage them in the bound project"), true);
    const wsName = ({ claude: ".claude", codex: ".codex", copilot: ".copilot", hermes: ".hermes", kimi: ".skills", opencode: ".opencode", cursor: ".cursor", pi: ".pi", reasonix: ".reasonix" } as Record<string, string>)[a.runtime] || ".claude";
    const relPath = `${wsName}${a.runtime === "kimi" ? "" : "/skills"}/${skillName}/SKILL.md`;
    if (method === "PUT") {
      const b = await readJson(req);
      if (typeof b.content !== "string") return (sendErr(res, 400, "content required"), true);
      const r = await requestAgentDaemon(a, { type: "agent:workspace:write", agentId: agId, path: relPath, content: b.content });
      if (r.error) return (sendErr(res, 500, r.error), true);
    } else {
      const r = await requestAgentDaemon(a, { type: "agent:workspace:delete", agentId: agId, path: relPath });
      if (r.error) return (sendErr(res, 500, r.error), true);
    }
    return (sendJson(res, 200, { ok: true }), true);
  }
  // Apps tab (connected third-party integrations): no integrations implemented yet, returns empty array
  const aint = /^\/api\/integrations\/agents\/([^/]+)$/.exec(p);
  if (aint && method === "GET") return (sendJson(res, 200, []), true);
  // Agent DMs tab: derived from channels (DMs where this agent participates and the peer is also an agent)
  const adms = /^\/api\/agents\/([^/]+)\/agent-dms$/.exec(p);
  if (adms && !isUuid(adms[1]!)) return (sendErr(res, 404, "agent not found"), true);
  if (adms && method === "GET") {
    const agId = adms[1]!;
    // serverId scope: confirm the agent belongs to this tenant before fanning out over its memberships
    // (the inner channel query already filters by serverId, but pre-checking 404s a foreign agent id and
    // avoids a cross-tenant channel_members scan). Mirrors the workspace-files / scopes ownership pre-check.
    const own = (await db.select({ id: schema.agents.id }).from(schema.agents).where(and(eq(schema.agents.id, agId), eq(schema.agents.serverId, serverId))))[0];
    if (!own) return (sendErr(res, 404, "agent not found"), true);
    const mine = await db.select().from(schema.channelMembers).where(and(eq(schema.channelMembers.memberType, "agent"), eq(schema.channelMembers.memberId, agId)));
    const out: any[] = [];
    for (const cm of mine) {
      const ch = (await db.select().from(schema.channels).where(and(eq(schema.channels.id, cm.channelId), eq(schema.channels.type, "dm"), eq(schema.channels.serverId, serverId))))[0]; // serverId scope: don't surface another tenant's DM channels for this agent id
      if (!ch) continue;
      const peers = (await db.select().from(schema.channelMembers).where(eq(schema.channelMembers.channelId, ch.id))).filter((m) => !(m.memberType === "agent" && m.memberId === agId));
      const peer = peers.find((m) => m.memberType === "agent"); // only include agent↔agent DMs
      if (!peer) continue;
      const pa = (await db.select().from(schema.agents).where(eq(schema.agents.id, peer.memberId)))[0];
      out.push({ id: ch.id, name: pa?.name ?? "agent", peerId: peer.memberId, peerType: "agent", lastMessageAt: ch.lastMessageAt });
    }
    return (sendJson(res, 200, out), true);
  }
  return false;
}

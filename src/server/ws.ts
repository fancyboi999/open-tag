// daemon control plane: WS /daemon/connect?key= (ServerToMachine / MachineToServer)
import { WebSocketServer, type WebSocket } from "ws";
import type { Server } from "node:http";
import { and, desc, eq, notInArray } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { BOOTSTRAP_KEY, hashToken } from "./auth.js";
import { registerDaemon, unregisterDaemon, resolveDaemonRequest } from "./daemonHub.js";
import { publish } from "./realtime.js";
import { createLogger } from "../log.js";
import { MACHINE_REJECTED_CODE } from "../daemonProtocol.js";

const log = createLogger("server:ws");

export function attachWs(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "", "http://localhost");
    if (url.pathname !== "/daemon/connect") return; // pass through: /socket.io/ etc. are handled by socket.io's own upgrade handler
    const key = url.searchParams.get("key");
    if (!key) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, (ws) => void onDaemon(ws, key));
  });
}

async function onDaemon(ws: WebSocket, key: string): Promise<void> {
  let serverId: string | null = null;
  let machineId: string | null = null;
  if (key === BOOTSTRAP_KEY) {
    serverId = (await db.select().from(schema.servers).where(eq(schema.servers.slug, "open-tag")))[0]?.id ?? null;
  } else {
    serverId = (await db.select().from(schema.machines).where(eq(schema.machines.apiKeyHash, hashToken(key))))[0]?.serverId ?? null;
  }
  if (!serverId) {
    // A missing sk_machine_* row is a permanent rejection (key deleted or never existed) → signal the daemon
    // to stop hammering and tell its operator. A missing bootstrap server row is a not-yet-seeded race, so a
    // plain close lets the daemon retry on its normal backoff once seeding completes.
    if (key !== BOOTSTRAP_KEY) ws.close(MACHINE_REJECTED_CODE, "unknown or removed machine key");
    else ws.close();
    return;
  }
  registerDaemon(ws, serverId); // register by serverId → broadcastToDaemons only reaches this server's daemons (multi-tenant isolation, routed by connection)
  log.info("daemon connected", { serverId });
  const ping = setInterval(() => { try { ws.send(JSON.stringify({ type: "ping" })); } catch { /* */ } }, 30000);

  ws.on("message", async (data) => {
    let msg: any; try { msg = JSON.parse(data.toString()); } catch { return; }
    try {
      if (msg.type === "ready") { machineId = await onReady(serverId!, key, msg); try { ws.send(JSON.stringify({ type: "ready:ack", machineId })); } catch { /* */ } }
      else if (msg.type === "agent:status" || msg.type === "agent:activity") await onAgentUpdate(serverId!, msg);
      else if (msg.type === "agent:session" && msg.agentId) { await db.update(schema.agents).set({ sessionId: msg.sessionId }).where(eq(schema.agents.id, msg.agentId)); await publish(serverId!, { type: "agent:session", agentId: msg.agentId, sessionId: msg.sessionId }); } // forward to the frontend
      else if (msg.type === "agent:trajectory" && msg.agentId) {
        const a = (await db.select().from(schema.agents).where(eq(schema.agents.id, msg.agentId)))[0];
        await publish(serverId!, { type: "trajectory", agentId: msg.agentId, name: a?.name, entries: msg.entries ?? [] });
        for (const e of msg.entries ?? []) await logActivity(serverId!, msg.agentId, e); // persist to the activity log
      }
      else if (msg.type === "pong" && machineId) {
        // Heartbeat: the daemon replies pong to our 30s ping. Keep lastHeartbeat fresh so the
        // liveness sweeper never offlines a live machine; if the sweeper raced ahead and offlined
        // us (e.g. a transient DB error aged the heartbeat), flip back online — the link is clearly up.
        const prev = (await db.select({ status: schema.machines.status }).from(schema.machines).where(eq(schema.machines.id, machineId)))[0];
        await db.update(schema.machines).set({ lastHeartbeat: new Date(), status: "online" }).where(eq(schema.machines.id, machineId));
        if (prev && prev.status !== "online") await publish(serverId!, { type: "machine", online: true, machineId });
      }
      else if ((msg.type === "workspace:file_tree" || msg.type === "workspace:file_content" || msg.type === "skills:list") && msg.requestId) resolveDaemonRequest(msg.requestId, msg);
    } catch (e: any) { log.error("ws handler error", { type: msg?.type, detail: String(e?.message ?? e) }); }
  });
  ws.on("close", async () => {
    clearInterval(ping); unregisterDaemon(ws);
    // daemon disconnected → mark this machine offline (otherwise the list keeps showing it online)
    if (machineId) {
      await db.update(schema.machines).set({ status: "offline" }).where(eq(schema.machines.id, machineId)).catch(() => {});
      await publish(serverId!, { type: "machine", online: false, machineId });
    }
    log.info("daemon disconnected", { serverId, machineId });
  });
  ws.on("error", () => { /* close will follow */ });
}

async function onReady(serverId: string, key: string, msg: any): Promise<string> {
  const hostname = msg.hostname ?? "unknown";
  // "Connect a machine": the machine key pre-creates a row, claimed by apiKeyHash (keeps the user-chosen machine name).
  // The bootstrap key is shared by multiple machines, so apiKeyHash collides → prefer claiming by the daemon's persisted stable machineId (persisted via ready:ack),
  // falling back to hostname (os.hostname() flips between .local and IP on macOS, so it can't be the sole key, otherwise a restart spawns an orphan machine).
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let existing: typeof schema.machines.$inferSelect | undefined;
  if (key === BOOTSTRAP_KEY) {
    if (typeof msg.machineId === "string" && uuidRe.test(msg.machineId)) {
      existing = (await db.select().from(schema.machines).where(and(eq(schema.machines.serverId, serverId), eq(schema.machines.id, msg.machineId))))[0];
    }
    if (!existing) existing = (await db.select().from(schema.machines).where(and(eq(schema.machines.serverId, serverId), eq(schema.machines.name, hostname))))[0];
  } else {
    existing = (await db.select().from(schema.machines).where(eq(schema.machines.apiKeyHash, hashToken(key))))[0];
  }
  const vals = {
    serverId, name: existing?.name ?? hostname, hostname, os: msg.os ?? null, runtimes: (msg.runtimes ?? []) as string[],
    daemonVersion: msg.daemonVersion ?? null, status: "online", lastHeartbeat: new Date(),
    apiKeyHash: hashToken(key), apiKeyPrefix: key.slice(0, 14),
  };
  let machineId: string;
  if (existing) { await db.update(schema.machines).set(vals).where(eq(schema.machines.id, existing.id)); machineId = existing.id; }
  else {
    const owner = (await db.select().from(schema.servers).where(eq(schema.servers.id, serverId)))[0];
    const [ins] = await db.insert(schema.machines).values({ ...vals, userId: owner!.ownerId }).returning();
    machineId = ins!.id;
  }
  log.info("machine ready", { hostname, os: msg.os, runtimes: msg.runtimes ?? [], daemonVersion: msg.daemonVersion });
  await publish(serverId, { type: "machine", online: true, machineId, hostname, runtimes: msg.runtimes ?? [] }); // machineId in the machine:status payload
  // Stale-agent reconciliation: on (re)connect the daemon reports the agents it is actually running (ready.runningAgents). An agent marked active in the DB but absent from that list = process is dead
  // (the case where both server and daemon restarted) → set inactive, so the next spawn lets agentConfig re-mint the token normally (otherwise a stale active leaves agentToken undefined → agent 401).
  // When only the server restarts and the daemon stays alive → runningAgents includes the live agent → no false reset (keeps zero-desync).
  const runningIds: string[] = Array.isArray(msg.runningAgents) ? msg.runningAgents : [];
  const onMachine = await db.select().from(schema.agents).where(and(eq(schema.agents.machineId, machineId), eq(schema.agents.status, "active")));
  for (const a of onMachine) {
    if (runningIds.includes(a.id)) continue;
    await db.update(schema.agents).set({ status: "inactive", activity: "offline" }).where(eq(schema.agents.id, a.id));
    await publish(serverId, { type: "agent", id: a.id, name: a.name, status: "inactive", activity: "offline" });
    log.info("reconciled stale-active agent → inactive", { agentId: a.id, machineId });
  }
  return machineId;
}

async function onAgentUpdate(serverId: string, msg: any): Promise<void> {
  if (!msg.agentId) return;
  const patch: Record<string, unknown> = {};
  if (msg.type === "agent:status") patch.status = msg.status;
  if (msg.type === "agent:activity") patch.activity = msg.activity;
  await db.update(schema.agents).set(patch).where(eq(schema.agents.id, msg.agentId));
  const a = (await db.select().from(schema.agents).where(eq(schema.agents.id, msg.agentId)))[0];
  if (a) await publish(serverId, { type: "agent", id: a.id, name: a.name, status: a.status, activity: a.activity });
  if (msg.type === "agent:activity") await logActivity(serverId, msg.agentId, { kind: "status", activity: msg.activity, detail: msg.detail }); // status goes into the activity log
}

// Per-agent retention cap for the activity log. Agents stream trajectory entries continuously, so this
// table would otherwise grow unbounded; we keep only the newest ACTIVITY_LOG_CAP rows per agent (pruned on
// insert). The read endpoint (GET /api/agents/:id/activity-log) already caps at 200, so 500 leaves headroom.
// Trade-off (high-frequency inserts → a prune per insert) tracked in docs/tech-debt-tracker.md.
export const ACTIVITY_LOG_CAP = 500;

// Delete all but the newest ACTIVITY_LOG_CAP rows (by ts) for one agent. Uses the (agentId, ts) index.
export async function pruneAgentActivityLog(agentId: string): Promise<void> {
  const keep = db.select({ id: schema.agentActivityLog.id }).from(schema.agentActivityLog)
    .where(eq(schema.agentActivityLog.agentId, agentId)).orderBy(desc(schema.agentActivityLog.ts)).limit(ACTIVITY_LOG_CAP);
  await db.delete(schema.agentActivityLog).where(and(eq(schema.agentActivityLog.agentId, agentId), notInArray(schema.agentActivityLog.id, keep)));
}

// Persist activity to the DB (daemon-pushed status/trajectory entries → agent_activity_log, feeds the activity facet history + timeline)
export async function logActivity(serverId: string, agentId: string, e: any): Promise<void> {
  const kind = e.kind === "tool" ? "tool_start" : (e.kind || (e.toolName ? "tool_start" : "text"));
  try {
    await db.insert(schema.agentActivityLog).values({
      serverId, agentId, ts: Date.now(), kind,
      activity: e.activity ?? null, detail: e.detail ?? null, text: e.text ?? null,
      toolName: e.toolName ?? null, toolInput: e.toolInput ?? null,
    });
    await pruneAgentActivityLog(agentId); // keep the table bounded per agent (newest ACTIVITY_LOG_CAP)
  } catch { /* logging failure must not block */ }
}

// Machine liveness reconciliation. The frontend shows a machine online/offline straight from
// machines.status (DB), which is only updated on the daemon WS connect/close. Two gaps that left
// stale "online" rows after the daemon was actually gone:
//   1. server restart — the fresh instance has zero daemons connected, but the DB still says online
//      until a daemon happens to reconnect (no WS close ever fired on the new process).
//   2. daemon killed / network partition without a clean WS close — close can lag well past reality.
// reconcileMachinesOnBoot fixes (1); the heartbeat sweeper fixes (2). Single-instance only (the
// in-memory daemonHub is the connection authority; one server process owns all daemons).
import { and, eq, lt, ne } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { publish } from "./realtime.js";
import { createLogger } from "../log.js";

const log = createLogger("server:liveness");
const SWEEP_MS = Number(process.env.OPEN_TAG_MACHINE_SWEEP_MS ?? 30_000);  // how often to scan for stale machines
const STALE_MS = Number(process.env.OPEN_TAG_MACHINE_STALE_MS ?? 90_000);  // > ping interval (30s) × ~2.5 so a live daemon (pong every ≤30s) never trips

/** On boot the in-memory daemonHub is empty — no daemon is connected to this fresh instance yet.
 *  Flip every "online" machine to "offline" so the frontend (which reads machines.status) doesn't
 *  show a stale online; daemons re-mark themselves online via onReady when they reconnect (seconds).
 *  Runs before the server starts listening, so it never races a freshly-connected daemon. */
export async function reconcileMachinesOnBoot(): Promise<number> {
  const flipped = await db.update(schema.machines).set({ status: "offline" })
    .where(eq(schema.machines.status, "online")).returning({ id: schema.machines.id });
  if (flipped.length) log.info("boot: machines marked offline pending daemon reconnect", { count: flipped.length });
  return flipped.length;
}

/** A known-current daemon connection closed, so the machine cannot currently run any agent.
 *  Unlike the stale sweeper, this path is immediate because a close from the current ws is authoritative.
 *  Keep sessionId intact; the next wake/reconnect can still resume. */
export async function markMachineAgentsOffline(machineId: string): Promise<number> {
  const rows = await db
    .select({ id: schema.agents.id, name: schema.agents.name, serverId: schema.agents.serverId })
    .from(schema.agents)
    .where(and(eq(schema.agents.machineId, machineId), ne(schema.agents.status, "inactive")));
  for (const a of rows) {
    await db.update(schema.agents).set({ status: "inactive", activity: "offline" }).where(eq(schema.agents.id, a.id));
    await publish(a.serverId, { type: "agent", id: a.id, name: a.name, status: "inactive", activity: "offline" });
  }
  if (rows.length) log.info("machine disconnect: agents → inactive", { machineId, count: rows.length });
  return rows.length;
}

/** When a machine is confirmed down — offline AND its lastHeartbeat is older than `cutoff` — none of its
 *  agents can be live, so force every still-live agent (status active OR sleeping) on it to inactive/offline
 *  and publish the change. The heartbeat gate is what keeps a brief WS blip (offline for a few seconds, then
 *  reconnects well within STALE_MS) from being mistaken for a dead host. `sessionId` is left intact so the
 *  next wake still --resumes. An idle agent sits in status="sleeping" (the daemon emits sleeping/sleeping on
 *  idle sleep), which the old active-only filter skipped — that is the bug this covers: a sleeping agent on a
 *  downed machine used to stay "sleeping" forever instead of showing offline. Returns the number flipped. */
export async function reconcileOfflineMachineAgents(cutoff: Date): Promise<number> {
  const rows = await db
    .select({ id: schema.agents.id, name: schema.agents.name, serverId: schema.machines.serverId })
    .from(schema.agents)
    .innerJoin(schema.machines, eq(schema.agents.machineId, schema.machines.id))
    .where(and(
      eq(schema.machines.status, "offline"),
      lt(schema.machines.lastHeartbeat, cutoff),
      ne(schema.agents.status, "inactive"),
    ));
  for (const a of rows) {
    await db.update(schema.agents).set({ status: "inactive", activity: "offline" }).where(eq(schema.agents.id, a.id));
    await publish(a.serverId, { type: "agent", id: a.id, name: a.name, status: "inactive", activity: "offline" });
  }
  if (rows.length) log.info("sweeper: offline-machine agents → inactive", { count: rows.length });
  return rows.length;
}

/** Backstop for daemons that died without a clean WS close: if a machine's lastHeartbeat is older than
 *  STALE_MS, mark it offline and notify the frontend. A live daemon bumps lastHeartbeat on every pong, so
 *  this never fires on a healthy connection. Then reconcile agents on every confirmed-down machine — both the
 *  ones just offlined here AND ones a clean ws-close already offlined (step 1 only looks at still-"online"
 *  rows, so it would never revisit a cleanly-closed machine to drag its agents offline). */
export function startMachineSweeper(): ReturnType<typeof setInterval> {
  const timer = setInterval(async () => {
    try {
      const cutoff = new Date(Date.now() - STALE_MS);
      const stale = await db.select().from(schema.machines)
        .where(and(eq(schema.machines.status, "online"), lt(schema.machines.lastHeartbeat, cutoff)));
      for (const m of stale) {
        await db.update(schema.machines).set({ status: "offline" }).where(eq(schema.machines.id, m.id));
        await publish(m.serverId, { type: "machine", online: false, machineId: m.id });
        log.info("sweeper: stale machine → offline", { machineId: m.id });
      }
      await reconcileOfflineMachineAgents(cutoff);
    } catch (e: any) { log.error("sweeper error", { detail: String(e?.message ?? e) }); }
  }, SWEEP_MS);
  timer.unref?.(); // don't keep the process alive solely for the sweeper
  return timer;
}

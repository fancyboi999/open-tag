// Machine liveness reconciliation. The frontend shows a machine online/offline straight from
// machines.status (DB), which is only updated on the daemon WS connect/close. Two gaps that left
// stale "online" rows after the daemon was actually gone:
//   1. server restart — the fresh instance has zero daemons connected, but the DB still says online
//      until a daemon happens to reconnect (no WS close ever fired on the new process).
//   2. daemon killed / network partition without a clean WS close — close can lag well past reality.
// reconcileMachinesOnBoot fixes (1); the heartbeat sweeper fixes (2). Single-instance only (the
// in-memory daemonHub is the connection authority; one server process owns all daemons).
import { and, eq, lt } from "drizzle-orm";
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

/** Backstop for daemons that died without a clean WS close: if a machine's lastHeartbeat is older than
 *  STALE_MS, mark it (and any agents still flagged "active" on it) offline and notify the frontend.
 *  A live daemon bumps lastHeartbeat on every pong, so this never fires on a healthy connection. */
export function startMachineSweeper(): ReturnType<typeof setInterval> {
  const timer = setInterval(async () => {
    try {
      const cutoff = new Date(Date.now() - STALE_MS);
      const stale = await db.select().from(schema.machines)
        .where(and(eq(schema.machines.status, "online"), lt(schema.machines.lastHeartbeat, cutoff)));
      for (const m of stale) {
        await db.update(schema.machines).set({ status: "offline" }).where(eq(schema.machines.id, m.id));
        await publish(m.serverId, { type: "machine", online: false, machineId: m.id });
        const agents = await db.select().from(schema.agents)
          .where(and(eq(schema.agents.machineId, m.id), eq(schema.agents.status, "active")));
        for (const a of agents) {
          await db.update(schema.agents).set({ status: "inactive", activity: "offline" }).where(eq(schema.agents.id, a.id));
          await publish(m.serverId, { type: "agent", id: a.id, name: a.name, status: "inactive", activity: "offline" });
        }
        log.info("sweeper: stale machine → offline", { machineId: m.id, staleAgents: agents.length });
      }
    } catch (e: any) { log.error("sweeper error", { detail: String(e?.message ?? e) }); }
  }, SWEEP_MS);
  timer.unref?.(); // don't keep the process alive solely for the sweeper
  return timer;
}

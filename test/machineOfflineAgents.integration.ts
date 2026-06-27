// Integration test: a machine going offline must drag its agents offline too — including idle-"sleeping" ones.
//
// Root cause (the bug this proves): when a machine goes offline, the liveness sweeper only reconciled agents
// whose status was "active" (`where status = 'active'`). An idle agent sits in status="sleeping" (the daemon
// emits sleeping/sleeping on idle sleep), so it was skipped and stayed "sleeping" forever in the DB even though
// its host machine is down. The UI faithfully renders that stale DB value → the agent shows a blue "sleeping"
// dot in the profile/DM while the machine is plainly offline.
//
// GOAL CONTRACT:
//   reconcileOfflineMachineAgents(cutoff) flips every NON-inactive agent (active OR sleeping) on a machine
//   that is BOTH offline AND stale (lastHeartbeat < cutoff) to status=inactive/activity=offline, leaving
//   sessionId intact (next wake still --resumes). Agents on an online machine, or on an offline-but-fresh
//   machine (a brief WS blip that will reconnect), are NOT touched.
//
//   BEFORE fix: A1 (sleeping on a down machine) stays "sleeping" → [A1] check FAILS (RED)
//   AFTER  fix: A1 becomes "inactive"/"offline"               → [A1] check PASSES (GREEN)
//
// Requires infra up: `npm run infra` (pg :5433, redis :6380) + `npm run db:push`.
// Run from the worktree root: npx tsx test/machineOfflineAgents.integration.ts
import "../src/env.js"; // load .env before any DB/redis import
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { reconcileOfflineMachineAgents } from "../src/server/machineLiveness.ts";

const ts = Date.now();
const STALE_MS = 90_000;
let failures = 0;
const check = (label: string, cond: boolean) => { console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`); if (!cond) failures++; };

const ids = {
  user: "", server: "",
  mOffStale: "", mOffFresh: "", mOnline: "",
  a1: "", a2: "", a3: "", a4: "", a5: "",
};

async function seed() {
  const [u] = await db.insert(schema.users).values({ name: `owner_${ts}`, displayName: "Owner", email: `owner_${ts}@t.dev` }).returning();
  ids.user = u!.id;
  const [s] = await db.insert(schema.servers).values({ name: "T", slug: `t_${ts}`, ownerId: u!.id }).returning();
  ids.server = s!.id;

  const mk = async (name: string, status: string, heartbeatAgoMs: number) => {
    const [m] = await db.insert(schema.machines).values({
      serverId: s!.id, userId: u!.id, name, apiKeyHash: `h_${name}_${ts}`, apiKeyPrefix: `sk_machine_${name}`.slice(0, 14),
      status, lastHeartbeat: new Date(ts - heartbeatAgoMs),
    }).returning();
    return m!.id;
  };
  ids.mOffStale = await mk(`off_stale_${ts}`, "offline", 120_000); // truly gone (offline + heartbeat 2min old)
  ids.mOffFresh = await mk(`off_fresh_${ts}`, "offline", 5_000);   // brief WS blip (offline but heartbeat 5s old → will reconnect)
  ids.mOnline = await mk(`online_${ts}`, "online", 1_000);         // live host

  const mkA = async (name: string, machineId: string, status: string, activity: string, sessionId: string | null) => {
    const [a] = await db.insert(schema.agents).values({
      serverId: s!.id, machineId, name: `${name}_${ts}`, displayName: name, status, activity, sessionId,
    }).returning();
    return a!.id;
  };
  ids.a1 = await mkA("a1_sleep_down", ids.mOffStale, "sleeping", "sleeping", "sess-A1"); // THE BUG: must flip → inactive/offline
  ids.a2 = await mkA("a2_active_down", ids.mOffStale, "active", "working", null);        // must flip → inactive/offline
  ids.a3 = await mkA("a3_inactive_down", ids.mOffStale, "inactive", "offline", null);    // already inactive → untouched (no spurious work)
  ids.a4 = await mkA("a4_sleep_online", ids.mOnline, "sleeping", "sleeping", "sess-A4"); // live host → stays sleeping (resumable)
  ids.a5 = await mkA("a5_sleep_blip", ids.mOffFresh, "sleeping", "sleeping", "sess-A5"); // blip → stays sleeping (don't offline a host that will reconnect)
}

async function cleanup() {
  await db.delete(schema.agents).where(eq(schema.agents.serverId, ids.server)).catch(() => {});
  await db.delete(schema.machines).where(eq(schema.machines.serverId, ids.server)).catch(() => {});
  await db.delete(schema.servers).where(eq(schema.servers.id, ids.server)).catch(() => {});
  await db.delete(schema.users).where(eq(schema.users.id, ids.user)).catch(() => {});
}

const get = async (id: string) => (await db.select().from(schema.agents).where(eq(schema.agents.id, id)))[0]!;

async function main() {
  await seed();
  const cutoff = new Date(ts - STALE_MS);
  const flipped = await reconcileOfflineMachineAgents(cutoff);

  const a1 = await get(ids.a1), a2 = await get(ids.a2), a3 = await get(ids.a3), a4 = await get(ids.a4), a5 = await get(ids.a5);

  console.log("\n[A1] idle-sleeping agent on a down machine → must go offline (the reported bug)");
  check("A1 status sleeping → inactive", a1.status === "inactive");
  check("A1 activity sleeping → offline", a1.activity === "offline");
  check("A1 sessionId preserved (wake still --resumes)", a1.sessionId === "sess-A1");

  console.log("\n[A2] active agent on a down machine → must go offline (existing behavior, kept)");
  check("A2 status active → inactive", a2.status === "inactive");
  check("A2 activity working → offline", a2.activity === "offline");

  console.log("\n[A3] already-inactive agent on a down machine → untouched");
  check("A3 stays inactive/offline", a3.status === "inactive" && a3.activity === "offline");

  console.log("\n[A4] sleeping agent on an ONLINE machine → stays sleeping (host is live, resumable)");
  check("A4 stays sleeping/sleeping", a4.status === "sleeping" && a4.activity === "sleeping");

  console.log("\n[A5] sleeping agent on an offline-but-FRESH machine (WS blip) → stays sleeping (will reconnect)");
  check("A5 stays sleeping/sleeping", a5.status === "sleeping" && a5.activity === "sleeping");

  console.log(`\n[count] reconcileOfflineMachineAgents returned ${flipped} (expect 2: A1 + A2)`);
  check("flipped count == 2", flipped === 2);
}

main()
  .then(cleanup)
  .then(() => { console.log(`\n${failures === 0 ? "ALL PASS ✅" : `${failures} CHECK(S) FAILED ❌`}`); process.exit(failures === 0 ? 0 : 1); })
  .catch(async (e) => { console.error("ERROR:", e); try { await cleanup(); } catch { /* */ } process.exit(1); });

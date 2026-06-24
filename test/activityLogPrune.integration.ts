// Real DB integration: agent_activity_log must stay bounded per agent. Trajectory entries stream
// continuously, so logActivity prunes to the newest ACTIVITY_LOG_CAP rows per agent on every insert —
// otherwise the table grows unbounded (see docs/tech-debt-tracker.md). Verifies the cap holds, the
// OLDEST rows are the ones dropped, and pruning is scoped to a single agent.
// Requires infra up: `npm run infra` (pg :5433, redis :6380) + `npm run db:push`.
// Run: npx tsx test/activityLogPrune.integration.ts
// (Use an isolated DB, e.g. DATABASE_URL=postgres://opentag:opentag@localhost:5433/opentag_test — never the live DB.)
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { pruneAgentActivityLog, logActivity, ACTIVITY_LOG_CAP } from "../src/server/ws.ts";

const ts = Date.now();
let serverId = "", ownerId = "", agentId = "", otherAgentId = "";
let failures = 0;
const check = (label: string, cond: boolean) => { console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`); if (!cond) failures++; };

const countFor = async (aid: string) =>
  (await db.select({ id: schema.agentActivityLog.id }).from(schema.agentActivityLog).where(eq(schema.agentActivityLog.agentId, aid))).length;
const tsRangeFor = async (aid: string) => {
  const rows = await db.select({ ts: schema.agentActivityLog.ts }).from(schema.agentActivityLog).where(eq(schema.agentActivityLog.agentId, aid));
  const vals = rows.map((r) => r.ts);
  return { min: Math.min(...vals), max: Math.max(...vals) };
};

async function setup() {
  const [u] = await db.insert(schema.users).values({ name: `owner_${ts}`, displayName: "Owner", email: `o_${ts}@t.local` }).returning();
  ownerId = u!.id;
  const [srv] = await db.insert(schema.servers).values({ name: "T", slug: `t-${ts}`, ownerId }).returning();
  serverId = srv!.id;
  const [ag] = await db.insert(schema.agents).values({ serverId, name: `agent_${ts}`, displayName: "Agent" }).returning();
  agentId = ag!.id;
  const [ag2] = await db.insert(schema.agents).values({ serverId, name: `agent2_${ts}`, displayName: "Agent2" }).returning();
  otherAgentId = ag2!.id;
}

async function cleanup() {
  await db.delete(schema.agentActivityLog).where(eq(schema.agentActivityLog.serverId, serverId));
  await db.delete(schema.agents).where(eq(schema.agents.serverId, serverId));
  await db.delete(schema.servers).where(eq(schema.servers.id, serverId));
  await db.delete(schema.users).where(eq(schema.users.id, ownerId));
}

async function main() {
  await setup();
  const OVER = ACTIVITY_LOG_CAP + 10; // 510

  console.log(`\n[1] prune trims ${OVER} rows down to the newest ${ACTIVITY_LOG_CAP}, dropping the oldest`);
  // Distinct, increasing ts so "newest kept / oldest dropped" is deterministic (ts = base + i).
  const base = ts;
  await db.insert(schema.agentActivityLog).values(
    Array.from({ length: OVER }, (_, i) => ({ serverId, agentId, ts: base + i, kind: "text" as const, text: `e${i}` }))
  );
  check(`inserted ${OVER} rows`, (await countFor(agentId)) === OVER);
  await pruneAgentActivityLog(agentId);
  check(`row count capped at ${ACTIVITY_LOG_CAP}`, (await countFor(agentId)) === ACTIVITY_LOG_CAP);
  const r = await tsRangeFor(agentId);
  check("oldest 10 rows were the ones dropped (min ts = base+10)", r.min === base + 10);
  check("newest row retained (max ts = base+509)", r.max === base + OVER - 1);

  console.log("\n[2] the insert path (logActivity) keeps the table bounded");
  for (let i = 0; i < 5; i++) await logActivity(serverId, agentId, { kind: "tool", toolName: "Read", toolInput: `f${i}` });
  check(`still capped at ${ACTIVITY_LOG_CAP} after 5 more logActivity inserts`, (await countFor(agentId)) === ACTIVITY_LOG_CAP);

  console.log("\n[3] pruning is scoped to a single agent (does not touch other agents)");
  await db.insert(schema.agentActivityLog).values(
    Array.from({ length: 20 }, (_, i) => ({ serverId, agentId: otherAgentId, ts: base + i, kind: "text" as const, text: `o${i}` }))
  );
  await pruneAgentActivityLog(agentId); // prune agent A again
  check("other agent's 20 rows untouched by A's prune", (await countFor(otherAgentId)) === 20);
}

main()
  .then(cleanup)
  .then(() => { console.log(`\n${failures === 0 ? "ALL PASS ✅" : `${failures} CHECK(S) FAILED ❌`}`); process.exit(failures === 0 ? 0 : 1); })
  .catch(async (e) => { console.error("ERROR:", e); try { await cleanup(); } catch { /* */ } process.exit(1); });

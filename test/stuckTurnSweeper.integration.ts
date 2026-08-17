// Real DB integration: a server restart can orphan a committed delivery admission —
// the row keeps delivery_admitted_at while no live process awaits the reply, so every
// later dispatch short-circuits "delivered" and the turn never reaches the agent
// (live 2026-08-16 18:20 stall). sweepOrphanedAgentDeliveries must release it and
// re-ready the turn; fresh admissions and in-process-owned deliveries stay untouched.
// Requires infra up: `npm run infra` (pg :5433, redis :6380). Run: npx tsx test/stuckTurnSweeper.integration.ts
import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { sweepOrphanedAgentDeliveries } from "../src/server/core.ts";

const ts = Date.now();
let serverId = "", ownerId = "", agentId = "", chId = "";
let orphanMsg = "", orphanTurn = "", freshMsg = "", freshTurn = "";
let unsupCh = "", unsupMsg = "", unsupTurn = "";
let failures = 0;
const check = (label: string, cond: boolean) => { console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`); if (!cond) failures++; };

async function seedTurn(tag: string, admittedAt: Date | null, channel: string = chId): Promise<{ msg: string; turn: string }> {
  const [m] = await db.insert(schema.messages).values({
    seq: 1, serverId, channelId: channel, senderType: "user", senderId: ownerId, senderName: "owner",
    content: `trigger ${tag}`, searchText: `trigger ${tag}`,
  }).returning();
  const rootId = crypto.randomUUID();
  const [t] = await db.insert(schema.conversationTurns).values({
    id: rootId, causalRootId: rootId,
    serverId, channelId: channel, senderType: "user", senderId: ownerId,
    anchorMessageId: m!.id, triggerMessageId: m!.id, latestMessageId: m!.id,
    firstSeq: 1, lastSeq: 1, state: "dispatched", dispatchAfter: new Date(Date.now() - 60_000),
  }).returning();
  await db.insert(schema.agentMessageDecisions).values({
    serverId, channelId: channel, messageId: m!.id, agentId, attention: "dm",
    ...(admittedAt ? { deliveryAdmittedAt: admittedAt } : {}),
  });
  return { msg: m!.id, turn: t!.id };
}

async function setup() {
  const [u] = await db.insert(schema.users).values({ name: `owner_${ts}`, displayName: "Owner", email: `o_${ts}@t.local` }).returning();
  ownerId = u!.id;
  const [srv] = await db.insert(schema.servers).values({ name: "T", slug: `t-${ts}`, ownerId }).returning();
  serverId = srv!.id;
  await db.insert(schema.serverMembers).values({ serverId, userId: ownerId, role: "owner" });
  const [ag] = await db.insert(schema.agents).values({ serverId, name: `stuck_${ts}`, displayName: "Stuck" }).returning();
  agentId = ag!.id;
  const [c] = await db.insert(schema.channels).values({ serverId, name: `stuck_${ts}`, type: "channel", supervised: true }).returning();
  chId = c!.id;
  const o = await seedTurn("orphan", new Date(Date.now() - 5 * 60_000));
  orphanMsg = o.msg; orphanTurn = o.turn;
  const f = await seedTurn("fresh", new Date());
  freshMsg = f.msg; freshTurn = f.turn;
  // Watchdog is opt-in: an identical orphan in an UNSUPERVISED channel must stay untouched.
  const [uc] = await db.insert(schema.channels).values({ serverId, name: `unsup_${ts}`, type: "channel" }).returning();
  unsupCh = uc!.id;
  const so = await seedTurn("unsupervised-orphan", new Date(Date.now() - 5 * 60_000), unsupCh);
  unsupMsg = so.msg; unsupTurn = so.turn;
}

async function cleanup() {
  await db.delete(schema.agentMessageDecisions).where(eq(schema.agentMessageDecisions.serverId, serverId));
  await db.delete(schema.conversationTurns).where(eq(schema.conversationTurns.serverId, serverId));
  await db.delete(schema.messages).where(eq(schema.messages.serverId, serverId));
  await db.delete(schema.channels).where(eq(schema.channels.serverId, serverId));
  await db.delete(schema.agents).where(eq(schema.agents.serverId, serverId));
  await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, serverId));
  await db.delete(schema.servers).where(eq(schema.servers.id, serverId));
  await db.delete(schema.users).where(eq(schema.users.id, ownerId));
}

async function main() {
  await setup();
  const n = await sweepOrphanedAgentDeliveries();
  // The sweeper is global by design (all servers); the shared dev DB may hold orphans from
  // other test runs, so assert >=1 here and exactness via the per-row checks below.
  check(`sweep recovers the orphaned delivery (n=${n})`, n >= 1);

  const [od] = await db.select().from(schema.agentMessageDecisions).where(and(eq(schema.agentMessageDecisions.messageId, orphanMsg), eq(schema.agentMessageDecisions.agentId, agentId)));
  check("orphan admission released", od!.deliveryAdmittedAt === null);
  const [ot] = await db.select().from(schema.conversationTurns).where(eq(schema.conversationTurns.id, orphanTurn));
  check("orphan turn re-ready for redelivery", ot!.state === "ready");

  const [fd] = await db.select().from(schema.agentMessageDecisions).where(and(eq(schema.agentMessageDecisions.messageId, freshMsg), eq(schema.agentMessageDecisions.agentId, agentId)));
  check("fresh admission untouched", fd!.deliveryAdmittedAt !== null);
  const [ft] = await db.select().from(schema.conversationTurns).where(eq(schema.conversationTurns.id, freshTurn));
  check("fresh turn state untouched", ft!.state === "dispatched");

  const notice = await db.select().from(schema.messages).where(and(eq(schema.messages.channelId, chId), eq(schema.messages.messageType, "system")));
  check("recovery posts a visible supervisor notice", notice.length === 1 && notice[0]!.content.includes("🛠"));

  const [ud] = await db.select().from(schema.agentMessageDecisions).where(and(eq(schema.agentMessageDecisions.messageId, unsupMsg), eq(schema.agentMessageDecisions.agentId, agentId)));
  check("unsupervised channel orphan left untouched (opt-in)", ud!.deliveryAdmittedAt !== null);
  const [ut] = await db.select().from(schema.conversationTurns).where(eq(schema.conversationTurns.id, unsupTurn));
  check("unsupervised turn still dispatched", ut!.state === "dispatched");

  // Second stall of the SAME turn (delivered but agent never answered): the sweeper must NOT
  // recover/notify again — it escalates once to blocked + ⛔ and stops (live 2026-08-17 flood).
  await db.update(schema.agentMessageDecisions).set({ deliveryAdmittedAt: new Date(Date.now() - 5 * 60_000) })
    .where(and(eq(schema.agentMessageDecisions.messageId, orphanMsg), eq(schema.agentMessageDecisions.agentId, agentId)));
  await db.update(schema.conversationTurns).set({ state: "dispatched" }).where(eq(schema.conversationTurns.id, orphanTurn));
  await sweepOrphanedAgentDeliveries();
  const [ot2] = await db.select().from(schema.conversationTurns).where(eq(schema.conversationTurns.id, orphanTurn));
  check("re-stalled turn escalates to blocked instead of looping", ot2!.state === "blocked");
  const sys = await db.select().from(schema.messages).where(and(eq(schema.messages.channelId, chId), eq(schema.messages.messageType, "system")));
  check("stale 🛠 auto-cleaned, single ⛔ remains", sys.filter((s) => s.content.includes("🛠")).length === 0 && sys.filter((s) => s.content.includes("⛔")).length === 1);

  // A blocked turn is never swept again.
  const n2 = await sweepOrphanedAgentDeliveries();
  const sys2 = await db.select().from(schema.messages).where(and(eq(schema.messages.channelId, chId), eq(schema.messages.messageType, "system")));
  check("blocked turn stays silent on later sweeps", sys2.length === sys.length && n2 >= 0);
}

main()
  .then(cleanup)
  .then(() => {
    if (failures > 0) {
      console.log(`\n${failures} CHECK(S) FAILED ❌`);
    } else {
      console.log("\nALL PASS ✅");
    }
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (e) => { console.error("ERROR:", e); try { await cleanup(); } catch { /**/ } process.exit(1); });

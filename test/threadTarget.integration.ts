// Real DB integration: resolveTarget must REJECT threading onto a SYSTEM message.
// A target like #channel:<shortid> that resolved to a system message ("X created task / claimed / moved …")
// used to silently create a thread hanging off it. System messages render with no "open thread" affordance,
// so the reply became UNREACHABLE in the UI (delivered + persisted, but invisible). resolveTarget now returns
// null for a system parent so the caller (/agent-api/message/send) surfaces TARGET_FAILED instead of burying it.
// Requires infra up: `npm run infra` (pg :5433, redis :6380). Run: npx tsx test/threadTarget.integration.ts
import { and, eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { createMessage, resolveTarget } from "../src/server/core.ts";

const ts = Date.now();
const chName = `tt-${ts}`;
let serverId = "", ownerId = "", agentId = "";
let failures = 0;
const check = (label: string, cond: boolean) => { console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`); if (!cond) failures++; };

async function setup() {
  const [u] = await db.insert(schema.users).values({ name: `owner_${ts}`, displayName: "Owner", email: `o_${ts}@t.local` }).returning();
  ownerId = u!.id;
  const [srv] = await db.insert(schema.servers).values({ name: "T", slug: `t-${ts}`, ownerId }).returning();
  serverId = srv!.id;
  await db.insert(schema.serverMembers).values({ serverId, userId: ownerId, role: "owner" });
  const [ag] = await db.insert(schema.agents).values({ serverId, name: `agent_${ts}`, displayName: "Agent" }).returning();
  agentId = ag!.id;
  const [c] = await db.insert(schema.channels).values({ serverId, name: chName, type: "channel" }).returning();
  await db.insert(schema.channelMembers).values({ channelId: c!.id, memberType: "user", memberId: ownerId });
}

async function cleanup() {
  // FK-safe order, scoped to this run's server only (covers threads created dynamically by resolveTarget)
  const chans = await db.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.serverId, serverId));
  const msgs = await db.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.serverId, serverId));
  for (const m of msgs) await db.delete(schema.messageMentions).where(eq(schema.messageMentions.messageId, m.id));
  await db.delete(schema.messages).where(eq(schema.messages.serverId, serverId));
  for (const c of chans) await db.delete(schema.channelMembers).where(eq(schema.channelMembers.channelId, c.id));
  await db.delete(schema.channels).where(eq(schema.channels.serverId, serverId));
  await db.delete(schema.agents).where(eq(schema.agents.serverId, serverId));
  await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, serverId));
  await db.delete(schema.servers).where(eq(schema.servers.id, serverId));
  await db.delete(schema.users).where(eq(schema.users.id, ownerId));
}

async function main() {
  await setup();
  const real = await createMessage({ serverId, channelId: (await chan()).id, senderType: "user", senderId: ownerId, senderName: "owner", content: "real parent message" });
  const sys = await createMessage({ serverId, channelId: (await chan()).id, senderType: "system", senderId: null, senderName: "system", messageType: "system", content: "owner created task #1" });

  console.log("\n[1] threading onto a REAL (user/agent) message still works");
  const ok = await resolveTarget(serverId, `#${chName}:${real.id.slice(0, 8)}`, agentId);
  check("resolveTarget returns a thread channel for a real message", !!ok && typeof ok.channelId === "string");

  console.log("\n[2] threading onto a SYSTEM message is rejected (no unreachable thread)");
  const bad = await resolveTarget(serverId, `#${chName}:${sys.id.slice(0, 8)}`, agentId);
  check("resolveTarget returns null for a system message", bad === null);
  const orphan = await db.select().from(schema.channels).where(and(eq(schema.channels.serverId, serverId), eq(schema.channels.parentMessageId, sys.id)));
  check("no thread channel was created off the system message", orphan.length === 0);
}

async function chan() {
  return (await db.select().from(schema.channels).where(and(eq(schema.channels.serverId, serverId), eq(schema.channels.name, chName))))[0]!;
}

main()
  .then(cleanup)
  .then(() => { console.log(`\n${failures === 0 ? "ALL PASS ✅" : `${failures} CHECK(S) FAILED ❌`}`); process.exit(failures === 0 ? 0 : 1); })
  .catch(async (e) => { console.error("ERROR:", e); try { await cleanup(); } catch { /* */ } process.exit(1); });

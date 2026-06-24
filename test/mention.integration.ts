// Real end-to-end verification of Slack-style mention auto-join against the running Postgres + Redis.
// Requires infra up: `npm run infra` (pg :5433, redis :6380). Run: npx tsx test/mention.integration.ts
// Creates a fully isolated workspace, exercises the actual createMessage() path, asserts, then cleans up.
import { and, eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { createMessage, getOrCreateThread } from "../src/server/core.ts";

const ts = Date.now();
const owner = `owner_${ts}`, bob = `bob_${ts}`, ghost = `ghost_${ts}`;

let serverId = "", ownerId = "", bobId = "", ghostId = "";
let pubCh = "", privCh = "", dmCh = "";
let failures = 0;
const check = (label: string, cond: boolean) => { console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`); if (!cond) failures++; };

async function members(channelId: string) {
  return db.select().from(schema.channelMembers).where(eq(schema.channelMembers.channelId, channelId));
}
async function mentionsOf(messageId: string) {
  return db.select().from(schema.messageMentions).where(eq(schema.messageMentions.messageId, messageId));
}
const inChannel = (rows: any[], type: string, id: string) => rows.some((r) => r.memberType === type && r.memberId === id);
const mentioned = (rows: any[], type: string, id: string) => rows.some((r) => r.mentionType === type && r.mentionId === id);

async function setup() {
  const [u1] = await db.insert(schema.users).values({ name: owner, displayName: "Owner", email: `${owner}@t.local` }).returning();
  const [u2] = await db.insert(schema.users).values({ name: bob, displayName: "Bob", email: `${bob}@t.local` }).returning();
  ownerId = u1!.id; bobId = u2!.id;
  const [srv] = await db.insert(schema.servers).values({ name: "T", slug: `t-${ts}`, ownerId }).returning();
  serverId = srv!.id;
  await db.insert(schema.serverMembers).values([
    { serverId, userId: ownerId, role: "owner" },
    { serverId, userId: bobId, role: "member" },
  ]);
  const [ag] = await db.insert(schema.agents).values({ serverId, name: ghost, displayName: "Ghost" }).returning();
  ghostId = ag!.id;
  // Public channel: only the owner is a member (ghost + bob are workspace members but NOT in the channel)
  const [c1] = await db.insert(schema.channels).values({ serverId, name: `pub-${ts}`, type: "channel" }).returning();
  pubCh = c1!.id;
  await db.insert(schema.channelMembers).values({ channelId: pubCh, memberType: "user", memberId: ownerId });
  // Private channel: owner only
  const [c2] = await db.insert(schema.channels).values({ serverId, name: `priv-${ts}`, type: "private" }).returning();
  privCh = c2!.id;
  await db.insert(schema.channelMembers).values({ channelId: privCh, memberType: "user", memberId: ownerId });
  // DM channel: owner + ghost (two-party)
  const [c3] = await db.insert(schema.channels).values({ serverId, name: `dm-${ts}`, type: "dm" }).returning();
  dmCh = c3!.id;
  await db.insert(schema.channelMembers).values([
    { channelId: dmCh, memberType: "user", memberId: ownerId },
    { channelId: dmCh, memberType: "agent", memberId: ghostId },
  ]);
}

async function cleanup() {
  // FK-safe order, scoped to this run's rows only
  const msgs = await db.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.serverId, serverId));
  for (const m of msgs) await db.delete(schema.messageMentions).where(eq(schema.messageMentions.messageId, m.id));
  await db.delete(schema.messages).where(eq(schema.messages.serverId, serverId));
  // Delete members for EVERY channel of this run's server (covers the thread channels created dynamically in [5]/[6]).
  const chans = await db.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.serverId, serverId));
  for (const c of chans) await db.delete(schema.channelMembers).where(eq(schema.channelMembers.channelId, c.id));
  await db.delete(schema.channels).where(eq(schema.channels.serverId, serverId));
  await db.delete(schema.agents).where(eq(schema.agents.serverId, serverId));
  await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, serverId));
  await db.delete(schema.servers).where(eq(schema.servers.id, serverId));
  await db.delete(schema.users).where(eq(schema.users.id, ownerId));
  await db.delete(schema.users).where(eq(schema.users.id, bobId));
}

async function main() {
  await setup();

  console.log("\n[1] PUBLIC channel: owner @s a non-member agent and a non-member human");
  const m1 = await createMessage({ serverId, channelId: pubCh, senderType: "user", senderId: ownerId, senderName: owner, content: `@${ghost} 跑下数据 @${bob} 你也看下` });
  const pm = await members(pubCh), p1 = await mentionsOf(m1.id);
  check("non-member agent ghost auto-joined the channel", inChannel(pm, "agent", ghostId));
  check("non-member human bob auto-joined the channel", inChannel(pm, "user", bobId));
  check("mention to ghost is recorded (delivers/wakes — no longer silently dropped)", mentioned(p1, "agent", ghostId));
  check("mention to bob is recorded", mentioned(p1, "user", bobId));

  console.log("\n[2] PUBLIC channel: re-@ an existing member is idempotent (no duplicate rows)");
  const before = (await members(pubCh)).length;
  await createMessage({ serverId, channelId: pubCh, senderType: "user", senderId: ownerId, senderName: owner, content: `@${ghost} again` });
  check("member count unchanged on second mention", (await members(pubCh)).length === before);

  console.log("\n[3] PRIVATE channel: @ a non-member must NOT auto-join (no private-history leak)");
  const m3 = await createMessage({ serverId, channelId: privCh, senderType: "user", senderId: ownerId, senderName: owner, content: `@${ghost} secret stuff` });
  check("ghost NOT added to the private channel", !inChannel(await members(privCh), "agent", ghostId));
  check("no mention recorded in private channel (stays a no-op)", !mentioned(await mentionsOf(m3.id), "agent", ghostId));

  console.log("\n[4] DM channel: @ a third party must NOT auto-join (two-party semantics preserved)");
  const m4 = await createMessage({ serverId, channelId: dmCh, senderType: "user", senderId: ownerId, senderName: owner, content: `@${bob} look here` });
  check("bob NOT added to the DM", !inChannel(await members(dmCh), "user", bobId));
  check("no mention recorded for bob in DM", !mentioned(await mentionsOf(m4.id), "user", bobId));

  // A thread inherits its PARENT channel's @-reach (mentionAutoJoinPool) — the core of this fix. ghost is a
  // workspace member but NOT a member of the freshly-created thread, so before the fix the @ was dropped.
  console.log("\n[5] THREAD under a PUBLIC channel: @ a non-thread-member agent inherits the parent's workspace reach (auto-join + wake)");
  const parent5 = await createMessage({ serverId, channelId: pubCh, senderType: "user", senderId: ownerId, senderName: owner, content: "open a thread under the public channel" });
  const th5 = await getOrCreateThread(serverId, parent5.id, { type: "user", id: ownerId });
  const m5 = await createMessage({ serverId, channelId: th5.id, senderType: "user", senderId: ownerId, senderName: owner, content: `@${ghost} please pick up this thread` });
  check("non-member agent ghost auto-joined the THREAD (parent is public → workspace reach)", inChannel(await members(th5.id), "agent", ghostId));
  check("mention to ghost recorded in the thread (no longer silently dropped)", mentioned(await mentionsOf(m5.id), "agent", ghostId));

  console.log("\n[6] THREAD under a PRIVATE channel: @ a non-parent-member must NOT auto-join (inherits private reach — no leak)");
  const parent6 = await createMessage({ serverId, channelId: privCh, senderType: "user", senderId: ownerId, senderName: owner, content: "open a thread under the private channel" });
  const th6 = await getOrCreateThread(serverId, parent6.id, { type: "user", id: ownerId });
  const m6 = await createMessage({ serverId, channelId: th6.id, senderType: "user", senderId: ownerId, senderName: owner, content: `@${ghost} secret thread work` });
  check("ghost NOT added to the private-parent thread (no leak)", !inChannel(await members(th6.id), "agent", ghostId));
  check("no mention recorded in the private-parent thread (stays a no-op)", !mentioned(await mentionsOf(m6.id), "agent", ghostId));
}

main()
  .then(cleanup)
  .then(() => { console.log(`\n${failures === 0 ? "ALL PASS ✅" : `${failures} CHECK(S) FAILED ❌`}`); process.exit(failures === 0 ? 0 : 1); })
  .catch(async (e) => { console.error("ERROR:", e); try { await cleanup(); } catch { /* */ } process.exit(1); });

// Real end-to-end verification that an agent joining a channel with pre-existing history starts "caught up"
// at the channel watermark, instead of inheriting lastReadSeq=0 (which floods its first `message check` with
// every pre-join message). Requires infra up (pg :5433, redis :6380). Run: npx tsx test/agentJoinWatermark.integration.ts
//
// Covers two join paths:
//   A) @-mention auto-join (createMessage path) — watermark MUST exclude the triggering @ message, so the agent
//      still sees the @ that pulled it in, but not the channel's prior backlog.
//   B) direct add (addChannelMembers helper — the path agent-create→#all / CLI join / admin add-member share) —
//      watermark = the channel's current max seq, so zero pre-join backlog is unread.
// Also asserts forward delivery is intact (a message sent AFTER join is still counted unread) and that a USER
// joining is unaffected (lastReadSeq stays 0 — human UI unread behaviour unchanged).
import { and, eq, gt, ne, desc, or, isNull } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { createMessage, addChannelMembers } from "../src/server/core.ts";

const ts = Date.now();
const owner = `owner_${ts}`, ghostA = `ghostA_${ts}`, botB = `botB_${ts}`, userC = `userC_${ts}`;

let serverId = "", ownerId = "", ghostAId = "", botBId = "", userCId = "";
let chA = "", chB = "";
let failures = 0;
const check = (label: string, cond: boolean, detail = "") => { console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}${detail ? `  — ${detail}` : ""}`); if (!cond) failures++; };

async function memberRow(channelId: string, type: string, id: string) {
  return (await db.select().from(schema.channelMembers).where(and(eq(schema.channelMembers.channelId, channelId), eq(schema.channelMembers.memberType, type), eq(schema.channelMembers.memberId, id))))[0];
}
async function channelMaxSeq(channelId: string): Promise<number> {
  const [r] = await db.select({ seq: schema.messages.seq }).from(schema.messages).where(eq(schema.messages.channelId, channelId)).orderBy(desc(schema.messages.seq)).limit(1);
  return r?.seq ?? 0;
}
// Unread as `message check` / reconnectCatchup compute it: seq > lastReadSeq, excluding the agent's own messages.
async function unreadCount(channelId: string, agentId: string, lastReadSeq: number): Promise<number> {
  const rows = await db.select({ id: schema.messages.id }).from(schema.messages)
    .where(and(eq(schema.messages.channelId, channelId), gt(schema.messages.seq, lastReadSeq), or(isNull(schema.messages.senderId), ne(schema.messages.senderId, agentId))));
  return rows.length;
}
async function post(channelId: string, content: string) {
  return createMessage({ serverId, channelId, senderType: "user", senderId: ownerId, senderName: owner, content });
}

async function setup() {
  const [u1] = await db.insert(schema.users).values({ name: owner, displayName: "Owner", email: `${owner}@t.local` }).returning();
  ownerId = u1!.id;
  const [u3] = await db.insert(schema.users).values({ name: userC, displayName: "UserC", email: `${userC}@t.local` }).returning();
  userCId = u3!.id;
  const [srv] = await db.insert(schema.servers).values({ name: "T", slug: `t-${ts}`, ownerId }).returning();
  serverId = srv!.id;
  await db.insert(schema.serverMembers).values([
    { serverId, userId: ownerId, role: "owner" },
    { serverId, userId: userCId, role: "member" },
  ]);
  const [ag] = await db.insert(schema.agents).values({ serverId, name: ghostA, displayName: "GhostA" }).returning();
  ghostAId = ag!.id;
  const [ag2] = await db.insert(schema.agents).values({ serverId, name: botB, displayName: "BotB" }).returning();
  botBId = ag2!.id;
  // Channel A (mention path) + Channel B (direct-add path): owner is the only member, both get 3 history messages.
  const [c1] = await db.insert(schema.channels).values({ serverId, name: `cha-${ts}`, type: "channel" }).returning();
  chA = c1!.id;
  await db.insert(schema.channelMembers).values({ channelId: chA, memberType: "user", memberId: ownerId });
  const [c2] = await db.insert(schema.channels).values({ serverId, name: `chb-${ts}`, type: "channel" }).returning();
  chB = c2!.id;
  await db.insert(schema.channelMembers).values({ channelId: chB, memberType: "user", memberId: ownerId });
  for (const ch of [chA, chB]) for (const n of [1, 2, 3]) await post(ch, `history ${n} in ${ch.slice(0, 4)}`);
}

async function cleanup() {
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
  await db.delete(schema.users).where(eq(schema.users.id, userCId));
}

async function run() {
  await setup();
  const preMaxA = await channelMaxSeq(chA);
  const preMaxB = await channelMaxSeq(chB);

  // ── A) @-mention auto-join: the triggering @ message must stay unread; the 3 prior messages must be read.
  const atMsg = await post(chA, `@${ghostA} please look`);
  const mA = await memberRow(chA, "agent", ghostAId);
  check("[A] @-mentioned agent auto-joined channel A", !!mA);
  check("[A] watermark excludes the triggering @ (lastReadSeq == atSeq-1)", !!mA && mA.lastReadSeq === atMsg.seq - 1, `lastReadSeq=${mA?.lastReadSeq} atSeq=${atMsg.seq} preMax=${preMaxA}`);
  const unreadA = await unreadCount(chA, ghostAId, mA?.lastReadSeq ?? 0);
  check("[A] only the @ message is unread (pre-join backlog NOT re-read)", unreadA === 1, `unread=${unreadA} (expected 1)`);
  // forward delivery intact: a message after join is still unread → total 2.
  await post(chA, "after join 1");
  const unreadA2 = await unreadCount(chA, ghostAId, mA?.lastReadSeq ?? 0);
  check("[A] post-join message is still delivered (unread now 2)", unreadA2 === 2, `unread=${unreadA2} (expected 2)`);

  // ── B) direct add via addChannelMembers: zero pre-join backlog unread, watermark == channel max seq.
  await addChannelMembers(chB, [{ type: "agent", id: botBId }]);
  const mB = await memberRow(chB, "agent", botBId);
  check("[B] direct-added agent is a member of channel B", !!mB);
  check("[B] watermark == channel max seq at join (lastReadSeq == preMax)", !!mB && mB.lastReadSeq === preMaxB, `lastReadSeq=${mB?.lastReadSeq} preMax=${preMaxB}`);
  const unreadB = await unreadCount(chB, botBId, mB?.lastReadSeq ?? 0);
  check("[B] zero pre-join backlog is unread", unreadB === 0, `unread=${unreadB} (expected 0)`);
  await post(chB, "after join in B");
  const unreadB2 = await unreadCount(chB, botBId, mB?.lastReadSeq ?? 0);
  check("[B] post-join message is delivered (unread now 1)", unreadB2 === 1, `unread=${unreadB2} (expected 1)`);

  // ── C) a USER added via the same helper keeps lastReadSeq=0 (human UI unread behaviour unchanged).
  await addChannelMembers(chB, [{ type: "user", id: userCId }]);
  const mC = await memberRow(chB, "user", userCId);
  check("[C] user added via helper keeps lastReadSeq=0 (history visible as unread in UI)", !!mC && mC.lastReadSeq === 0, `lastReadSeq=${mC?.lastReadSeq} (expected 0)`);

  void preMaxA;
}

run()
  .catch((e) => { console.error("ERROR", e); failures++; })
  .finally(async () => {
    await cleanup().catch((e) => console.error("cleanup error", e));
    console.log(failures ? `\n✗ ${failures} check(s) failed` : "\n✓ all checks passed");
    await db.$client.end?.();
    process.exit(failures ? 1 : 0);
  });

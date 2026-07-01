// Real DB integration for task handoff.
// Verifies assignTask updates assignee, preserves/advances status correctly,
// records the handoff in the task thread, and adds the assignee to that thread.
// Requires infra up: `npm run infra` (pg :5433, redis :6380). Run: npx tsx test/taskAssign.integration.ts
import "../src/env.ts";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { assignTask, claimTask, convertMessageToTask, createMessage, createServer, setTaskStatus } from "../src/server/core.ts";

const ts = Date.now();
let failures = 0;
const check = (label: string, cond: boolean) => { console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`); if (!cond) failures++; };

let ownerId = "";
let serverId = "";
let channelId = "";
let srcAgentId = "";
let dstAgentId = "";
let deletedAgentId = "";

async function setup() {
  const [owner] = await db.insert(schema.users).values({
    name: `owner_${ts}`,
    displayName: "Owner",
    email: `owner_${ts}@task-assign.local`,
  }).returning();
  ownerId = owner!.id;

  const srv = await createServer(`task-assign-${ts}`, `task-assign-${ts}`, ownerId);
  serverId = srv.id;
  channelId = (await db.select().from(schema.channels).where(and(eq(schema.channels.serverId, serverId), eq(schema.channels.name, "all"))))[0]!.id;

  const [src] = await db.insert(schema.agents).values({
    serverId,
    name: `src_${ts}`,
    displayName: "Source Agent",
    runtime: "claude",
    model: "sonnet",
  }).returning();
  srcAgentId = src!.id;

  const [dst] = await db.insert(schema.agents).values({
    serverId,
    name: `dst_${ts}`,
    displayName: "Destination Agent",
    runtime: "claude",
    model: "sonnet",
  }).returning();
  dstAgentId = dst!.id;

  const [deleted] = await db.insert(schema.agents).values({
    serverId,
    name: `deleted_${ts}`,
    displayName: "Deleted Agent",
    runtime: "claude",
    model: "sonnet",
  }).returning();
  deletedAgentId = deleted!.id;
  await db.update(schema.agents).set({ deletedAt: new Date() }).where(eq(schema.agents.id, deletedAgentId));

  await db.insert(schema.channelMembers).values([
    { channelId, memberType: "agent", memberId: srcAgentId },
    { channelId, memberType: "agent", memberId: dstAgentId },
  ]).onConflictDoNothing();
}

async function cleanup() {
  const msgs = await db.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.serverId, serverId));
  for (const m of msgs) await db.delete(schema.messageMentions).where(eq(schema.messageMentions.messageId, m.id));
  await db.delete(schema.messages).where(eq(schema.messages.serverId, serverId));

  const chans = await db.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.serverId, serverId));
  for (const c of chans) await db.delete(schema.channelMembers).where(eq(schema.channelMembers.channelId, c.id));
  await db.delete(schema.channels).where(eq(schema.channels.serverId, serverId));

  await db.delete(schema.agents).where(and(eq(schema.agents.serverId, serverId), eq(schema.agents.id, srcAgentId)));
  await db.delete(schema.agents).where(and(eq(schema.agents.serverId, serverId), eq(schema.agents.id, dstAgentId)));
  await db.delete(schema.agents).where(eq(schema.agents.id, deletedAgentId));
  await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, serverId));
  await db.delete(schema.servers).where(eq(schema.servers.id, serverId));
  await db.delete(schema.users).where(eq(schema.users.id, ownerId));
}

async function main() {
  await setup();

  console.log("\n[1] assign todo task -> destination agent, status becomes in_progress");
  const msg1 = await createMessage({ serverId, channelId, senderType: "user", senderId: ownerId, senderName: `owner_${ts}`, content: "handoff todo" });
  const task1 = await convertMessageToTask(serverId, msg1.id, { type: "user", id: ownerId });
  const assigned1 = await assignTask(serverId, task1!.id, dstAgentId, { type: "agent", id: srcAgentId });
  check("assignTask returns an updated task", !!assigned1);
  check("assignee type becomes agent", assigned1?.taskAssigneeType === "agent");
  check("assignee id becomes destination agent", assigned1?.taskAssigneeId === dstAgentId);
  check("todo becomes in_progress on handoff", assigned1?.taskStatus === "in_progress");

  console.log("\n[2] assign in_review task preserves current status");
  const msg2 = await createMessage({ serverId, channelId, senderType: "user", senderId: ownerId, senderName: `owner_${ts}`, content: "handoff review" });
  const task2 = await convertMessageToTask(serverId, msg2.id, { type: "user", id: ownerId });
  await claimTask(serverId, task2!.id, "agent", srcAgentId);
  await setTaskStatus(serverId, task2!.id, "in_review", { type: "agent", id: srcAgentId });
  const assigned2 = await assignTask(serverId, task2!.id, dstAgentId, { type: "agent", id: srcAgentId });
  check("handoff preserves in_review status", assigned2?.taskStatus === "in_review");

  console.log("\n[3] handoff writes a system message into the task thread");
  const sysRows = assigned2?.threadId
    ? await db.select().from(schema.messages).where(and(eq(schema.messages.channelId, assigned2.threadId), eq(schema.messages.senderType, "system")))
    : [];
  check("thread exists on assigned task", !!assigned2?.threadId);
  check("thread contains a handoff system message", sysRows.some((m) => m.content.includes("assigned") && m.content.includes(`#${assigned2?.taskNumber}`) && m.content.includes("Destination Agent")));

  console.log("\n[4] destination agent is added to the task thread");
  const threadMember = assigned2?.threadId
    ? (await db.select().from(schema.channelMembers).where(and(eq(schema.channelMembers.channelId, assigned2.threadId), eq(schema.channelMembers.memberType, "agent"), eq(schema.channelMembers.memberId, dstAgentId))))[0]
    : null;
  check("destination agent is a thread member after handoff", !!threadMember);

  console.log("\n[5] deleted target agent is rejected");
  const msg3 = await createMessage({ serverId, channelId, senderType: "user", senderId: ownerId, senderName: `owner_${ts}`, content: "handoff fail" });
  const task3 = await convertMessageToTask(serverId, msg3.id, { type: "user", id: ownerId });
  const rejected = await assignTask(serverId, task3!.id, deletedAgentId, { type: "agent", id: srcAgentId });
  check("assignTask returns null for a deleted target agent", rejected === null);

  console.log("\n[6] assigning to the same assignee is idempotent (no duplicate audit)");
  const msg4 = await createMessage({ serverId, channelId, senderType: "user", senderId: ownerId, senderName: `owner_${ts}`, content: "handoff idempotent" });
  const task4 = await convertMessageToTask(serverId, msg4.id, { type: "user", id: ownerId });
  const first = await assignTask(serverId, task4!.id, dstAgentId, { type: "agent", id: srcAgentId });
  const before = await db.select().from(schema.messages).where(and(eq(schema.messages.channelId, first!.threadId!), eq(schema.messages.senderType, "system")));
  const second = await assignTask(serverId, task4!.id, dstAgentId, { type: "agent", id: srcAgentId });
  const after = await db.select().from(schema.messages).where(and(eq(schema.messages.channelId, first!.threadId!), eq(schema.messages.senderType, "system")));
  check("same-assignee retry returns the existing task", second?.id === first?.id);
  check("same-assignee retry does not append another system handoff message", after.length === before.length);
}

main()
  .then(cleanup)
  .then(() => { console.log(`\n${failures === 0 ? "ALL PASS ✅" : `${failures} CHECK(S) FAILED ❌`}`); process.exit(failures === 0 ? 0 : 1); })
  .catch(async (e) => { console.error("ERROR:", e); try { await cleanup(); } catch { /* */ } process.exit(1); });

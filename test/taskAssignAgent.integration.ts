// Integration test for /agent-api/task/assign.
// Verifies agent-side task handoff works by message id and by channel + task number.
// Requires infra up: `npm run infra` (pg :5433, redis :6380). Run: npx tsx test/taskAssignAgent.integration.ts
import "../src/env.ts";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { handleAgentApi } from "../src/server/routes-agent.ts";
import { agentConfig, createMessage, createServer, convertMessageToTask } from "../src/server/core.ts";

const ts = Date.now();
let failures = 0;
const check = (label: string, cond: boolean) => { console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`); if (!cond) failures++; };

let ownerId = "";
let serverId = "";
let channelId = "";
let channelName = "";
let privateChannelId = "";
let privateChannelName = "";
let dmChannelId = "";
let assignerId = "";
let assigneeId = "";
let assignerToken = "";

function mkReq(path: string, token: string, agentId: string, body?: unknown) {
  const raw = body ? JSON.stringify(body) : "";
  const readable = Readable.from(raw ? [Buffer.from(raw)] : []);
  return Object.assign(readable, {
    method: "POST",
    url: path,
    headers: {
      authorization: `Bearer ${token}`,
      "x-agent-id": agentId,
      "content-type": "application/json",
    },
  }) as unknown as IncomingMessage;
}

function mkRes() {
  let status = 0;
  let raw = "";
  const emitter = new EventEmitter();
  const finished = EventEmitter.once(emitter, "finish");
  const res = Object.assign(emitter, {
    statusCode: 0,
    headersSent: false,
    setHeader() {},
    writeHead(c: number) { status = c; this.statusCode = c; },
    end(d?: string | Buffer) { raw = d ? String(d) : ""; emitter.emit("finish"); },
  }) as unknown as ServerResponse;
  return { res, done: () => finished, status: () => status, body: () => (raw ? JSON.parse(raw) : {}) };
}

async function call(path: string, token: string, agentId: string, body?: unknown) {
  const { res, done, status, body: getBody } = mkRes();
  await handleAgentApi(mkReq(path, token, agentId, body), res, new URL(`http://localhost${path}`), "POST");
  await done();
  return { status: status(), body: getBody() };
}

async function setup() {
  const [owner] = await db.insert(schema.users).values({
    name: `owner_assign_${ts}`,
    displayName: "Owner",
    email: `owner_assign_${ts}@agent-route.local`,
  }).returning();
  ownerId = owner!.id;

  const srv = await createServer(`task-assign-agent-${ts}`, `task-assign-agent-${ts}`, ownerId);
  serverId = srv.id;
  const ch = (await db.select().from(schema.channels).where(and(eq(schema.channels.serverId, serverId), eq(schema.channels.name, "all"))))[0]!;
  channelId = ch.id;
  channelName = ch.name;
  const [priv] = await db.insert(schema.channels).values({ serverId, name: `priv_${ts}`, type: "private" }).returning();
  privateChannelId = priv!.id;
  privateChannelName = priv!.name;

  const [assigner] = await db.insert(schema.agents).values({
    serverId,
    name: `assigner_${ts}`,
    displayName: "Assigner",
    runtime: "claude",
    model: "sonnet",
    creatorType: "user",
    creatorId: ownerId,
  }).returning();
  assignerId = assigner!.id;

  const [assignee] = await db.insert(schema.agents).values({
    serverId,
    name: `assignee_${ts}`,
    displayName: "Assignee",
    runtime: "claude",
    model: "sonnet",
    creatorType: "user",
    creatorId: ownerId,
  }).returning();
  assigneeId = assignee!.id;

  await db.insert(schema.channelMembers).values([
    { channelId, memberType: "agent", memberId: assignerId },
    { channelId, memberType: "agent", memberId: assigneeId },
    { channelId: privateChannelId, memberType: "agent", memberId: assignerId },
  ]).onConflictDoNothing();

  const [dm] = await db.insert(schema.channels).values({ serverId, name: `dm:${[ownerId, assignerId].sort().join(":")}`, type: "dm" }).returning();
  dmChannelId = dm!.id;
  await db.insert(schema.channelMembers).values([
    { channelId: dmChannelId, memberType: "user", memberId: ownerId },
    { channelId: dmChannelId, memberType: "agent", memberId: assignerId },
  ]).onConflictDoNothing();

  const cfg = await agentConfig(assignerId);
  if (!cfg?.agentToken) throw new Error("assigner token was not minted");
  assignerToken = cfg.agentToken;
  const fresh = (await db.select().from(schema.agents).where(eq(schema.agents.id, assignerId)))[0]!;
}

async function cleanup() {
  const msgs = await db.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.serverId, serverId));
  for (const m of msgs) await db.delete(schema.messageMentions).where(eq(schema.messageMentions.messageId, m.id));
  await db.delete(schema.messages).where(eq(schema.messages.serverId, serverId));

  const chans = await db.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.serverId, serverId));
  for (const c of chans) await db.delete(schema.channelMembers).where(eq(schema.channelMembers.channelId, c.id));
  await db.delete(schema.channels).where(eq(schema.channels.serverId, serverId));

  await db.delete(schema.agents).where(and(eq(schema.agents.serverId, serverId), eq(schema.agents.id, assignerId)));
  await db.delete(schema.agents).where(and(eq(schema.agents.serverId, serverId), eq(schema.agents.id, assigneeId)));
  await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, serverId));
  await db.delete(schema.servers).where(eq(schema.servers.id, serverId));
  await db.delete(schema.users).where(eq(schema.users.id, ownerId));
}

async function main() {
  await setup();
  console.log("\n[1] /agent-api/task/assign by message id");
  const msg1 = await createMessage({ serverId, channelId, senderType: "user", senderId: ownerId, senderName: `owner_assign_${ts}`, content: "assign by id" });
  const task1 = await convertMessageToTask(serverId, msg1.id, { type: "user", id: ownerId });
  const byId = await call("/agent-api/task/assign", assignerToken, assignerId, { messageId: task1!.id, to: `@assignee_${ts}` });
  check("assign by message id returns 200", byId.status === 200);

  console.log("\n[2] /agent-api/task/assign by channel + task number");
  const msg2 = await createMessage({ serverId, channelId, senderType: "user", senderId: ownerId, senderName: `owner_assign_${ts}`, content: "assign by number" });
  const task2 = await convertMessageToTask(serverId, msg2.id, { type: "user", id: ownerId });
  const byNumber = await call("/agent-api/task/assign", assignerToken, assignerId, { channel: `#${channelName}`, number: task2!.taskNumber, to: `assignee_${ts}` });
  check("assign by channel + task number returns 200", byNumber.status === 200);

  console.log("\n[3] returned threadTarget is readable by assignee in private threads");
  const privMsg = await createMessage({ serverId, channelId: privateChannelId, senderType: "user", senderId: ownerId, senderName: `owner_assign_${ts}`, content: "private handoff" });
  const privTask = await convertMessageToTask(serverId, privMsg.id, { type: "user", id: ownerId });
  const privAssign = await call("/agent-api/task/assign", assignerToken, assignerId, { messageId: privTask!.id, to: `assignee_${ts}` });
  check("private assign returns 200", privAssign.status === 200);
  const assigneeCfg = await agentConfig(assigneeId);
  if (!assigneeCfg?.agentToken) throw new Error("assignee token was not minted");
  const privReadReq = Object.assign(Readable.from([] as Buffer[]), {
    method: "GET",
    url: `/agent-api/message/read?channel=${encodeURIComponent(String((privAssign.body as any).threadTarget))}`,
    headers: { authorization: `Bearer ${assigneeCfg.agentToken}`, "x-agent-id": assigneeId },
  }) as unknown as IncomingMessage;
  const privReadRes = mkRes();
  await handleAgentApi(privReadReq, privReadRes.res, new URL(`http://localhost/agent-api/message/read?channel=${encodeURIComponent(String((privAssign.body as any).threadTarget))}`), "GET");
  await privReadRes.done();
  check("assignee can read thread via returned private threadTarget", privReadRes.status() === 200);

  console.log("\n[4] returned threadTarget is readable by assignee in DM threads");
  const dmMsg = await createMessage({ serverId, channelId: dmChannelId, senderType: "user", senderId: ownerId, senderName: `owner_assign_${ts}`, content: "dm handoff" });
  const dmTask = await convertMessageToTask(serverId, dmMsg.id, { type: "user", id: ownerId });
  const dmAssign = await call("/agent-api/task/assign", assignerToken, assignerId, { messageId: dmTask!.id, to: `assignee_${ts}` });
  check("dm assign returns 200", dmAssign.status === 200);
  const dmReadReq = Object.assign(Readable.from([] as Buffer[]), {
    method: "GET",
    url: `/agent-api/message/read?channel=${encodeURIComponent(String((dmAssign.body as any).threadTarget))}`,
    headers: { authorization: `Bearer ${assigneeCfg.agentToken}`, "x-agent-id": assigneeId },
  }) as unknown as IncomingMessage;
  const dmReadRes = mkRes();
  await handleAgentApi(dmReadReq, dmReadRes.res, new URL(`http://localhost/agent-api/message/read?channel=${encodeURIComponent(String((dmAssign.body as any).threadTarget))}`), "GET");
  await dmReadRes.done();
  check("assignee can read thread via returned dm threadTarget", dmReadRes.status() === 200);

  console.log("\n[5] assignee message-check surfaces stable thread target for DM handoff");
  const dmCheckReq = Object.assign(Readable.from([] as Buffer[]), {
    method: "GET",
    url: "/agent-api/message/check",
    headers: { authorization: `Bearer ${assigneeCfg.agentToken}`, "x-agent-id": assigneeId },
  }) as unknown as IncomingMessage;
  const dmCheckRes = mkRes();
  await handleAgentApi(dmCheckReq, dmCheckRes.res, new URL("http://localhost/agent-api/message/check"), "GET");
  await dmCheckRes.done();
  const dmCheckBody = dmCheckRes.body();
  const texts = Array.isArray((dmCheckBody as any).messages) ? (dmCheckBody as any).messages.map((m: any) => String(m.text || "")) : [];
  check("message check exposes thread:shortid instead of actor-relative dm target", texts.some((txt: string) => txt.includes(`[target=thread:${dmTask!.id.slice(0, 8)}`)));
}

main()
  .then(cleanup)
  .then(() => { console.log(`\n${failures === 0 ? "ALL PASS ✅" : `${failures} CHECK(S) FAILED ❌`}`); process.exit(failures === 0 ? 0 : 1); })
  .catch(async (e) => { console.error("ERROR:", e); try { await cleanup(); } catch { /* */ } process.exit(1); });

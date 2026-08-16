// Integration test: owner/admin audit exemption for agent↔agent DMs (invariant 3 note).
// Tests: GET /api/messages/channel/:id and GET /api/channels/dm.
//
// EXPECTED BEHAVIOUR:
//   - manageAgents holder can READ an agent-only DM (no human members) and sees it listed
//     in /channels/dm named "A ⇄ B"; plain members cannot (403 / not listed).
//   - human↔agent DMs stay member-private: even the owner gets 403 when not a member.
//   - The agent plane is unaffected (canAgentReadChannel has no exemption) — not covered here.
//
// Requires infra up: `npm run infra` (pg :5433, redis :6380).
// Run: ENV_FILE=<env pointing at dev infra> npx tsx test/agentDmAudit.integration.ts
import "../src/env.js"; // load env before any DB/auth import
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { handleApi } from "../src/server/routes-api/index.ts";
import { signUser } from "../src/server/auth.ts";

const ts = Date.now();
let serverId = "";
let ownerId = "", memberId = "";
let agentDmId = "", humanAgentDmId = "";
let a1 = "", a2 = "";
let ownerToken = "", memberToken = "";
let failures = 0;

const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`);
  if (!cond) failures++;
};

function makeReq(opts: { method: string; path: string; token: string; serverId: string; body?: object }): IncomingMessage {
  const bodyStr = opts.body ? JSON.stringify(opts.body) : "";
  const readable = Readable.from(bodyStr ? [Buffer.from(bodyStr)] : ([] as Buffer[]));
  return Object.assign(readable, {
    method: opts.method,
    url: opts.path,
    headers: {
      authorization: `Bearer ${opts.token}`,
      "x-server-id": opts.serverId,
      "content-type": "application/json",
    },
  }) as unknown as IncomingMessage;
}

function makeRes(): { res: ServerResponse; getStatus: () => number; getBody: () => string } {
  let status = 0;
  let body = "";
  const emitter = new EventEmitter();
  const res = Object.assign(emitter, {
    statusCode: 0,
    headersSent: false,
    setHeader(_n: string, _v: unknown) {},
    writeHead(code: number) {
      status = code;
      this.statusCode = code;
    },
    end(d?: string | Buffer) {
      body = d ? String(d) : "";
      emitter.emit("finish");
    },
  }) as unknown as ServerResponse;
  return { res, getStatus: () => status, getBody: () => body };
}

async function apiCall(opts: { method: string; path: string; token: string; serverId: string; body?: object }): Promise<{ status: number; body: unknown }> {
  const PORT = Number(process.env.PORT ?? 7777);
  const req = makeReq(opts);
  const { res, getStatus, getBody } = makeRes();
  const url = new URL(opts.path, `http://localhost:${PORT}`);
  await handleApi(req, res, url, opts.method);
  let parsed: unknown;
  try { parsed = JSON.parse(getBody()); } catch { parsed = getBody(); }
  return { status: getStatus(), body: parsed };
}

async function setup() {
  const [u1] = await db.insert(schema.users).values({ name: `owner_${ts}`, displayName: "Owner", email: `o_${ts}@t.local` }).returning();
  const [u2] = await db.insert(schema.users).values({ name: `member_${ts}`, displayName: "Member", email: `m_${ts}@t.local` }).returning();
  ownerId = u1!.id; memberId = u2!.id;

  const [srv] = await db.insert(schema.servers).values({ name: "T", slug: `t-${ts}`, ownerId }).returning();
  serverId = srv!.id;
  await db.insert(schema.serverMembers).values([
    { serverId, userId: ownerId, role: "owner" },
    { serverId, userId: memberId, role: "member" },
  ]);

  const [ag1] = await db.insert(schema.agents).values({ serverId, name: `auda_${ts}`, displayName: `auda_${ts}` }).returning();
  const [ag2] = await db.insert(schema.agents).values({ serverId, name: `audb_${ts}`, displayName: `audb_${ts}` }).returning();
  a1 = ag1!.id; a2 = ag2!.id;

  // agent↔agent DM (no human members) — auditable by manageAgents holders
  const [adm] = await db.insert(schema.channels).values({ serverId, name: `dm:${[a1, a2].sort().join(":")}`, type: "dm" }).returning();
  agentDmId = adm!.id;
  await db.insert(schema.channelMembers).values([
    { channelId: agentDmId, memberType: "agent", memberId: a1 },
    { channelId: agentDmId, memberType: "agent", memberId: a2 },
  ]);
  await db.insert(schema.messages).values({ serverId, channelId: agentDmId, senderType: "agent", senderId: a1, senderName: `auda_${ts}`, content: "agent-audit-secret-content", seq: 1 });

  // human↔agent DM (member user + agent) — stays member-private even from the owner
  const [hdm] = await db.insert(schema.channels).values({ serverId, name: `dm:${[memberId, a1].sort().join(":")}`, type: "dm" }).returning();
  humanAgentDmId = hdm!.id;
  await db.insert(schema.channelMembers).values([
    { channelId: humanAgentDmId, memberType: "user", memberId: memberId },
    { channelId: humanAgentDmId, memberType: "agent", memberId: a1 },
  ]);
  await db.insert(schema.messages).values({ serverId, channelId: humanAgentDmId, senderType: "user", senderId: memberId, senderName: `member_${ts}`, content: "human-dm-private-content", seq: 1 });

  ownerToken = signUser(ownerId);
  memberToken = signUser(memberId);
}

async function cleanup() {
  const chans = await db.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.serverId, serverId));
  const msgs = await db.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.serverId, serverId));
  for (const m of msgs) await db.delete(schema.messageMentions).where(eq(schema.messageMentions.messageId, m.id));
  await db.delete(schema.messages).where(eq(schema.messages.serverId, serverId));
  for (const c of chans) await db.delete(schema.channelMembers).where(eq(schema.channelMembers.channelId, c.id));
  await db.delete(schema.channels).where(eq(schema.channels.serverId, serverId));
  for (const id of [a1, a2]) await db.delete(schema.agents).where(eq(schema.agents.id, id));
  await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, serverId));
  await db.delete(schema.servers).where(eq(schema.servers.id, serverId));
  await db.delete(schema.users).where(and(eq(schema.users.id, ownerId)));
  await db.delete(schema.users).where(and(eq(schema.users.id, memberId)));
}

async function main() {
  await setup();

  const r1 = await apiCall({ method: "GET", path: `/api/messages/channel/${agentDmId}`, token: ownerToken, serverId });
  check("owner can read agent↔agent DM (audit)", r1.status === 200 && JSON.stringify(r1.body).includes("agent-audit-secret-content"));

  const r2 = await apiCall({ method: "GET", path: `/api/messages/channel/${agentDmId}`, token: memberToken, serverId });
  check("plain member cannot read agent↔agent DM", r2.status === 403);

  const r3 = await apiCall({ method: "GET", path: "/api/channels/dm", token: ownerToken, serverId });
  check("owner /channels/dm lists agent↔agent DM as 'A ⇄ B'", JSON.stringify(r3.body).includes(`auda_${ts} ⇄ audb_${ts}`));

  const r4 = await apiCall({ method: "GET", path: "/api/channels/dm", token: memberToken, serverId });
  check("plain member /channels/dm does NOT list agent↔agent DM", !JSON.stringify(r4.body).includes(`auda_${ts} ⇄ audb_${ts}`));

  const r5 = await apiCall({ method: "GET", path: `/api/messages/channel/${humanAgentDmId}`, token: ownerToken, serverId });
  check("owner still cannot read human↔agent DM they are not a member of", r5.status === 403);

  const r6 = await apiCall({ method: "GET", path: `/api/messages/channel/${humanAgentDmId}`, token: memberToken, serverId });
  check("human member reads own human↔agent DM", r6.status === 200 && JSON.stringify(r6.body).includes("human-dm-private-content"));
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

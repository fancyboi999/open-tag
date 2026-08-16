// Real DB + HTTP integration: deleting a channel must drop a system notice into it and
// assign attention to every member agent, so their message check (which surfaces ONLY
// post-deletion system messages for deleted channels) wakes them with "channel deleted".
// History visibility must NOT be regained; sends stay TARGET_FAILED (resolveTarget filter).
// Requires infra up: `npm run infra` (pg :5433, redis :6380). Run: npx tsx test/channelDeletedNotice.integration.ts
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { handleApi } from "../src/server/routes-api/index.ts";
import { signUser } from "../src/server/auth.ts";

const ts = Date.now();
let serverId = "", ownerId = "", ownerToken = "";
let a1 = "", a2 = "", chId = "";
let failures = 0;
const check = (label: string, cond: boolean) => { console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`); if (!cond) failures++; };

function makeReq(opts: { method: string; path: string; token: string; body?: object }): IncomingMessage {
  const bodyStr = opts.body ? JSON.stringify(opts.body) : "";
  const readable = Readable.from(bodyStr ? [Buffer.from(bodyStr)] : ([] as Buffer[]));
  return Object.assign(readable, {
    method: opts.method,
    url: opts.path,
    headers: { authorization: `Bearer ${opts.token}`, "x-server-id": serverId, "content-type": "application/json" },
  }) as unknown as IncomingMessage;
}

function makeRes(): { res: ServerResponse; getStatus: () => number } {
  let status = 0;
  const emitter = new EventEmitter();
  const res = Object.assign(emitter, {
    statusCode: 0,
    headersSent: false,
    setHeader(_n: string, _v: unknown) {},
    writeHead(code: number) { status = code; this.statusCode = code; },
    end() { emitter.emit("finish"); },
  }) as unknown as ServerResponse;
  return { res, getStatus: () => status };
}

async function apiCall(method: string, path: string, body?: object): Promise<number> {
  const { res, getStatus } = makeRes();
  await handleApi(makeReq({ method, path, token: ownerToken, body }), res, new URL(path, "http://localhost:7777"), method);
  return getStatus();
}

async function setup() {
  const [u] = await db.insert(schema.users).values({ name: `owner_${ts}`, displayName: "Owner", email: `o_${ts}@t.local` }).returning();
  ownerId = u!.id;
  const [srv] = await db.insert(schema.servers).values({ name: "T", slug: `t-${ts}`, ownerId }).returning();
  serverId = srv!.id;
  await db.insert(schema.serverMembers).values({ serverId, userId: ownerId, role: "owner" });
  const [ag1] = await db.insert(schema.agents).values({ serverId, name: `m1_${ts}`, displayName: "M1" }).returning();
  const [ag2] = await db.insert(schema.agents).values({ serverId, name: `m2_${ts}`, displayName: "M2" }).returning();
  a1 = ag1!.id; a2 = ag2!.id;
  const [c] = await db.insert(schema.channels).values({ serverId, name: `doomed_${ts}`, type: "channel" }).returning();
  chId = c!.id;
  await db.insert(schema.channelMembers).values([
    { channelId: chId, memberType: "agent", memberId: a1 },
    { channelId: chId, memberType: "agent", memberId: a2 },
  ]);
  ownerToken = signUser(ownerId);
}

async function cleanup() {
  const chans = await db.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.serverId, serverId));
  const msgs = await db.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.serverId, serverId));
  for (const m of msgs) await db.delete(schema.messageMentions).where(eq(schema.messageMentions.messageId, m.id));
  for (const m of msgs) await db.delete(schema.agentMessageDecisions).where(eq(schema.agentMessageDecisions.messageId, m.id));
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
  const status = await apiCall("DELETE", `/api/channels/${chId}`);
  check("DELETE channel returns 200", status === 200);

  const ch = (await db.select().from(schema.channels).where(eq(schema.channels.id, chId)))[0];
  check("channel is soft-deleted", !!ch?.deletedAt);

  const notice = (await db.select().from(schema.messages).where(and(eq(schema.messages.channelId, chId), eq(schema.messages.messageType, "system"))))[0];
  check("system deletion notice posted into the deleted channel", !!notice && notice.content.includes("已被删除"));

  const assigned = notice
    ? await db.select().from(schema.agentMessageDecisions).where(and(eq(schema.agentMessageDecisions.messageId, notice.id), eq(schema.agentMessageDecisions.attention, "assigned")))
    : [];
  const assignedIds = new Set(assigned.map((r) => r.agentId));
  check("both member agents get assigned attention (wake on next check)", assignedIds.has(a1) && assignedIds.has(a2));
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

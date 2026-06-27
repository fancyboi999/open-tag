// GET /api/messages/:id contract — single message by id, used by the "jump to unread thread" bar to open a
// thread whose parent isn't in the loaded page.
//   - a channel member gets the serialized message
//   - a non-member of a PRIVATE channel is refused with 404 (invariant 3 — don't leak existence) [IDOR]
//   - an unknown id returns 404
//
// Requires infra up. Run:  npx tsx test/singleMessageGet.integration.ts
import "../src/env.js";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import { db, schema, sql } from "../src/db/index.ts";
import { pub, redis, sub } from "../src/redis.ts";
import { createMessage } from "../src/server/core.ts";
import { handleApi } from "../src/server/routes-api/index.ts";
import { signUser } from "../src/server/auth.ts";

const ts = Date.now();
let failures = 0;
let serverId = "", ownerId = "", memberId = "", strangerId = "", pubChannelId = "", privChannelId = "";
let memberToken = "", strangerToken = "";

const check = (label: string, cond: boolean) => { console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`); if (!cond) failures++; };

function makeReq(opts: { method: string; path: string; token: string; serverId: string }): IncomingMessage {
  return Object.assign(Readable.from([] as Buffer[]), { method: opts.method, url: opts.path, headers: { authorization: `Bearer ${opts.token}`, "x-server-id": opts.serverId, "content-type": "application/json" } }) as unknown as IncomingMessage;
}
function makeRes(): { res: ServerResponse; status: () => number; body: () => any } {
  let status = 0, raw = "";
  const emitter = new EventEmitter();
  const res = Object.assign(emitter, { statusCode: 0, headersSent: false, setHeader() {}, writeHead(c: number) { status = c; this.statusCode = c; }, end(d?: string | Buffer) { raw = d ? String(d) : ""; (emitter as any).emit("finish"); } }) as unknown as ServerResponse;
  return { res, status: () => status, body: () => { try { return JSON.parse(raw); } catch { return raw; } } };
}
async function apiCall(token: string, method: string, path: string) {
  const { res, status, body } = makeRes();
  await handleApi(makeReq({ method, path, token, serverId }), res, new URL(path, "http://localhost"), method);
  return { status: status(), body: body() };
}

async function setup() {
  const [owner] = await db.insert(schema.users).values({ name: `o_${ts}`, displayName: "Owner", email: `o_${ts}@t.local` }).returning();
  const [member] = await db.insert(schema.users).values({ name: `m_${ts}`, displayName: "Member", email: `m_${ts}@t.local` }).returning();
  const [stranger] = await db.insert(schema.users).values({ name: `s_${ts}`, displayName: "Stranger", email: `s_${ts}@t.local` }).returning();
  ownerId = owner!.id; memberId = member!.id; strangerId = stranger!.id;
  const [srv] = await db.insert(schema.servers).values({ name: "SingleMsg", slug: `single-msg-${ts}`, ownerId }).returning();
  serverId = srv!.id;
  await db.insert(schema.serverMembers).values([
    { serverId, userId: ownerId, role: "owner" }, { serverId, userId: memberId, role: "member" }, { serverId, userId: strangerId, role: "member" },
  ]);
  const [pub_] = await db.insert(schema.channels).values({ serverId, name: `pub-${ts}`, type: "channel" }).returning();
  const [priv] = await db.insert(schema.channels).values({ serverId, name: `priv-${ts}`, type: "private" }).returning();
  pubChannelId = pub_!.id; privChannelId = priv!.id;
  await db.insert(schema.channelMembers).values([
    { channelId: pubChannelId, memberType: "user", memberId: ownerId },
    { channelId: pubChannelId, memberType: "user", memberId: memberId },
    { channelId: privChannelId, memberType: "user", memberId: ownerId }, // stranger is NOT in the private channel
  ]);
  memberToken = signUser(memberId); strangerToken = signUser(strangerId);
}
async function cleanup() {
  const chans = await db.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.serverId, serverId));
  await db.delete(schema.messages).where(eq(schema.messages.serverId, serverId));
  for (const ch of chans) await db.delete(schema.channelMembers).where(eq(schema.channelMembers.channelId, ch.id));
  await db.delete(schema.channels).where(eq(schema.channels.serverId, serverId));
  await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, serverId));
  await db.delete(schema.servers).where(eq(schema.servers.id, serverId));
  for (const id of [ownerId, memberId, strangerId]) await db.delete(schema.users).where(eq(schema.users.id, id));
}

async function main() {
  await setup();
  const pubMsg = await createMessage({ serverId, channelId: pubChannelId, senderType: "user", senderId: ownerId, senderName: "owner", content: "hello in public" });
  const privMsg = await createMessage({ serverId, channelId: privChannelId, senderType: "user", senderId: ownerId, senderName: "owner", content: "secret in private" });

  console.log("\n[1] a channel member gets the serialized message");
  {
    const r = await apiCall(memberToken, "GET", `/api/messages/${pubMsg.id}`);
    check("200", r.status === 200);
    check("returns the message with matching id + content", r.body?.message?.id === pubMsg.id && r.body?.message?.content === "hello in public");
  }

  console.log("\n[2] non-member of a PRIVATE channel is refused 404 (no existence leak) [IDOR]");
  {
    const r = await apiCall(strangerToken, "GET", `/api/messages/${privMsg.id}`);
    check("404", r.status === 404);
    check("does not leak the private message content", JSON.stringify(r.body ?? {}).indexOf("secret in private") < 0);
  }

  console.log("\n[3] unknown id → 404");
  {
    const r = await apiCall(memberToken, "GET", `/api/messages/00000000-0000-0000-0000-000000000000`);
    check("404", r.status === 404);
  }

  await cleanup();
  await Promise.all([redis.quit(), pub.quit(), sub.quit()]);
  await sql.end();
  if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}
main().catch(async (e) => { console.error(e); if (serverId) await cleanup().catch(() => {}); await Promise.all([redis.quit(), pub.quit(), sub.quit()]).catch(() => {}); await sql.end().catch(() => {}); process.exit(1); });

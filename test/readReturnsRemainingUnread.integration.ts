// Read-clears-its-own-source contract (the "read messages become unread again" fix):
// - the channel unread badge aggregates the channel's own timeline unread + its followed threads' unread
// - POST /api/channels/:id/read advances ONLY that container's read cursor and returns the parent channel's
//   *authoritative remaining* aggregated unread, so the client can render an honest badge with no false "all clear"
// - reading the channel clears the channel-own portion (thread portion stays); reading the thread clears the
//   thread portion. Each source is cleared independently; neither over-clears nor resurrects the other.
//
// Requires infra up. Run:
//   npx tsx test/readReturnsRemainingUnread.integration.ts
import "../src/env.js";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, desc, eq } from "drizzle-orm";
import { db, schema, sql } from "../src/db/index.ts";
import { pub, redis, sub } from "../src/redis.ts";
import { createMessage, getOrCreateThread } from "../src/server/core.ts";
import { handleApi } from "../src/server/routes-api/index.ts";
import { signUser } from "../src/server/auth.ts";

const ts = Date.now();
let failures = 0;
let serverId = "", ownerId = "", viewerId = "", channelId = "", viewerToken = "";

const check = (label: string, cond: boolean) => { console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`); if (!cond) failures++; };

function makeReq(opts: { method: string; path: string; token: string; serverId: string; body?: object }): IncomingMessage {
  const bodyStr = opts.body ? JSON.stringify(opts.body) : "";
  const readable = Readable.from(bodyStr ? [Buffer.from(bodyStr)] : ([] as Buffer[]));
  return Object.assign(readable, { method: opts.method, url: opts.path, headers: { authorization: `Bearer ${opts.token}`, "x-server-id": opts.serverId, "content-type": "application/json" } }) as unknown as IncomingMessage;
}
function makeRes(): { res: ServerResponse; status: () => number; body: () => any } {
  let status = 0, raw = "";
  const emitter = new EventEmitter();
  const res = Object.assign(emitter, { statusCode: 0, headersSent: false, setHeader() {}, writeHead(c: number) { status = c; this.statusCode = c; }, end(d?: string | Buffer) { raw = d ? String(d) : ""; (emitter as any).emit("finish"); } }) as unknown as ServerResponse;
  return { res, status: () => status, body: () => { try { return JSON.parse(raw); } catch { return raw; } } };
}
async function apiCall(opts: { method: string; path: string; body?: object }) {
  const req = makeReq({ ...opts, token: viewerToken, serverId });
  const { res, status, body } = makeRes();
  await handleApi(req, res, new URL(opts.path, "http://localhost"), opts.method);
  return { status: status(), body: body() };
}
async function badge(chId: string) { const r = await apiCall({ method: "GET", path: "/api/channels/unread" }); return r.body?.[chId] ?? 0; }
async function readContainer(chId: string) { return apiCall({ method: "POST", path: `/api/channels/${chId}/read`, body: {} }); }
async function latestSeq(chId: string) { const [row] = await db.select({ seq: schema.messages.seq }).from(schema.messages).where(eq(schema.messages.channelId, chId)).orderBy(desc(schema.messages.seq)).limit(1); return Number(row?.seq ?? 0); }
// Baseline cursor advance via direct DB write — keeps the setup independent of the very endpoint under test.
async function dbMarkRead(chId: string) {
  await db.insert(schema.channelMembers)
    .values({ channelId: chId, memberType: "user", memberId: viewerId, lastReadSeq: await latestSeq(chId) })
    .onConflictDoUpdate({ target: [schema.channelMembers.channelId, schema.channelMembers.memberType, schema.channelMembers.memberId], set: { lastReadSeq: await latestSeq(chId), threadDoneAt: null } });
}

async function setup() {
  const [owner] = await db.insert(schema.users).values({ name: `o_${ts}`, displayName: "Owner", email: `o_${ts}@t.local` }).returning();
  const [viewer] = await db.insert(schema.users).values({ name: `v_${ts}`, displayName: "Viewer", email: `v_${ts}@t.local` }).returning();
  ownerId = owner!.id; viewerId = viewer!.id;
  const [srv] = await db.insert(schema.servers).values({ name: "ReadRemaining", slug: `read-remaining-${ts}`, ownerId }).returning();
  serverId = srv!.id;
  await db.insert(schema.serverMembers).values([{ serverId, userId: ownerId, role: "owner" }, { serverId, userId: viewerId, role: "member" }]);
  const [ch] = await db.insert(schema.channels).values({ serverId, name: `general-${ts}`, type: "channel" }).returning();
  channelId = ch!.id;
  await db.insert(schema.channelMembers).values([{ channelId, memberType: "user", memberId: ownerId }, { channelId, memberType: "user", memberId: viewerId }]);
  viewerToken = signUser(viewerId);
}
async function cleanup() {
  const chans = await db.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.serverId, serverId));
  await db.delete(schema.messages).where(eq(schema.messages.serverId, serverId));
  for (const ch of chans) await db.delete(schema.channelMembers).where(eq(schema.channelMembers.channelId, ch.id));
  await db.delete(schema.channels).where(eq(schema.channels.serverId, serverId));
  await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, serverId));
  await db.delete(schema.servers).where(eq(schema.servers.id, serverId));
  await db.delete(schema.users).where(eq(schema.users.id, ownerId));
  await db.delete(schema.users).where(eq(schema.users.id, viewerId));
}

async function main() {
  await setup();

  // Establish a caught-up baseline first, then add EXACTLY one channel-own unread + one thread unread,
  // so the aggregate badge is unambiguously 2.
  const parent = await createMessage({ serverId, channelId, senderType: "user", senderId: ownerId, senderName: "owner", content: "parent message" });
  const thread = await getOrCreateThread(serverId, parent.id, { type: "user", id: viewerId }); // viewer joins the thread
  await dbMarkRead(channelId);
  await dbMarkRead(thread.id);
  check("baseline: caught up, badge 0", (await badge(channelId)) === 0);
  await createMessage({ serverId, channelId: thread.id, senderType: "user", senderId: ownerId, senderName: "owner", content: "thread reply (thread-source unread)" });
  await createMessage({ serverId, channelId, senderType: "user", senderId: ownerId, senderName: "owner", content: "channel-timeline message (channel-source unread)" });

  console.log("\n[1] badge aggregates channel-own + thread unread");
  check("badge = 2 (1 channel-own + 1 thread)", (await badge(channelId)) === 2);

  console.log("\n[2] reading the CHANNEL clears only the channel-own portion and returns authoritative remaining");
  {
    const r = await readContainer(channelId);
    check("POST /read returns 200", r.status === 200);
    check("response reports the affected sidebar channel id", r.body?.channelId === channelId);
    check("response reports remaining aggregated unread = 1 (thread portion stays)", r.body?.unread === 1);
    check("GET /unread agrees: channel still shows 1 (thread unread not over-cleared)", (await badge(channelId)) === 1);
  }

  console.log("\n[3] reading the THREAD clears the thread portion and returns the parent's remaining (now 0)");
  {
    const r = await readContainer(thread.id);
    check("POST /read on a thread returns 200", r.status === 200);
    check("response reports the PARENT channel id as the affected sidebar key", r.body?.channelId === channelId);
    check("response reports remaining = 0 (everything read)", r.body?.unread === 0);
    check("GET /unread agrees: channel cleared", (await badge(channelId)) === 0);
  }

  console.log("\n[4] no resurrection: re-reading an already-read channel stays at 0");
  {
    const r = await readContainer(channelId);
    check("re-read returns remaining 0", r.body?.unread === 0);
    check("GET /unread still 0", (await badge(channelId)) === 0);
  }

  await cleanup();
  await Promise.all([redis.quit(), pub.quit(), sub.quit()]);
  await sql.end();
  if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}
main().catch(async (e) => { console.error(e); if (serverId) await cleanup().catch(() => {}); await Promise.all([redis.quit(), pub.quit(), sub.quit()]).catch(() => {}); await sql.end().catch(() => {}); process.exit(1); });

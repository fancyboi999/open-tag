// Thread unread contract:
// - replies in a followed thread contribute to the parent channel's unread badge
// - the raw thread channel id is not returned as a top-level sidebar unread key
// - a user's own thread replies and own task-move system messages do not mark that thread unread
//
// Requires infra up. Run:
//   npx tsx test/threadUnread.integration.ts
import "../src/env.js";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, desc, eq } from "drizzle-orm";
import { db, schema, sql } from "../src/db/index.ts";
import { pub, redis, sub } from "../src/redis.ts";
import { createMessage, getOrCreateThread, setTaskStatus } from "../src/server/core.ts";
import { handleApi } from "../src/server/routes-api/index.ts";
import { signUser } from "../src/server/auth.ts";

const ts = Date.now();
let failures = 0;
let serverId = "";
let ownerId = "";
let viewerId = "";
let channelId = "";
let viewerToken = "";

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

function makeRes(): { res: ServerResponse; status: () => number; body: () => any } {
  let status = 0;
  let raw = "";
  const emitter = new EventEmitter();
  const res = Object.assign(emitter, {
    statusCode: 0,
    headersSent: false,
    setHeader(_name: string, _value: unknown) {},
    writeHead(code: number) {
      status = code;
      this.statusCode = code;
    },
    end(data?: string | Buffer) {
      raw = data ? String(data) : "";
      emitter.emit("finish");
    },
  }) as unknown as ServerResponse;
  return {
    res,
    status: () => status,
    body: () => {
      try { return JSON.parse(raw); } catch { return raw; }
    },
  };
}

async function apiCall(opts: { method: string; path: string; token?: string; body?: object }) {
  const req = makeReq({ method: opts.method, path: opts.path, token: opts.token ?? viewerToken, serverId, body: opts.body });
  const { res, status, body } = makeRes();
  await handleApi(req, res, new URL(opts.path, "http://localhost"), opts.method);
  return { status: status(), body: body() };
}

async function latestSeq(chId: string): Promise<number> {
  const [row] = await db.select({ seq: schema.messages.seq }).from(schema.messages)
    .where(eq(schema.messages.channelId, chId)).orderBy(desc(schema.messages.seq)).limit(1);
  return Number(row?.seq ?? 0);
}

async function markThreadRead(threadChannelId: string) {
  await db.insert(schema.channelMembers)
    .values({ channelId: threadChannelId, memberType: "user", memberId: viewerId, lastReadSeq: await latestSeq(threadChannelId) })
    .onConflictDoUpdate({
      target: [schema.channelMembers.channelId, schema.channelMembers.memberType, schema.channelMembers.memberId],
      set: { lastReadSeq: await latestSeq(threadChannelId), threadDoneAt: null },
    });
}

async function markChannelRead(chId: string) {
  const seq = await latestSeq(chId);
  await db.update(schema.channelMembers)
    .set({ lastReadSeq: seq })
    .where(and(eq(schema.channelMembers.channelId, chId), eq(schema.channelMembers.memberType, "user"), eq(schema.channelMembers.memberId, viewerId)));
}

async function setup() {
  const [owner] = await db.insert(schema.users).values({ name: `owner_tu_${ts}`, displayName: "Owner", email: `owner_tu_${ts}@test.local` }).returning();
  const [viewer] = await db.insert(schema.users).values({ name: `viewer_tu_${ts}`, displayName: "Viewer", email: `viewer_tu_${ts}@test.local` }).returning();
  ownerId = owner!.id;
  viewerId = viewer!.id;

  const [srv] = await db.insert(schema.servers).values({ name: "Thread Unread", slug: `thread-unread-${ts}`, ownerId }).returning();
  serverId = srv!.id;
  await db.insert(schema.serverMembers).values([
    { serverId, userId: ownerId, role: "owner" },
    { serverId, userId: viewerId, role: "member" },
  ]);

  const [ch] = await db.insert(schema.channels).values({ serverId, name: `tu-${ts}`, type: "channel" }).returning();
  channelId = ch!.id;
  await db.insert(schema.channelMembers).values([
    { channelId, memberType: "user", memberId: ownerId },
    { channelId, memberType: "user", memberId: viewerId },
  ]);
  viewerToken = signUser(viewerId);
}

async function cleanup() {
  const chans = await db.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.serverId, serverId));
  const msgs = await db.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.serverId, serverId));
  for (const m of msgs) {
    await db.delete(schema.messageMentions).where(eq(schema.messageMentions.messageId, m.id));
    await db.delete(schema.reactions).where(eq(schema.reactions.messageId, m.id));
    await db.delete(schema.savedMessages).where(eq(schema.savedMessages.messageId, m.id));
  }
  await db.delete(schema.messages).where(eq(schema.messages.serverId, serverId));
  for (const ch of chans) await db.delete(schema.channelMembers).where(eq(schema.channelMembers.channelId, ch.id));
  await db.delete(schema.channels).where(eq(schema.channels.serverId, serverId));
  await db.delete(schema.agents).where(eq(schema.agents.serverId, serverId));
  await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, serverId));
  await db.delete(schema.servers).where(eq(schema.servers.id, serverId));
  await db.delete(schema.users).where(and(eq(schema.users.id, ownerId)));
  await db.delete(schema.users).where(and(eq(schema.users.id, viewerId)));
}

async function main() {
  await setup();

  console.log("\n[1] followed thread replies count on the parent channel unread badge");
  const parent = await createMessage({
    serverId,
    channelId,
    senderType: "user",
    senderId: ownerId,
    senderName: `owner_tu_${ts}`,
    content: "parent message",
  });
  const thread = await getOrCreateThread(serverId, parent.id, { type: "user", id: viewerId });
  await markChannelRead(channelId);
  await markThreadRead(thread.id);
  await createMessage({
    serverId,
    channelId: thread.id,
    senderType: "user",
    senderId: ownerId,
    senderName: `owner_tu_${ts}`,
    content: "reply the viewer should see as channel unread",
  });
  {
    const r = await apiCall({ method: "GET", path: "/api/channels/unread" });
    check("/channels/unread returns 200", r.status === 200);
    check("parent channel has one unread from the followed thread", r.body?.[channelId] === 1);
    check("raw thread channel id is not exposed as a sidebar unread key", r.body?.[thread.id] == null);
  }

  console.log("\n[2] own thread replies are not counted as unread");
  await markThreadRead(thread.id);
  await createMessage({
    serverId,
    channelId: thread.id,
    senderType: "user",
    senderId: viewerId,
    senderName: `viewer_tu_${ts}`,
    content: "my own reply should not create unread",
  });
  {
    const r = await apiCall({ method: "GET", path: `/api/channels/${channelId}/threads?parentMessageIds=${parent.id}` });
    check("thread metadata returns 200", r.status === 200);
    check("own thread reply leaves unreadCount at 0", r.body?.[parent.id]?.unreadCount === 0);
  }

  console.log("\n[3] own task move system message is not counted as thread unread");
  const task = await createMessage({
    serverId,
    channelId,
    senderType: "user",
    senderId: viewerId,
    senderName: `viewer_tu_${ts}`,
    content: "task owned by the moving user",
    asTask: true,
  });
  if (!task.threadId) throw new Error("task thread was not created");
  await markThreadRead(task.threadId);
  await setTaskStatus(serverId, task.id, "in_review", { type: "user", id: viewerId });
  {
    const r = await apiCall({ method: "GET", path: `/api/channels/${channelId}/threads?parentMessageIds=${task.id}` });
    check("task thread metadata returns 200", r.status === 200);
    check("own task move system message leaves unreadCount at 0", r.body?.[task.id]?.unreadCount === 0);
  }

  console.log("\n[4] done thread system messages stay out of channel unread");
  await markThreadRead(task.threadId);
  {
    const r = await apiCall({ method: "POST", path: "/api/channels/threads/done", body: { threadChannelId: task.threadId } });
    check("mark thread done returns 200", r.status === 200);
  }
  await setTaskStatus(serverId, task.id, "done", { type: "user", id: ownerId });
  {
    const unread = await apiCall({ method: "GET", path: "/api/channels/unread" });
    check("done thread does not light parent channel unread", unread.body?.[channelId] == null);
    const followed = await apiCall({ method: "GET", path: "/api/channels/threads/followed" });
    check("done thread stays hidden from followed threads", !(followed.body?.threads || []).some((th: any) => th.threadChannelId === task.threadId));
  }

  console.log("\n[5] null-sender system unread is consistent between channel badge and inbox");
  await markChannelRead(channelId);
  await createMessage({
    serverId,
    channelId,
    senderType: "system",
    senderId: null,
    senderName: "system",
    content: "system notice with no actor",
  });
  {
    const unread = await apiCall({ method: "GET", path: "/api/channels/unread" });
    check("null-sender system message counts in channel unread", unread.body?.[channelId] === 1);
    const inbox = await apiCall({ method: "GET", path: "/api/channels/inbox?filter=unread" });
    const item = (inbox.body?.items || []).find((it: any) => it.channelId === channelId);
    check("null-sender system message appears in unread inbox", item?.unreadCount === 1);
  }

  await cleanup();
  await Promise.all([redis.quit(), pub.quit(), sub.quit()]);
  await sql.end();
  if (failures) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  if (serverId) await cleanup().catch(() => {});
  await Promise.all([redis.quit(), pub.quit(), sub.quit()]).catch(() => {});
  await sql.end().catch(() => {});
  process.exit(1);
});

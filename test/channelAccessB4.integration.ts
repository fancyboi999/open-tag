// Integration test: IDOR-B4 — human-plane task/action-card write endpoints channel-access gates.
//
// A same-tenant non-member of a private channel must not mutate that channel's tasks or action
// cards by supplying a known message/task UUID.
//
//   Endpoint                                              | BEFORE fix    | AFTER fix
//   ----------------------------------------------------- | ------------- | ---------
//   POST   /api/tasks/convert-message  (private-ch msg)   | 200 (promotes)| 404
//   PATCH  /api/tasks/:id/claim        (private-ch task)  | 200 (claims)  | 404
//   PATCH  /api/tasks/:id/status       (private-ch task)  | 200 (mutates) | 404
//   PATCH  /api/tasks/:id/unclaim      (private-ch task)  | 200 (releases)| 404
//   DELETE /api/tasks/:id              (private-ch task)  | 200 (deletes) | 404
//   POST   /api/actions/:id/mark-executed (private-ch)    | 200 (marks)   | 404
//
// Regression (must always pass):
//   non-member (server member) on a PUBLIC channel: convert/claim → 200
//   owner (channel member) on a PRIVATE channel: status / mark-executed → 200
//
// 404 (not 403) on denial matches the existing reactions guard (IDOR-B2): by-message-id writes
// hide existence — a non-member can't tell "no access" from "doesn't exist".
//
// Run from the worktree: npx tsx test/channelAccessB4.integration.ts
import "../src/env.js";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { handleApi } from "../src/server/routes-api/index.ts";
import { signUser } from "../src/server/auth.ts";

const ts = Date.now();
let serverId = "";
let ownerId = "", nonMemberId = "";
let publicChId = "", privateChId = "";
let ownerToken = "", nonMemberToken = "";
let privPlainConvert = "", privTaskClaim = "", privTaskStatus = "", privTaskUnclaim = "";
let privTaskDelete = "", privActionCard = "", privTaskOwner = "", privActionOwner = "";
let pubPlainConvert = "", pubTaskClaim = "";
let failures = 0;
let seqCounter = 1;

const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`);
  if (!cond) failures++;
};

function makeReq(opts: { method: string; path: string; token: string; serverId?: string; body?: object }): IncomingMessage {
  const bodyStr = opts.body ? JSON.stringify(opts.body) : "";
  const readable = Readable.from(bodyStr ? [Buffer.from(bodyStr)] : ([] as Buffer[]));
  const headers: Record<string, string> = { authorization: `Bearer ${opts.token}`, "content-type": "application/json" };
  if (opts.serverId) headers["x-server-id"] = opts.serverId;
  return Object.assign(readable, { method: opts.method, url: opts.path, headers }) as unknown as IncomingMessage;
}

function makeRes(): { res: ServerResponse; getStatus: () => number; getBody: () => string } {
  let status = 0;
  let body = "";
  const emitter = new EventEmitter();
  const res = Object.assign(emitter, {
    statusCode: 0,
    headersSent: false,
    setHeader(_n: string, _v: unknown) {},
    writeHead(code: number) { status = code; this.statusCode = code; },
    end(d?: string | Buffer) { body = d ? String(d) : ""; emitter.emit("finish"); },
  }) as unknown as ServerResponse;
  return { res, getStatus: () => status, getBody: () => body };
}

async function apiCall(opts: { method: string; path: string; token: string; serverId?: string; body?: object }): Promise<{ status: number; body: unknown }> {
  const PORT = Number(process.env.PORT ?? 7777);
  const req = makeReq(opts);
  const { res, getStatus, getBody } = makeRes();
  const url = new URL(opts.path, `http://localhost:${PORT}`);
  await handleApi(req, res, url, opts.method);
  let parsed: unknown;
  try { parsed = JSON.parse(getBody()); } catch { parsed = getBody(); }
  return { status: getStatus(), body: parsed };
}

async function seedMsg(channelId: string, opts: { task?: "todo" | "in_progress"; taskNumber?: number; assignee?: string; action?: boolean } = {}): Promise<string> {
  const vals: typeof schema.messages.$inferInsert = {
    serverId, channelId, senderType: "user", senderId: ownerId, senderName: `owner_b4_${ts}`,
    content: opts.action ? "action card" : "task or message", seq: seqCounter++,
  };
  if (opts.task) {
    vals.taskStatus = opts.task;
    vals.taskNumber = opts.taskNumber ?? seqCounter;
    if (opts.assignee) { vals.taskAssigneeType = "user"; vals.taskAssigneeId = opts.assignee; vals.taskClaimedAt = new Date(); }
  }
  if (opts.action) vals.actionMetadata = { kind: "action-card", state: "pending", action: { kind: "channel:create", name: "x" } };
  const [m] = await db.insert(schema.messages).values(vals).returning();
  return m!.id;
}

async function setup() {
  const [u1] = await db.insert(schema.users).values({ name: `owner_b4_${ts}`, displayName: "Owner", email: `ob4_${ts}@t.local` }).returning();
  const [u2] = await db.insert(schema.users).values({ name: `nonmem_b4_${ts}`, displayName: "NonMember", email: `nb4_${ts}@t.local` }).returning();
  ownerId = u1!.id; nonMemberId = u2!.id;

  const [srv] = await db.insert(schema.servers).values({ name: "TB4", slug: `tb4-${ts}`, ownerId }).returning();
  serverId = srv!.id;
  await db.insert(schema.serverMembers).values([
    { serverId, userId: ownerId, role: "owner" },
    { serverId, userId: nonMemberId, role: "member" },
  ]);

  const [pub] = await db.insert(schema.channels).values({ serverId, name: `pub-b4-${ts}`, type: "channel" }).returning();
  publicChId = pub!.id;
  await db.insert(schema.channelMembers).values({ channelId: publicChId, memberType: "user", memberId: ownerId });

  const [priv] = await db.insert(schema.channels).values({ serverId, name: `priv-b4-${ts}`, type: "private" }).returning();
  privateChId = priv!.id;
  await db.insert(schema.channelMembers).values({ channelId: privateChId, memberType: "user", memberId: ownerId });

  privPlainConvert = await seedMsg(privateChId);
  privTaskClaim = await seedMsg(privateChId, { task: "todo", taskNumber: 1 });
  privTaskStatus = await seedMsg(privateChId, { task: "todo", taskNumber: 2 });
  privTaskUnclaim = await seedMsg(privateChId, { task: "in_progress", taskNumber: 3, assignee: ownerId });
  privTaskDelete = await seedMsg(privateChId, { task: "todo", taskNumber: 4 });
  privActionCard = await seedMsg(privateChId, { action: true });
  privTaskOwner = await seedMsg(privateChId, { task: "todo", taskNumber: 7 });
  privActionOwner = await seedMsg(privateChId, { action: true });

  pubPlainConvert = await seedMsg(publicChId);
  pubTaskClaim = await seedMsg(publicChId, { task: "todo", taskNumber: 5 });

  ownerToken = signUser(ownerId);
  nonMemberToken = signUser(nonMemberId);
}

async function cleanup() {
  const msgs = await db.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.serverId, serverId));
  for (const m of msgs) await db.delete(schema.messageMentions).where(eq(schema.messageMentions.messageId, m.id));
  await db.delete(schema.messages).where(eq(schema.messages.serverId, serverId));
  const chans = await db.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.serverId, serverId));
  for (const c of chans) await db.delete(schema.channelMembers).where(eq(schema.channelMembers.channelId, c.id));
  await db.delete(schema.channels).where(eq(schema.channels.serverId, serverId));
  await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, serverId));
  await db.delete(schema.servers).where(eq(schema.servers.id, serverId));
  await db.delete(schema.users).where(eq(schema.users.id, ownerId));
  await db.delete(schema.users).where(eq(schema.users.id, nonMemberId));
}

async function main() {
  await setup();

  console.log("\n[1] POST /api/tasks/convert-message — non-member cannot promote a private-channel message");
  {
    const r = await apiCall({ method: "POST", path: "/api/tasks/convert-message", token: nonMemberToken, serverId, body: { messageId: privPlainConvert } });
    check("non-member convert on private-channel message → 404 (not 200)", r.status === 404);
  }

  console.log("\n[2] PATCH /api/tasks/:id/claim — non-member cannot claim a private-channel task");
  {
    const r = await apiCall({ method: "PATCH", path: `/api/tasks/${privTaskClaim}/claim`, token: nonMemberToken, serverId });
    check("non-member claim on private-channel task → 404 (not 200/409)", r.status === 404);
  }

  console.log("\n[3] PATCH /api/tasks/:id/status — non-member cannot change a private-channel task's status");
  {
    const r = await apiCall({ method: "PATCH", path: `/api/tasks/${privTaskStatus}/status`, token: nonMemberToken, serverId, body: { status: "done" } });
    check("non-member status on private-channel task → 404 (not 200)", r.status === 404);
  }

  console.log("\n[4] PATCH /api/tasks/:id/unclaim — non-member cannot release a private-channel task");
  {
    const r = await apiCall({ method: "PATCH", path: `/api/tasks/${privTaskUnclaim}/unclaim`, token: nonMemberToken, serverId });
    check("non-member unclaim on private-channel task → 404 (not 200)", r.status === 404);
  }

  console.log("\n[5] DELETE /api/tasks/:id — non-member cannot delete a private-channel task");
  {
    const r = await apiCall({ method: "DELETE", path: `/api/tasks/${privTaskDelete}`, token: nonMemberToken, serverId });
    check("non-member delete on private-channel task → 404 (not 200)", r.status === 404);
  }

  console.log("\n[6] POST /api/actions/:id/mark-executed — non-member cannot mark a private-channel action card");
  {
    const r = await apiCall({ method: "POST", path: `/api/actions/${privActionCard}/mark-executed`, token: nonMemberToken, serverId, body: {} });
    check("non-member mark-executed on private-channel action → 404 (not 200)", r.status === 404);
  }

  console.log("\n[7] Regression: non-member can convert/claim on a PUBLIC channel (server-member access)");
  {
    const rConv = await apiCall({ method: "POST", path: "/api/tasks/convert-message", token: nonMemberToken, serverId, body: { messageId: pubPlainConvert } });
    check("non-member convert on public-channel message → 200", rConv.status === 200);
    const rClaim = await apiCall({ method: "PATCH", path: `/api/tasks/${pubTaskClaim}/claim`, token: nonMemberToken, serverId });
    check("non-member claim on public-channel task → 200", rClaim.status === 200);
  }

  console.log("\n[8] Regression: owner can mutate the private channel's task / action card");
  {
    const rStatus = await apiCall({ method: "PATCH", path: `/api/tasks/${privTaskOwner}/status`, token: ownerToken, serverId, body: { status: "done" } });
    check("owner status on private-channel task → 200", rStatus.status === 200);
    const rMark = await apiCall({ method: "POST", path: `/api/actions/${privActionOwner}/mark-executed`, token: ownerToken, serverId, body: {} });
    check("owner mark-executed on private-channel action → 200", rMark.status === 200);
  }
}

main()
  .then(cleanup)
  .then(() => {
    if (failures > 0) {
      console.log(`\n${failures} CHECK(S) FAILED`);
    } else {
      console.log("\nALL PASS");
    }
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (e) => {
    console.error("ERROR:", e);
    try { await cleanup(); } catch { /* */ }
    process.exit(1);
  });

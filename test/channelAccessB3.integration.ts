// Integration test: IDOR-B3 — attachment download + thread list/create channel-access gates.
//
// EXPECTED BEHAVIOUR (goal contract):
//   Endpoint                                         | BEFORE fix  | AFTER fix
//   ------------------------------------------------ | ----------- | ---------
//   GET  /api/attachments/:id  (private-ch)          | 200 (leak)  | 404
//   GET  /api/attachments/:id  (no-channel, foreign) | 200 (leak)  | 404
//   GET  /api/channels/:id/threads  (private-ch)     | 200+data    | 403
//   POST /api/channels/:id/threads  (private-ch)     | 200 (creates) | 403
//
// Regression (must always pass):
//   GET  /api/attachments/:id  by owner/member       → 200
//   GET  /api/channels/:id/threads  by owner         → 200+data
//   POST /api/channels/:id/threads  by owner         → 200
//   GET  /api/channels/:id/threads  public channel   → 200 for any server member
//
// Requires infra up: `npm run infra` (pg :5433, redis :6380).
// Run: npx tsx test/channelAccessB3.integration.ts
import "../src/env.js";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { handleApi } from "../src/server/routes-api/index.ts";
import { signUser } from "../src/server/auth.ts";
import { uploadsDir } from "../src/paths.ts";

const ts = Date.now();
let serverId = "";
let ownerId = "", nonMemberId = "";
let publicChId = "", privateChId = "";
let ownerToken = "", nonMemberToken = "";
let attachmentId = ""; // attachment belonging to the private channel
let serverOnlyAttachmentId = ""; // attachment with no channelId (avatar-style)
let privateMessageId = ""; // message in private channel that has a thread
let threadChId = ""; // the thread channel created on the private message
let publicMessageId = ""; // message in public channel that has a thread
let testStorageKey = ""; // the key we write to the uploads dir for testing
let failures = 0;

const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`);
  if (!cond) failures++;
};

// ── Mock HTTP helpers (identical to channelAccess.integration.ts) ─────────────────────────────

function makeReq(opts: {
  method: string;
  path: string;
  token: string;
  serverId?: string;
  body?: object;
}): IncomingMessage {
  const bodyStr = opts.body ? JSON.stringify(opts.body) : "";
  const readable = Readable.from(bodyStr ? [Buffer.from(bodyStr)] : ([] as Buffer[]));
  const headers: Record<string, string> = {
    authorization: `Bearer ${opts.token}`,
    "content-type": "application/json",
  };
  if (opts.serverId) headers["x-server-id"] = opts.serverId;
  return Object.assign(readable, {
    method: opts.method,
    url: opts.path,
    headers,
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

async function apiCall(opts: {
  method: string;
  path: string;
  token: string;
  serverId?: string;
  body?: object;
}): Promise<{ status: number; body: unknown }> {
  const PORT = Number(process.env.PORT ?? 7777);
  const req = makeReq(opts);
  const { res, getStatus, getBody } = makeRes();
  const url = new URL(opts.path, `http://localhost:${PORT}`);
  await handleApi(req, res, url, opts.method);
  let parsed: unknown;
  try { parsed = JSON.parse(getBody()); } catch { parsed = getBody(); }
  return { status: getStatus(), body: parsed };
}

// ── Setup / cleanup ────────────────────────────────────────────────────────────────────────────

async function setup() {
  // Two users in the same server
  const [u1] = await db.insert(schema.users).values({ name: `owner_b3_${ts}`, displayName: "Owner", email: `ob3_${ts}@t.local` }).returning();
  const [u2] = await db.insert(schema.users).values({ name: `nonmem_b3_${ts}`, displayName: "NonMember", email: `nb3_${ts}@t.local` }).returning();
  ownerId = u1!.id; nonMemberId = u2!.id;

  const [srv] = await db.insert(schema.servers).values({ name: "TB3", slug: `tb3-${ts}`, ownerId }).returning();
  serverId = srv!.id;
  await db.insert(schema.serverMembers).values([
    { serverId, userId: ownerId, role: "owner" },
    { serverId, userId: nonMemberId, role: "member" }, // server member, NOT a private-channel member
  ]);

  // Public channel — accessible to any server member
  const [pub] = await db.insert(schema.channels).values({ serverId, name: `pub-b3-${ts}`, type: "channel" }).returning();
  publicChId = pub!.id;
  await db.insert(schema.channelMembers).values({ channelId: publicChId, memberType: "user", memberId: ownerId });

  // Private channel — owner only
  const [priv] = await db.insert(schema.channels).values({ serverId, name: `priv-b3-${ts}`, type: "private" }).returning();
  privateChId = priv!.id;
  await db.insert(schema.channelMembers).values({ channelId: privateChId, memberType: "user", memberId: ownerId });

  // Seed a real file in the uploads directory so the download handler can serve it
  const uDir = uploadsDir();
  mkdirSync(uDir, { recursive: true });
  testStorageKey = `test-b3-${ts}.txt`;
  writeFileSync(path.join(uDir, testStorageKey), "secret-private-file-content");

  // Insert attachment row linked to the private channel (like a file shared in the channel)
  const [att] = await db.insert(schema.attachments).values({
    serverId,
    channelId: privateChId,
    uploaderType: "user",
    uploaderId: ownerId,
    filename: `secret-b3-${ts}.txt`,
    mimeType: "text/plain",
    sizeBytes: 28,
    storageKey: testStorageKey,
  }).returning();
  attachmentId = att!.id;

  // Insert an attachment with no channelId (avatar-style) — belongs to this server
  const [att2] = await db.insert(schema.attachments).values({
    serverId,
    channelId: null,
    uploaderType: "user",
    uploaderId: ownerId,
    filename: `avatar-b3-${ts}.txt`,
    mimeType: "text/plain",
    sizeBytes: 28,
    storageKey: testStorageKey, // reuse the same real file
  }).returning();
  serverOnlyAttachmentId = att2!.id;

  // Seed message + thread in private channel
  const [pm] = await db.insert(schema.messages).values({ serverId, channelId: privateChId, senderType: "user", senderId: ownerId, senderName: `owner_b3_${ts}`, content: "private-thread-parent", seq: 1 }).returning();
  privateMessageId = pm!.id;
  const [tch] = await db.insert(schema.channels).values({ serverId, name: `thread-priv-${ts}`, type: "thread", parentMessageId: privateMessageId }).returning();
  threadChId = tch!.id;
  await db.insert(schema.channelMembers).values({ channelId: threadChId, memberType: "user", memberId: ownerId });
  await db.insert(schema.messages).values({ serverId, channelId: threadChId, senderType: "user", senderId: ownerId, senderName: `owner_b3_${ts}`, content: "thread-reply-secret", seq: 1 });

  // Seed message in public channel for regression test
  const [pubMsg] = await db.insert(schema.messages).values({ serverId, channelId: publicChId, senderType: "user", senderId: ownerId, senderName: `owner_b3_${ts}`, content: "public-thread-parent", seq: 1 }).returning();
  publicMessageId = pubMsg!.id;

  ownerToken = signUser(ownerId);
  nonMemberToken = signUser(nonMemberId);
}

async function cleanup() {
  // Clean up the test file
  try { rmSync(path.join(uploadsDir(), testStorageKey)); } catch { /* ok */ }

  const chans = await db.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.serverId, serverId));
  const msgs = await db.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.serverId, serverId));
  for (const m of msgs) await db.delete(schema.messageMentions).where(eq(schema.messageMentions.messageId, m.id));
  await db.delete(schema.messages).where(eq(schema.messages.serverId, serverId));
  for (const c of chans) await db.delete(schema.channelMembers).where(eq(schema.channelMembers.channelId, c.id));
  await db.delete(schema.attachments).where(eq(schema.attachments.serverId, serverId));
  await db.delete(schema.channels).where(eq(schema.channels.serverId, serverId));
  await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, serverId));
  await db.delete(schema.servers).where(eq(schema.servers.id, serverId));
  await db.delete(schema.users).where(and(eq(schema.users.id, ownerId)));
  await db.delete(schema.users).where(and(eq(schema.users.id, nonMemberId)));
}

// ── Test cases ─────────────────────────────────────────────────────────────────────────────────

async function main() {
  await setup();

  // ── [1] GET /api/attachments/:id — private-channel attachment ──────────────────────────────
  // BEFORE fix: non-member gets 200 (file content served — IDOR)
  // AFTER  fix: non-member gets 404 (access denied)
  console.log("\n[1] GET /api/attachments/:id — private-channel attachment (channel-membership gate)");
  {
    const rOwner = await apiCall({ method: "GET", path: `/api/attachments/${attachmentId}`, token: ownerToken });
    check("owner (channel member) gets 200", rOwner.status === 200);

    const rNon = await apiCall({ method: "GET", path: `/api/attachments/${attachmentId}`, token: nonMemberToken });
    // On main: rNon.status === 200 (file served to non-member — the bug)
    // After fix: rNon.status === 404
    check("non-member gets 404 (not 200)", rNon.status === 404);
  }

  // ── [2] GET /api/attachments/:id — no-channel (server-scoped) attachment ───────────────────
  // An avatar belonging to a different server would get 404; same-server member gets 200.
  // (We don't have a second server in this test, so just verify same-server non-member is
  // still allowed to access no-channel attachments — avatars are semi-public within the server.)
  console.log("\n[2] GET /api/attachments/:id — no-channel (server avatar) attachment");
  {
    const rOwner = await apiCall({ method: "GET", path: `/api/attachments/${serverOnlyAttachmentId}`, token: ownerToken });
    check("owner gets 200 for server-avatar attachment", rOwner.status === 200);

    // Non-member is a server member → should also be allowed for no-channel attachments
    const rNon = await apiCall({ method: "GET", path: `/api/attachments/${serverOnlyAttachmentId}`, token: nonMemberToken });
    check("server member (non-channel-member) can access server-avatar attachment (server membership sufficient)", rNon.status === 200);
  }

  // ── [3] GET /api/channels/:id/threads — private channel, non-member ───────────────────────
  // BEFORE fix: non-member gets 200+data (thread replyCount/lastReplyAt leaked)
  // AFTER  fix: non-member gets 403
  console.log("\n[3] GET /api/channels/:id/threads — private channel, non-member blocked");
  {
    const path3 = `/api/channels/${privateChId}/threads?parentMessageIds=${privateMessageId}`;
    const rOwner = await apiCall({ method: "GET", path: path3, token: ownerToken, serverId });
    check("owner gets 200 and sees thread info", rOwner.status === 200);
    check("owner response includes the thread", JSON.stringify(rOwner.body).includes("threadChannelId") || JSON.stringify(rOwner.body).includes(threadChId));

    const rNon = await apiCall({ method: "GET", path: path3, token: nonMemberToken, serverId });
    // On main: rNon.status === 200 and body has replyCount (data leak)
    // After fix: rNon.status === 403
    check("non-member gets 403 (not 200+data)", rNon.status === 403);
    check("non-member response does NOT contain thread metadata", !JSON.stringify(rNon.body).includes("threadChannelId"));
  }

  // ── [4] POST /api/channels/:id/threads — private channel, non-member ─────────────────────
  // BEFORE fix: non-member can create a thread in a private channel (auto-joins it)
  // AFTER  fix: non-member gets 403
  console.log("\n[4] POST /api/channels/:id/threads — private channel, non-member blocked");
  {
    const path4 = `/api/channels/${privateChId}/threads`;
    const rNon = await apiCall({ method: "POST", path: path4, token: nonMemberToken, serverId, body: { parentMessageId: privateMessageId } });
    // On main: rNon.status === 200 (thread created — the bug)
    // After fix: rNon.status === 403
    check("non-member POST thread on private channel gets 403 (not 200)", rNon.status === 403);

    const rOwner = await apiCall({ method: "POST", path: path4, token: ownerToken, serverId, body: { parentMessageId: privateMessageId } });
    check("owner POST thread on private channel gets 200", rOwner.status === 200);
  }

  // ── [5] Regression: public channel threads accessible to any server member ───────────────
  console.log("\n[5] Regression: public channel threads accessible to any server member");
  {
    // Create a thread on the public message first (owner does this)
    await apiCall({ method: "POST", path: `/api/channels/${publicChId}/threads`, token: ownerToken, serverId, body: { parentMessageId: publicMessageId } });

    const rNon = await apiCall({ method: "GET", path: `/api/channels/${publicChId}/threads?parentMessageIds=${publicMessageId}`, token: nonMemberToken, serverId });
    check("non-member can GET threads on a public channel (public invariant)", rNon.status === 200);

    const rNonPost = await apiCall({ method: "POST", path: `/api/channels/${publicChId}/threads`, token: nonMemberToken, serverId, body: { parentMessageId: publicMessageId } });
    check("non-member can POST thread on a public channel (idempotent getOrCreate)", rNonPost.status === 200);
  }

  // ── [6] Regression: owner/member attachment download ─────────────────────────────────────
  // Already checked in [1], but make extra sure the fix doesn't break anything.
  console.log("\n[6] Regression: owner can download the private-channel attachment");
  {
    const r = await apiCall({ method: "GET", path: `/api/attachments/${attachmentId}`, token: ownerToken });
    check("owner still gets 200 for their own channel attachment", r.status === 200);
  }
}

main()
  .then(cleanup)
  .then(() => {
    if (failures > 0) {
      console.log(`\n${failures} CHECK(S) FAILED ❌`);
      console.log("  → If running on main (no fix): expected — these failures PROVE the IDOR bug exists.");
      console.log("  → If running after fix: unexpected — regression introduced.");
    } else {
      console.log("\nALL PASS ✅");
    }
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (e) => {
    console.error("ERROR:", e);
    try { await cleanup(); } catch { /* */ }
    process.exit(1);
  });

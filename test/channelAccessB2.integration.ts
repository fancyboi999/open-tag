// Integration test: IDOR-B2 — private-channel members/files/reactions IDOR guards.
// Tests: GET /api/channels/:id/members, GET /api/channels/:id/files,
//        POST /api/messages/:id/reactions
//
// EXPECTED BEHAVIOUR (goal contract):
//   - BEFORE fix: non-member gets 200+data  → checks FAIL (proves the IDOR bug on main)
//   - AFTER fix : non-member gets 404       → checks PASS
//
// Requires infra up: `npm run infra` (pg :5433, redis :6380).
// Run: npx tsx --env-file=.env test/channelAccessB2.integration.ts
import "../src/env.js";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { handleApi } from "../src/server/routes-api/index.ts";
import { signUser } from "../src/server/auth.ts";

const ts = Date.now();
let serverId = "";
let ownerId = "", nonMemberId = "";
let publicChId = "", privateChId = "", dmChId = "";
let privateMessageId = "";
let ownerToken = "", nonMemberToken = "";
let failures = 0;

const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`);
  if (!cond) failures++;
};

// ── Mock HTTP helpers (same pattern as channelAccess.integration.ts) ─────────

function makeReq(opts: {
  method: string;
  path: string;
  token: string;
  serverId: string;
  body?: object;
}): IncomingMessage {
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

async function apiCall(opts: {
  method: string;
  path: string;
  token: string;
  serverId: string;
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

// ── Setup / cleanup ───────────────────────────────────────────────────────────

async function setup() {
  const [u1] = await db.insert(schema.users).values({ name: `b2owner_${ts}`, displayName: "Owner", email: `b2o_${ts}@t.local` }).returning();
  const [u2] = await db.insert(schema.users).values({ name: `b2nonmem_${ts}`, displayName: "NonMember", email: `b2n_${ts}@t.local` }).returning();
  ownerId = u1!.id; nonMemberId = u2!.id;

  const [srv] = await db.insert(schema.servers).values({ name: "B2Test", slug: `b2t-${ts}`, ownerId }).returning();
  serverId = srv!.id;
  await db.insert(schema.serverMembers).values([
    { serverId, userId: ownerId, role: "owner" },
    { serverId, userId: nonMemberId, role: "member" }, // server member but NOT a channel member in private/DM
  ]);

  // Public channel — any server member may access
  const [pub] = await db.insert(schema.channels).values({ serverId, name: `b2pub-${ts}`, type: "channel" }).returning();
  publicChId = pub!.id;
  await db.insert(schema.channelMembers).values({ channelId: publicChId, memberType: "user", memberId: ownerId });

  // Private channel — owner is the only member
  const [priv] = await db.insert(schema.channels).values({ serverId, name: `b2priv-${ts}`, type: "private" }).returning();
  privateChId = priv!.id;
  await db.insert(schema.channelMembers).values({ channelId: privateChId, memberType: "user", memberId: ownerId });

  // DM channel — owner is the only human member
  const [dm] = await db.insert(schema.channels).values({ serverId, name: `b2dm-${ts}`, type: "dm" }).returning();
  dmChId = dm!.id;
  await db.insert(schema.channelMembers).values({ channelId: dmChId, memberType: "user", memberId: ownerId });

  // Seed a message in the private channel for the reactions test
  const [msg] = await db.insert(schema.messages).values({
    serverId,
    channelId: privateChId,
    senderType: "user",
    senderId: ownerId,
    senderName: `b2owner_${ts}`,
    content: "secret-private-message-b2",
    seq: 1,
  }).returning();
  privateMessageId = msg!.id;

  // Seed an attachment row in the private channel for the files test
  await db.insert(schema.attachments).values({
    serverId,
    channelId: privateChId,
    messageId: msg!.id, // messageId non-null so it appears in GET /files
    uploaderType: "user",
    uploaderId: ownerId,
    filename: "secret-file.txt",
    mimeType: "text/plain",
    sizeBytes: 42,
    storageKey: "/tmp/b2-secret-file.txt",
  });

  ownerToken = signUser(ownerId);
  nonMemberToken = signUser(nonMemberId);
}

async function cleanup() {
  const chans = await db.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.serverId, serverId));
  const msgs = await db.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.serverId, serverId));
  for (const m of msgs) {
    await db.delete(schema.reactions).where(eq(schema.reactions.messageId, m.id));
    await db.delete(schema.messageMentions).where(eq(schema.messageMentions.messageId, m.id));
  }
  await db.delete(schema.attachments).where(eq(schema.attachments.serverId, serverId));
  await db.delete(schema.messages).where(eq(schema.messages.serverId, serverId));
  for (const c of chans) await db.delete(schema.channelMembers).where(eq(schema.channelMembers.channelId, c.id));
  await db.delete(schema.channels).where(eq(schema.channels.serverId, serverId));
  await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, serverId));
  await db.delete(schema.servers).where(eq(schema.servers.id, serverId));
  await db.delete(schema.users).where(eq(schema.users.id, ownerId));
  await db.delete(schema.users).where(eq(schema.users.id, nonMemberId));
}

// ── Test cases ────────────────────────────────────────────────────────────────

async function main() {
  await setup();

  // ── [B2-1] GET /api/channels/:id/members — private channel ──────────────
  console.log("\n[B2-1] GET /api/channels/:id/members — private channel");
  const b2_1_owner = await apiCall({ method: "GET", path: `/api/channels/${privateChId}/members`, token: ownerToken, serverId });
  check("owner gets 200", b2_1_owner.status === 200);
  check("owner response has agents+humans fields", typeof (b2_1_owner.body as any)?.agents !== "undefined");

  const b2_1_non = await apiCall({ method: "GET", path: `/api/channels/${privateChId}/members`, token: nonMemberToken, serverId });
  check("non-member gets 404 (IDOR gate)", b2_1_non.status === 404);
  check("non-member response has no members list", typeof (b2_1_non.body as any)?.agents === "undefined");

  // ── [B2-1b] DM channel: non-party must be refused ───────────────────────
  console.log("\n[B2-1b] GET /api/channels/:id/members — DM channel");
  const b2_1b_non = await apiCall({ method: "GET", path: `/api/channels/${dmChId}/members`, token: nonMemberToken, serverId });
  check("non-party DM /members gets 404", b2_1b_non.status === 404);

  // ── [B2-1c] Regression: public channel members list is accessible ────────
  console.log("\n[B2-1c] GET /api/channels/:id/members — public channel (regression)");
  const b2_1c_non = await apiCall({ method: "GET", path: `/api/channels/${publicChId}/members`, token: nonMemberToken, serverId });
  check("server member can read public channel /members (regression)", b2_1c_non.status === 200);

  // ── [B2-2] GET /api/channels/:id/files — private channel ────────────────
  console.log("\n[B2-2] GET /api/channels/:id/files — private channel");
  const b2_2_owner = await apiCall({ method: "GET", path: `/api/channels/${privateChId}/files`, token: ownerToken, serverId });
  check("owner gets 200", b2_2_owner.status === 200);
  check("owner sees the seeded attachment", JSON.stringify(b2_2_owner.body).includes("secret-file.txt"));

  const b2_2_non = await apiCall({ method: "GET", path: `/api/channels/${privateChId}/files`, token: nonMemberToken, serverId });
  check("non-member gets 404 (IDOR gate)", b2_2_non.status === 404);
  check("non-member response does NOT expose file list", !JSON.stringify(b2_2_non.body).includes("secret-file.txt"));

  // ── [B2-2b] DM channel files: non-party refused ──────────────────────────
  console.log("\n[B2-2b] GET /api/channels/:id/files — DM channel");
  const b2_2b_non = await apiCall({ method: "GET", path: `/api/channels/${dmChId}/files`, token: nonMemberToken, serverId });
  check("non-party DM /files gets 404", b2_2b_non.status === 404);

  // ── [B2-2c] Regression: public channel files list accessible ─────────────
  console.log("\n[B2-2c] GET /api/channels/:id/files — public channel (regression)");
  const b2_2c_non = await apiCall({ method: "GET", path: `/api/channels/${publicChId}/files`, token: nonMemberToken, serverId });
  check("server member can read public channel /files (regression)", b2_2c_non.status === 200);

  // ── [B2-3] POST /api/messages/:id/reactions — private channel message ────
  console.log("\n[B2-3] POST /api/messages/:id/reactions — message in private channel");
  const b2_3_owner = await apiCall({ method: "POST", path: `/api/messages/${privateMessageId}/reactions`, token: ownerToken, serverId, body: { emoji: "👍" } });
  check("owner can react (200)", b2_3_owner.status === 200);

  const b2_3_non = await apiCall({ method: "POST", path: `/api/messages/${privateMessageId}/reactions`, token: nonMemberToken, serverId, body: { emoji: "🔥" } });
  check("non-member POST reaction gets 404 (IDOR gate)", b2_3_non.status === 404);

  // ── [B2-3b] DELETE reaction: non-member also blocked ─────────────────────
  console.log("\n[B2-3b] DELETE /api/messages/:id/reactions — message in private channel");
  const b2_3b_non = await apiCall({ method: "DELETE", path: `/api/messages/${privateMessageId}/reactions`, token: nonMemberToken, serverId, body: { emoji: "👍" } });
  check("non-member DELETE reaction gets 404 (IDOR gate)", b2_3b_non.status === 404);
}

main()
  .then(cleanup)
  .then(() => {
    if (failures > 0) {
      console.log(`\n${failures} CHECK(S) FAILED ❌`);
      console.log("  → If running before fix (on main): expected — proves IDOR-B2 bug exists.");
      console.log("  → If running after fix: unexpected — regression introduced.");
    } else {
      console.log("\nALL PASS ✅");
    }
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (e) => { console.error("ERROR:", e); try { await cleanup(); } catch { /**/ } process.exit(1); });

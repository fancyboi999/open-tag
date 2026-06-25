// Integration test: private-channel IDOR guard — non-member must not access messages/tasks.
// Tests: GET /api/messages/channel/:id, POST /api/messages, GET/POST /api/tasks/channel/:id
//
// EXPECTED BEHAVIOUR (goal contract):
//   - BEFORE fix: non-member gets 200+data  → checks FAIL (proves the bug on main)
//   - AFTER fix : non-member gets 403       → checks PASS
//
// Requires infra up: `npm run infra` (pg :5433, redis :6380).
// Run from the worktree root: npx tsx test/channelAccess.integration.ts
import "../src/env.js"; // load .env before any DB/auth/redis import
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
let ownerToken = "", nonMemberToken = "";
let failures = 0;

const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`);
  if (!cond) failures++;
};

// ── Mock HTTP helpers ─────────────────────────────────────────────────────────

/**
 * Build a minimal IncomingMessage-alike from a Readable stream + headers.
 * `handleApi` reads: req.headers (authorization, x-server-id), req.method (via ctx),
 * and the body via readJson (stream). We only need those three.
 */
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

/** Build a minimal ServerResponse-alike that captures writeHead + end output. */
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

/** Call handleApi with mock req/res and return { status, body }. */
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
  // Two users in the same server
  const [u1] = await db.insert(schema.users).values({ name: `owner_${ts}`, displayName: "Owner", email: `o_${ts}@t.local` }).returning();
  const [u2] = await db.insert(schema.users).values({ name: `nonmem_${ts}`, displayName: "NonMember", email: `n_${ts}@t.local` }).returning();
  ownerId = u1!.id; nonMemberId = u2!.id;

  const [srv] = await db.insert(schema.servers).values({ name: "T", slug: `t-${ts}`, ownerId }).returning();
  serverId = srv!.id;
  await db.insert(schema.serverMembers).values([
    { serverId, userId: ownerId, role: "owner" },
    { serverId, userId: nonMemberId, role: "member" }, // server member but NOT a channel member in private/DM
  ]);

  // Public channel — accessible to any server member
  const [pub] = await db.insert(schema.channels).values({ serverId, name: `pub-${ts}`, type: "channel" }).returning();
  publicChId = pub!.id;
  await db.insert(schema.channelMembers).values({ channelId: publicChId, memberType: "user", memberId: ownerId });

  // Private channel — owner is the only member
  const [priv] = await db.insert(schema.channels).values({ serverId, name: `priv-${ts}`, type: "private" }).returning();
  privateChId = priv!.id;
  await db.insert(schema.channelMembers).values({ channelId: privateChId, memberType: "user", memberId: ownerId });

  // DM channel — owner is the only human member
  const [dm] = await db.insert(schema.channels).values({ serverId, name: `dm-owner-bot-${ts}`, type: "dm" }).returning();
  dmChId = dm!.id;
  await db.insert(schema.channelMembers).values({ channelId: dmChId, memberType: "user", memberId: ownerId });

  // Seed a message in the private channel so the GET has something to return
  await db.insert(schema.messages).values({ serverId, channelId: privateChId, senderType: "user", senderId: ownerId, senderName: `owner_${ts}`, content: "secret-private-content", seq: 1 });

  ownerToken = signUser(ownerId);
  nonMemberToken = signUser(nonMemberId);
}

async function cleanup() {
  // FK-safe order scoped to this run's server
  const chans = await db.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.serverId, serverId));
  const msgs = await db.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.serverId, serverId));
  for (const m of msgs) await db.delete(schema.messageMentions).where(eq(schema.messageMentions.messageId, m.id));
  await db.delete(schema.messages).where(eq(schema.messages.serverId, serverId));
  for (const c of chans) await db.delete(schema.channelMembers).where(eq(schema.channelMembers.channelId, c.id));
  await db.delete(schema.channels).where(eq(schema.channels.serverId, serverId));
  await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, serverId));
  await db.delete(schema.servers).where(eq(schema.servers.id, serverId));
  await db.delete(schema.users).where(and(eq(schema.users.id, ownerId)));
  await db.delete(schema.users).where(and(eq(schema.users.id, nonMemberId)));
}

// ── Test cases ────────────────────────────────────────────────────────────────

async function main() {
  await setup();

  // ── [1] GET /api/messages/channel/:id — private channel ─────────────────
  console.log("\n[1] GET /api/messages/channel/:id — private channel");
  const r1owner = await apiCall({ method: "GET", path: `/api/messages/channel/${privateChId}`, token: ownerToken, serverId });
  check("owner (channel member) gets 200", r1owner.status === 200);
  const r1non = await apiCall({ method: "GET", path: `/api/messages/channel/${privateChId}`, token: nonMemberToken, serverId });
  check("non-member gets 403 (not 200+data)", r1non.status === 403);
  check("non-member body does NOT contain secret content", !JSON.stringify(r1non.body).includes("secret-private-content"));

  // ── [2] POST /api/messages — write to private channel ───────────────────
  console.log("\n[2] POST /api/messages — write to private channel");
  const r2non = await apiCall({ method: "POST", path: `/api/messages`, token: nonMemberToken, serverId, body: { channelId: privateChId, content: "injected-by-non-member" } });
  check("non-member POST gets 403", r2non.status === 403);
  const r2owner = await apiCall({ method: "POST", path: `/api/messages`, token: ownerToken, serverId, body: { channelId: privateChId, content: "owner-post" } });
  check("owner POST gets 200", r2owner.status === 200);

  // ── [3] GET /api/tasks/channel/:id — private channel ────────────────────
  console.log("\n[3] GET /api/tasks/channel/:id — private channel");
  const r3non = await apiCall({ method: "GET", path: `/api/tasks/channel/${privateChId}`, token: nonMemberToken, serverId });
  check("non-member GET tasks gets 403 (not 200)", r3non.status === 403);
  const r3owner = await apiCall({ method: "GET", path: `/api/tasks/channel/${privateChId}`, token: ownerToken, serverId });
  check("owner GET tasks gets 200", r3owner.status === 200);

  // ── [4] POST /api/tasks/channel/:id — create task in private channel ────
  console.log("\n[4] POST /api/tasks/channel/:id — create task in private channel");
  const r4non = await apiCall({ method: "POST", path: `/api/tasks/channel/${privateChId}`, token: nonMemberToken, serverId, body: { tasks: [{ title: "injected-task" }] } });
  check("non-member POST tasks gets 403", r4non.status === 403);
  const r4owner = await apiCall({ method: "POST", path: `/api/tasks/channel/${privateChId}`, token: ownerToken, serverId, body: { tasks: [{ title: "owner-task" }] } });
  check("owner POST tasks gets 200", r4owner.status === 200);

  // ── [5] Regression: public channel is still accessible to non-channel-members
  console.log("\n[5] Regression: public channel accessible to server member (not yet in channel)");
  const r5non = await apiCall({ method: "GET", path: `/api/messages/channel/${publicChId}`, token: nonMemberToken, serverId });
  check("server member can read public channel (invariant: public = open)", r5non.status === 200);

  // ── [6] DM channel: non-party must be refused ────────────────────────────
  console.log("\n[6] DM channel: non-party must be refused");
  const r6non = await apiCall({ method: "GET", path: `/api/messages/channel/${dmChId}`, token: nonMemberToken, serverId });
  check("non-party cannot read a DM channel", r6non.status === 403);
  const r6owner = await apiCall({ method: "GET", path: `/api/messages/channel/${dmChId}`, token: ownerToken, serverId });
  check("DM party can read the DM channel", r6owner.status === 200);

  // ── [7] GET /api/tasks/server — server-wide board must NOT leak private-channel tasks ─
  // First create a task in the private channel so there is something to find
  console.log("\n[7] GET /api/tasks/server — private channel tasks must not appear to non-members");
  await apiCall({ method: "POST", path: `/api/tasks/channel/${privateChId}`, token: ownerToken, serverId, body: { tasks: [{ title: "private-task-leak-test" }] } });
  const r7non = await apiCall({ method: "GET", path: `/api/tasks/server`, token: nonMemberToken, serverId });
  check("tasks/server returns 200 for server member", r7non.status === 200);
  check("non-member tasks/server does NOT include private channel task", !JSON.stringify(r7non.body).includes("private-task-leak-test"));
  const r7owner = await apiCall({ method: "GET", path: `/api/tasks/server`, token: ownerToken, serverId });
  check("owner tasks/server DOES include the private channel task", JSON.stringify(r7owner.body).includes("private-task-leak-test"));
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
  .catch(async (e) => { console.error("ERROR:", e); try { await cleanup(); } catch { /**/ } process.exit(1); });

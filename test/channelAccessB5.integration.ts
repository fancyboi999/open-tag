// Integration test: IDOR-B5 — POST /api/channels/saved channel-access gate.
//
// A same-tenant non-member of a private/DM channel must not be able to bookmark that channel's
// message by supplying a known message UUID — and thereby read its full content via GET /saved.
//
//   Endpoint                                          | BEFORE fix     | AFTER fix
//   ------------------------------------------------- | -------------- | ---------
//   POST /api/channels/saved (private-ch message)     | 200 (saves)    | 404
//   GET  /api/channels/saved (after the breach above) | leaks content  | no content
//   POST /api/channels/saved (DM-ch message)          | 200 (saves)    | 404
//
// Regression (must always pass):
//   non-member POST /saved on a PUBLIC channel message → 200
//   owner (channel member) POST /saved on a PRIVATE channel message → 200, content visible in GET /saved
//
// 404 (not 403) on denial matches the existing reactions guard (IDOR-B2) and IDOR-B4: by-message-id
// writes hide existence — a non-member can't tell "no access" from "doesn't exist".
//
// Run from the worktree: npx tsx test/channelAccessB5.integration.ts
import "../src/env.js";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { handleApi } from "../src/server/routes-api/index.ts";
import { signUser } from "../src/server/auth.ts";

const ts = Date.now();
const SECRET = `secret-private-content-${ts}`;
const SECRET_DM = `secret-dm-content-${ts}`;
let serverId = "";
let ownerId = "", nonMemberId = "";
let publicChId = "", privateChId = "", dmChId = "";
let ownerToken = "", nonMemberToken = "";
let privMsg = "", pubMsg = "", dmMsg = "", ownerPrivMsg = "";
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

async function seedMsg(channelId: string, content: string): Promise<string> {
  const [m] = await db.insert(schema.messages).values({
    serverId, channelId, senderType: "user", senderId: ownerId, senderName: `owner_b5_${ts}`,
    content, seq: seqCounter++,
  }).returning();
  return m!.id;
}

async function setup() {
  const [u1] = await db.insert(schema.users).values({ name: `owner_b5_${ts}`, displayName: "Owner", email: `ob5_${ts}@t.local` }).returning();
  const [u2] = await db.insert(schema.users).values({ name: `nonmem_b5_${ts}`, displayName: "NonMember", email: `nb5_${ts}@t.local` }).returning();
  ownerId = u1!.id; nonMemberId = u2!.id;

  const [srv] = await db.insert(schema.servers).values({ name: "TB5", slug: `tb5-${ts}`, ownerId }).returning();
  serverId = srv!.id;
  await db.insert(schema.serverMembers).values([
    { serverId, userId: ownerId, role: "owner" },
    { serverId, userId: nonMemberId, role: "member" }, // server member, NOT a private/DM-channel member
  ]);

  const [pub] = await db.insert(schema.channels).values({ serverId, name: `pub-b5-${ts}`, type: "channel" }).returning();
  publicChId = pub!.id;
  await db.insert(schema.channelMembers).values({ channelId: publicChId, memberType: "user", memberId: ownerId });

  const [priv] = await db.insert(schema.channels).values({ serverId, name: `priv-b5-${ts}`, type: "private" }).returning();
  privateChId = priv!.id;
  await db.insert(schema.channelMembers).values({ channelId: privateChId, memberType: "user", memberId: ownerId });

  const [dm] = await db.insert(schema.channels).values({ serverId, name: `dm-b5-${ts}`, type: "dm" }).returning();
  dmChId = dm!.id;
  await db.insert(schema.channelMembers).values({ channelId: dmChId, memberType: "user", memberId: ownerId });

  privMsg = await seedMsg(privateChId, SECRET);
  ownerPrivMsg = await seedMsg(privateChId, `owner-own-${ts}`);
  pubMsg = await seedMsg(publicChId, `public-content-${ts}`);
  dmMsg = await seedMsg(dmChId, SECRET_DM);

  ownerToken = signUser(ownerId);
  nonMemberToken = signUser(nonMemberId);
}

async function cleanup() {
  const msgs = await db.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.serverId, serverId));
  for (const m of msgs) await db.delete(schema.messageMentions).where(eq(schema.messageMentions.messageId, m.id));
  await db.delete(schema.savedMessages).where(eq(schema.savedMessages.serverId, serverId));
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

  console.log("\n[1] POST /api/channels/saved — non-member cannot bookmark a private-channel message");
  {
    const r = await apiCall({ method: "POST", path: "/api/channels/saved", token: nonMemberToken, serverId, body: { messageId: privMsg } });
    check("non-member save of private-channel message → 404 (not 200)", r.status === 404);
  }

  console.log("\n[2] GET /api/channels/saved — the private content must NOT leak into the non-member's saved list");
  {
    const r = await apiCall({ method: "GET", path: "/api/channels/saved", token: nonMemberToken, serverId });
    // On main: [1] saved it (200), so the secret content leaks here → this check FAILs (proves the IDOR).
    // After fix: [1] was 404, nothing saved → content absent → passes.
    check("non-member saved list does NOT contain the private content", !JSON.stringify(r.body).includes(SECRET));
  }

  console.log("\n[3] POST /api/channels/saved — non-member cannot bookmark a DM-channel message");
  {
    const r = await apiCall({ method: "POST", path: "/api/channels/saved", token: nonMemberToken, serverId, body: { messageId: dmMsg } });
    check("non-member save of DM-channel message → 404 (not 200)", r.status === 404);
  }

  console.log("\n[4] Regression: non-member CAN bookmark a PUBLIC channel message (server-member access)");
  {
    const r = await apiCall({ method: "POST", path: "/api/channels/saved", token: nonMemberToken, serverId, body: { messageId: pubMsg } });
    check("non-member save of public-channel message → 200", r.status === 200);
  }

  console.log("\n[5] Regression: owner CAN bookmark their own private-channel message, content visible in GET /saved");
  {
    const rSave = await apiCall({ method: "POST", path: "/api/channels/saved", token: ownerToken, serverId, body: { messageId: ownerPrivMsg } });
    check("owner save of own private-channel message → 200", rSave.status === 200);
    const rList = await apiCall({ method: "GET", path: "/api/channels/saved", token: ownerToken, serverId });
    check("owner saved list contains their own private message", JSON.stringify(rList.body).includes(`owner-own-${ts}`));
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

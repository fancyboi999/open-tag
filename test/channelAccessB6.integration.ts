// Integration test: IDOR-B5 residual — read-time channel-access gate on listSaved (GET /api/channels/saved).
//
// B5 closed the WRITE path (POST /saved now checks canUserReadChannel). But listSaved (the READ path)
// still returned a saved message's `content` with no current-access re-check, leaking two ways:
//   (1) a LEGITIMATELY-saved bookmark whose saver LATER lost access (removed from the channel / channel
//       turned private) still showed its content snapshot;
//   (2) an illegitimate saved row created BEFORE the B5 write-fix (or by any other path) still leaked.
//
//   Scenario                                              | BEFORE fix     | AFTER fix
//   ----------------------------------------------------- | -------------- | ---------
//   [1] member saves private msg, THEN loses membership   | content leaks  | hidden
//   [2] pre-fix illegitimate saved row (never a member)   | content leaks  | hidden
//   [3] regression: still-accessible saved (public / own) | visible        | visible
//
// Read-time gate hides (does not delete) the row: re-gaining access shows it again. Pagination keeps the
// limit+1 probe; filtered rows occupy a slot, so a page may return < limit items but hasMore stays correct.
//
// Run from the worktree: npx tsx test/channelAccessB6.integration.ts
import "../src/env.js";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { handleApi } from "../src/server/routes-api/index.ts";
import { signUser } from "../src/server/auth.ts";

const ts = Date.now();
const SECRET = `secret-private-content-${ts}`;
const OWNER_SECRET = `owner-private-content-${ts}`;
const PUB = `public-content-${ts}`;
let serverId = "";
let ownerId = "", user2Id = "", user3Id = "";
let publicChId = "", privateChId = "";
let ownerToken = "", user2Token = "", user3Token = "";
let privMsg = "", pubMsg = "", ownerPrivMsg = "";
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
    serverId, channelId, senderType: "user", senderId: ownerId, senderName: `owner_b6_${ts}`, content, seq: seqCounter++,
  }).returning();
  return m!.id;
}

async function setup() {
  const [u1] = await db.insert(schema.users).values({ name: `owner_b6_${ts}`, displayName: "Owner", email: `ob6_${ts}@t.local` }).returning();
  const [u2] = await db.insert(schema.users).values({ name: `user2_b6_${ts}`, displayName: "User2", email: `u2b6_${ts}@t.local` }).returning();
  const [u3] = await db.insert(schema.users).values({ name: `user3_b6_${ts}`, displayName: "User3", email: `u3b6_${ts}@t.local` }).returning();
  ownerId = u1!.id; user2Id = u2!.id; user3Id = u3!.id;

  const [srv] = await db.insert(schema.servers).values({ name: "TB6", slug: `tb6-${ts}`, ownerId }).returning();
  serverId = srv!.id;
  await db.insert(schema.serverMembers).values([
    { serverId, userId: ownerId, role: "owner" },
    { serverId, userId: user2Id, role: "member" },
    { serverId, userId: user3Id, role: "member" }, // server members; channel membership varies
  ]);

  const [pub] = await db.insert(schema.channels).values({ serverId, name: `pub-b6-${ts}`, type: "channel" }).returning();
  publicChId = pub!.id;
  await db.insert(schema.channelMembers).values({ channelId: publicChId, memberType: "user", memberId: ownerId });

  const [priv] = await db.insert(schema.channels).values({ serverId, name: `priv-b6-${ts}`, type: "private" }).returning();
  privateChId = priv!.id;
  // owner stays a member; user2 starts as a member (so the save is legitimate) and is removed later.
  await db.insert(schema.channelMembers).values([
    { channelId: privateChId, memberType: "user", memberId: ownerId },
    { channelId: privateChId, memberType: "user", memberId: user2Id },
  ]);

  privMsg = await seedMsg(privateChId, SECRET);
  ownerPrivMsg = await seedMsg(privateChId, OWNER_SECRET);
  pubMsg = await seedMsg(publicChId, PUB);

  ownerToken = signUser(ownerId);
  user2Token = signUser(user2Id);
  user3Token = signUser(user3Id);
}

async function cleanup() {
  await db.delete(schema.savedMessages).where(eq(schema.savedMessages.serverId, serverId));
  const msgs = await db.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.serverId, serverId));
  for (const m of msgs) await db.delete(schema.messageMentions).where(eq(schema.messageMentions.messageId, m.id));
  await db.delete(schema.messages).where(eq(schema.messages.serverId, serverId));
  const chans = await db.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.serverId, serverId));
  for (const c of chans) await db.delete(schema.channelMembers).where(eq(schema.channelMembers.channelId, c.id));
  await db.delete(schema.channels).where(eq(schema.channels.serverId, serverId));
  await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, serverId));
  await db.delete(schema.servers).where(eq(schema.servers.id, serverId));
  for (const uid of [ownerId, user2Id, user3Id]) await db.delete(schema.users).where(eq(schema.users.id, uid));
}

async function main() {
  await setup();

  console.log("\n[1] member saves a private-channel msg legitimately, THEN loses membership → content must be hidden");
  {
    const rSave = await apiCall({ method: "POST", path: "/api/channels/saved", token: user2Token, serverId, body: { messageId: privMsg } });
    check("setup: user2 (a member) saves the private message → 200", rSave.status === 200);
    // user2 loses access: removed from the private channel
    await db.delete(schema.channelMembers).where(and(eq(schema.channelMembers.channelId, privateChId), eq(schema.channelMembers.memberType, "user"), eq(schema.channelMembers.memberId, user2Id)));
    const rList = await apiCall({ method: "GET", path: "/api/channels/saved", token: user2Token, serverId });
    // On main: content still leaks. After fix: hidden.
    check("after losing membership, GET /saved does NOT contain the private content", !JSON.stringify(rList.body).includes(SECRET));
  }

  console.log("\n[2] a pre-fix illegitimate saved row (user3 was NEVER a member) → content must be hidden");
  {
    await db.insert(schema.savedMessages).values({ serverId, messageId: privMsg, memberType: "user", memberId: user3Id }).onConflictDoNothing();
    const rList = await apiCall({ method: "GET", path: "/api/channels/saved", token: user3Token, serverId });
    // On main: content leaks (the row exists, listSaved returns its content). After fix: hidden.
    check("illegitimate saved row's private content is NOT returned to a non-member", !JSON.stringify(rList.body).includes(SECRET));
  }

  console.log("\n[3] Regression: still-accessible saved messages stay visible");
  {
    // user2 can still bookmark + see a PUBLIC channel message
    const rSavePub = await apiCall({ method: "POST", path: "/api/channels/saved", token: user2Token, serverId, body: { messageId: pubMsg } });
    check("user2 saves a public-channel message → 200", rSavePub.status === 200);
    const rUser2 = await apiCall({ method: "GET", path: "/api/channels/saved", token: user2Token, serverId });
    check("user2 GET /saved still contains the public content", JSON.stringify(rUser2.body).includes(PUB));
    check("user2 GET /saved still does NOT contain the now-inaccessible private content", !JSON.stringify(rUser2.body).includes(SECRET));

    // owner (still a private-channel member) bookmarks + sees their own private message
    const rSaveOwner = await apiCall({ method: "POST", path: "/api/channels/saved", token: ownerToken, serverId, body: { messageId: ownerPrivMsg } });
    check("owner saves their own private message → 200", rSaveOwner.status === 200);
    const rOwner = await apiCall({ method: "GET", path: "/api/channels/saved", token: ownerToken, serverId });
    check("owner (still a member) GET /saved contains their private content", JSON.stringify(rOwner.body).includes(OWNER_SECRET));
  }
}

main()
  .then(cleanup)
  .then(() => {
    if (failures > 0) console.log(`\n${failures} CHECK(S) FAILED`);
    else console.log("\nALL PASS");
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (e) => {
    console.error("ERROR:", e);
    try { await cleanup(); } catch { /* */ }
    process.exit(1);
  });

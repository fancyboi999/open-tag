// Bug I36: thread channels slip past guards in routes-agent.ts (server/info) and routes-api/channels.ts
// (PATCH / join / leave / archive). These tests FAIL on origin/main and PASS after the fix.
//
// Requires infra up: `npm run infra` (pg :5433, redis :6380).
// Run: npx tsx test/threadChannelGuards.integration.ts
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { createMessage, getOrCreateThread } from "../src/server/core.ts";
import { handleChannels } from "../src/server/routes-api/channels.ts";
import { handleAgentApi } from "../src/server/routes-agent.ts";

const ts = Date.now();
let serverId = "", ownerId = "";
let agentId = "";
const agentToken = `sk_agent_test_${ts}`; // raw token — hash stored in DB
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
let failures = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`);
  if (!cond) failures++;
};

// --- HTTP mock helpers ---

/** Minimal IncomingMessage for agent-api routes: adds Bearer + x-agent-id headers. */
function mockAgentReq(method: string, agId: string): IncomingMessage {
  const stream = Readable.from([""]) as unknown as IncomingMessage;
  (stream as any).method = method;
  (stream as any).headers = {
    authorization: `Bearer ${agentToken}`,
    "x-agent-id": agId,
  };
  (stream as any).url = "";
  return stream;
}

/** Minimal IncomingMessage stand-in backed by a Readable (so readJson works). */
function mockReq(method: string, body: object = {}): IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
  (stream as any).method = method;
  (stream as any).headers = {};
  (stream as any).url = "";
  return stream;
}

/** Captures status code + parsed response body. */
function mockRes(): { res: ServerResponse; status: () => number; body: () => any } {
  let _status = 0;
  let _raw = "";
  const res = {
    writeHead: (code: number) => { _status = code; },
    end: (s: string) => { _raw = s; },
  } as unknown as ServerResponse;
  return {
    res,
    status: () => _status,
    body: () => { try { return JSON.parse(_raw); } catch { return {}; } },
  };
}

/** Build a minimal ServerCtx for handleChannels. */
function ctx(method: string, p: string, req: IncomingMessage, res: ServerResponse) {
  return { req, res, url: new URL(`http://localhost${p}`), method, p, userId: ownerId, serverId };
}

// --- Lifecycle ---

async function setup() {
  const [u] = await db.insert(schema.users)
    .values({ name: `owner_${ts}`, displayName: "Owner", email: `o_${ts}@t.local` }).returning();
  ownerId = u!.id;
  const [srv] = await db.insert(schema.servers)
    .values({ name: "T", slug: `tg-${ts}`, ownerId }).returning();
  serverId = srv!.id;
  await db.insert(schema.serverMembers).values({ serverId, userId: ownerId, role: "owner" });
  const [ag] = await db.insert(schema.agents)
    .values({ serverId, name: `agent_${ts}`, displayName: "Agent", agentTokenHash: hashToken(agentToken) }).returning();
  agentId = ag!.id;
  const [c] = await db.insert(schema.channels)
    .values({ serverId, name: `ch-${ts}`, type: "channel" }).returning();
  await db.insert(schema.channelMembers)
    .values({ channelId: c!.id, memberType: "user", memberId: ownerId });
}

async function cleanup() {
  const chans = await db.select({ id: schema.channels.id }).from(schema.channels)
    .where(eq(schema.channels.serverId, serverId));
  const msgs = await db.select({ id: schema.messages.id }).from(schema.messages)
    .where(eq(schema.messages.serverId, serverId));
  for (const m of msgs)
    await db.delete(schema.messageMentions).where(eq(schema.messageMentions.messageId, m.id));
  await db.delete(schema.messages).where(eq(schema.messages.serverId, serverId));
  for (const c of chans)
    await db.delete(schema.channelMembers).where(eq(schema.channelMembers.channelId, c.id));
  await db.delete(schema.channels).where(eq(schema.channels.serverId, serverId));
  await db.delete(schema.agents).where(eq(schema.agents.serverId, serverId));
  await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, serverId));
  await db.delete(schema.servers).where(eq(schema.servers.id, serverId));
  await db.delete(schema.users).where(eq(schema.users.id, ownerId));
}

// --- Tests ---

async function main() {
  await setup();

  // Fetch the public channel and create a thread on a message in it.
  const pubCh = (await db.select().from(schema.channels)
    .where(and(eq(schema.channels.serverId, serverId), eq(schema.channels.name, `ch-${ts}`))))[0]!;
  const parent = await createMessage({
    serverId,
    channelId: pubCh.id,
    senderType: "user",
    senderId: ownerId,
    senderName: `owner_${ts}`,
    content: "parent message for thread guard tests",
  });
  // getOrCreateThread creates a channel with type="thread" and name="thread-<shortid>"
  const threadCh = await getOrCreateThread(serverId, parent.id, { type: "agent", id: agentId });

  // Add the agent to the thread as a member (simulating auto-join from @-mention, per I35).
  // This is the precondition for the server/info leak: the agent joined the thread, so
  // joined.has(threadCh.id) is true, and the broken filter lets it through.
  await db.insert(schema.channelMembers)
    .values({ channelId: threadCh.id, memberType: "agent", memberId: agentId })
    .onConflictDoNothing();

  // ── [1] routes-agent.ts server/info must NOT expose thread channels ──────────────────────────
  // Calls the ACTUAL handleAgentApi with a real agent token so the filter in routes-agent.ts is
  // exercised. On main: c.type !== "dm" lets the thread (joined by the agent) leak. After fix:
  // c.type !== "thread" is added and the thread is absent.
  console.log("\n[1] server/info: thread channel must NOT appear in agent channels list");
  {
    const { res, status, body } = mockRes();
    const req = mockAgentReq("GET", agentId);
    const infoUrl = new URL("http://localhost/agent-api/server/info");
    await handleAgentApi(req, res, infoUrl, "GET");
    check("server/info returns 200", status() === 200);
    const channels: { name: string }[] = body().channels ?? [];
    const threadInList = channels.some((c) => c.name === threadCh.name);
    // On main: threadInList is true (thread-xxxx name leaks) → FAILS
    // After fix: threadInList is false → PASSES
    check("thread channel does NOT appear in server/info channels list", !threadInList);
    check("thread channel has internal name 'thread-...' (confirming it is an internal channel)", threadCh.name.startsWith("thread-"));
    check("public channel still appears in server/info (fix must not over-filter)", channels.some((c) => c.name === `ch-${ts}`));
  }

  // ── [2] PATCH /api/channels/:id must return 403 for a thread channel ─────────────────────────
  // On main: the handler applies the type change (returns 200). After fix: 403.
  console.log("\n[2] PATCH /api/channels/:id: must reject a thread channel with 403");
  {
    const path = `/api/channels/${threadCh.id}`;
    const { res, status, body } = mockRes();
    const req = mockReq("PATCH", { visibility: "channel" });
    await handleChannels(ctx("PATCH", path, req, res));
    check("PATCH thread channel returns 403", status() === 403);
    check("error body mentions thread", (body().error ?? "").toLowerCase().includes("thread"));
    // Confirm the thread channel's type was NOT mutated (double-check DB)
    const after = (await db.select({ type: schema.channels.type }).from(schema.channels)
      .where(eq(schema.channels.id, threadCh.id)))[0];
    check("thread channel type was NOT mutated in DB", after?.type === "thread");
  }

  // ── [3] POST /api/channels/:id/join must return 403 for a thread channel ─────────────────────
  // On main: inserts into channelMembers and returns 200. After fix: 403.
  console.log("\n[3] POST /api/channels/:id/join: must reject a thread channel with 403");
  {
    const path = `/api/channels/${threadCh.id}/join`;
    const { res, status } = mockRes();
    const req = mockReq("POST");
    await handleChannels(ctx("POST", path, req, res));
    check("join thread channel returns 403", status() === 403);
  }

  // ── [4] POST /api/channels/:id/leave must return 403 for a thread channel ────────────────────
  // On main: deletes from channelMembers (or no-ops) and returns 200. After fix: 403.
  console.log("\n[4] POST /api/channels/:id/leave: must reject a thread channel with 403");
  {
    const path = `/api/channels/${threadCh.id}/leave`;
    const { res, status } = mockRes();
    const req = mockReq("POST");
    await handleChannels(ctx("POST", path, req, res));
    check("leave thread channel returns 403", status() === 403);
  }

  // ── [5] POST /api/channels/:id/archive must return 403 for a thread channel ─────────────────
  // Owner has manageChannels → currently succeeds (returns 200). After fix: 403.
  console.log("\n[5] POST /api/channels/:id/archive: must reject a thread channel with 403 (even for owner)");
  {
    const path = `/api/channels/${threadCh.id}/archive`;
    const { res, status } = mockRes();
    const req = mockReq("POST");
    await handleChannels(ctx("POST", path, req, res));
    check("archive thread channel returns 403", status() === 403);
    // Confirm not actually archived
    const after = (await db.select({ archivedAt: schema.channels.archivedAt }).from(schema.channels)
      .where(eq(schema.channels.id, threadCh.id)))[0];
    check("thread channel was NOT archived in DB", after?.archivedAt == null);
  }

  // ── Regression: public channel operations still work ─────────────────────────────────────────
  // These should all return 200 to confirm we haven't broken normal channels.
  console.log("\n[6] Regression: public channel join/leave/archive still work (not broken by fix)");
  {
    // join (no-op: owner is already a member but onConflictDoNothing keeps it safe)
    const { res: rJoin, status: sJoin } = mockRes();
    await handleChannels(ctx("POST", `/api/channels/${pubCh.id}/join`, mockReq("POST"), rJoin));
    check("public channel join still returns 200", sJoin() === 200);

    // archive (owner has manageChannels)
    const { res: rArch, status: sArch } = mockRes();
    await handleChannels(ctx("POST", `/api/channels/${pubCh.id}/archive`, mockReq("POST"), rArch));
    check("public channel archive still returns 200", sArch() === 200);

    // unarchive to clean state
    const { res: rUn } = mockRes();
    await handleChannels(ctx("POST", `/api/channels/${pubCh.id}/unarchive`, mockReq("POST"), rUn));
  }
}

main()
  .then(cleanup)
  .then(() => {
    console.log(`\n${failures === 0 ? "ALL PASS ✅" : `${failures} CHECK(S) FAILED ❌`}`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (e) => {
    console.error("ERROR:", e);
    try { await cleanup(); } catch { /* */ }
    process.exit(1);
  });

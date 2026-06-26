// Integration test: #showcase channel read access + write intercepts.
// Tests five write blocks (403) and three read passthroughs (200).
//
// EXPECTED BEHAVIOUR (goal contract):
//   Read  paths: any server member may read the showcase channel.
//   Write paths: every write attempt returns 403 regardless of caller role.
//
// Requires infra up: `npm run infra` (pg :5433, redis :6380).
// Run from the worktree root: npx tsx test/showcase.integration.ts
import "../src/env.js";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, schema, sql } from "../src/db/index.ts";
import { handleApi } from "../src/server/routes-api/index.ts";
import { handleAgentApi } from "../src/server/routes-agent.ts";
import { signUser } from "../src/server/auth.ts";
import { createHash } from "node:crypto";

const ts = Date.now();
let serverId = "";
let userId = "";
let showcaseChId = "";
let anchorMsgId = "";
let userToken = "";
let agentId = "";
let agentToken = "";
let failures = 0;

const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`);
  if (!cond) failures++;
};

// ── Mock HTTP helpers ─────────────────────────────────────────────────────────

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
  let status = 0; let body = "";
  const emitter = new EventEmitter();
  const res = Object.assign(emitter, {
    statusCode: 0, headersSent: false,
    setHeader(_n: string, _v: unknown) {},
    writeHead(code: number) { status = code; this.statusCode = code; },
    end(d?: string | Buffer) { body = d ? String(d) : ""; emitter.emit("finish"); },
  }) as unknown as ServerResponse;
  return { res, getStatus: () => status, getBody: () => body };
}

async function apiCall(opts: { method: string; path: string; token: string; serverId: string; body?: object }): Promise<{ status: number; body: unknown }> {
  const PORT = Number(process.env.PORT ?? 7777);
  const req = makeReq(opts);
  const { res, getStatus, getBody } = makeRes();
  const url = new URL(opts.path, `http://localhost:${PORT}`);
  await handleApi(req, res, url, opts.method);
  let parsed: unknown;
  try { parsed = JSON.parse(getBody()); } catch { parsed = getBody(); }
  return { status: getStatus(), body: parsed };
}

// Agent-plane mock request (uses x-agent-id + Bearer sk_agent_*)
function makeAgentReq(opts: { method: string; path: string; agentToken: string; agentId: string; serverId: string; body?: object }): IncomingMessage {
  const bodyStr = opts.body ? JSON.stringify(opts.body) : "";
  const readable = Readable.from(bodyStr ? [Buffer.from(bodyStr)] : ([] as Buffer[]));
  return Object.assign(readable, {
    method: opts.method,
    url: opts.path,
    headers: {
      authorization: `Bearer ${opts.agentToken}`,
      "x-agent-id": opts.agentId,
      "x-server-id": opts.serverId,
      "content-type": "application/json",
    },
  }) as unknown as IncomingMessage;
}

async function agentApiCall(opts: { method: string; path: string; agentToken: string; agentId: string; serverId: string; body?: object }): Promise<{ status: number; body: unknown }> {
  const PORT = Number(process.env.PORT ?? 7777);
  const req = makeAgentReq(opts);
  const { res, getStatus, getBody } = makeRes();
  const url = new URL(opts.path, `http://localhost:${PORT}`);
  await handleAgentApi(req, res, url, opts.method);
  let parsed: unknown;
  try { parsed = JSON.parse(getBody()); } catch { parsed = getBody(); }
  return { status: getStatus(), body: parsed };
}

// ── Setup / cleanup ───────────────────────────────────────────────────────────

async function setup() {
  const [u] = await db.insert(schema.users).values({ name: `sc_user_${ts}`, displayName: "SC User", email: `sc_${ts}@t.local` }).returning();
  userId = u!.id;
  userToken = signUser(userId);

  const [srv] = await db.insert(schema.servers).values({ name: "SC", slug: `sc-${ts}`, ownerId: userId }).returning();
  serverId = srv!.id;
  await db.insert(schema.serverMembers).values({ serverId, userId, role: "owner" });

  // Create a showcase channel (type="showcase") — world-readable, write-blocked
  const [sc] = await db.insert(schema.channels).values({ serverId, name: "showcase", type: "showcase", description: "Read-only showcase" }).returning();
  showcaseChId = sc!.id;

  // Seed one anchor message so thread-creation test has a parentMessageId
  const [msg] = await db.insert(schema.messages).values({ serverId, channelId: showcaseChId, senderType: "user", senderId: userId, senderName: `sc_user_${ts}`, content: "Case 1 anchor", seq: 1 }).returning();
  anchorMsgId = msg!.id;

  // Create a test agent with a known token
  const rawToken = `sk_agent_sc_${ts}`;
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const [ag] = await db.insert(schema.agents).values({
    serverId, machineId: null, name: `sc_bot_${ts}`, displayName: "SC Bot",
    agentTokenHash: tokenHash, status: "active", activity: "online",
    model: "sonnet", runtime: "claude", runtimeConfig: {}, executionMode: "auto", envVars: {},
    creatorType: "user", creatorId: userId,
  }).returning();
  agentId = ag!.id;
  agentToken = rawToken;
}

async function cleanup() {
  const chans = await db.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.serverId, serverId));
  const msgs = await db.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.serverId, serverId));
  for (const m of msgs) await db.delete(schema.messageMentions).where(eq(schema.messageMentions.messageId, m.id));
  await db.delete(schema.messages).where(eq(schema.messages.serverId, serverId));
  for (const c of chans) await db.delete(schema.channelMembers).where(eq(schema.channelMembers.channelId, c.id));
  await db.delete(schema.agents).where(eq(schema.agents.serverId, serverId));
  await db.delete(schema.channels).where(eq(schema.channels.serverId, serverId));
  await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, serverId));
  await db.delete(schema.servers).where(eq(schema.servers.id, serverId));
  await db.delete(schema.users).where(eq(schema.users.id, userId));
  await sql.end();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function main() {
  await setup();

  // ── READ passthrough 1: showcase appears in /api/channels list ───────────
  console.log("\n[R1] GET /api/channels — showcase channel appears in list");
  const rList = await apiCall({ method: "GET", path: "/api/channels", token: userToken, serverId });
  check("returns 200", rList.status === 200);
  const listBody = rList.body as any[];
  const scInList = Array.isArray(listBody) && listBody.some((c) => c.type === "showcase" && c.id === showcaseChId);
  check("showcase channel appears in channel list", scInList);

  // ── READ passthrough 2: messages readable ────────────────────────────────
  console.log("\n[R2] GET /api/messages/channel/:id — showcase messages readable");
  const rMsgs = await apiCall({ method: "GET", path: `/api/messages/channel/${showcaseChId}`, token: userToken, serverId });
  check("returns 200", rMsgs.status === 200);
  const msgsBody = rMsgs.body as any;
  check("messages array present", Array.isArray(msgsBody?.messages));
  check("anchor message is in response", (msgsBody?.messages ?? []).some((m: any) => m.id === anchorMsgId));

  // ── READ passthrough 3: canUserReadChannel returns true (via GET messages) ─
  console.log("\n[R3] canUserReadChannel — true for showcase (server member, no channel membership row)");
  // Verified implicitly by R2: the member has no channelMembers row for the showcase
  // channel (we never inserted one), yet messages were returned (200).
  const noChanMem = (await db.select().from(schema.channelMembers)
    .where(and(eq(schema.channelMembers.channelId, showcaseChId), eq(schema.channelMembers.memberId, userId)))).length === 0;
  check("user has no channelMembers row for showcase", noChanMem);
  check("...yet GET messages still returned 200 (read access granted)", rMsgs.status === 200);

  // ── WRITE intercept 1: POST /api/messages → 403 ─────────────────────────
  console.log("\n[W1] POST /api/messages to showcase channel — should 403");
  const w1 = await apiCall({ method: "POST", path: "/api/messages", token: userToken, serverId, body: { channelId: showcaseChId, content: "injected!" } });
  check("returns 403", w1.status === 403);
  check("error message mentions read-only", JSON.stringify(w1.body).includes("read-only"));

  // ── WRITE intercept 2: POST /api/channels/:id/threads → 403 ────────────
  console.log("\n[W2] POST /api/channels/:id/threads with showcase parent — should 403");
  const w2 = await apiCall({ method: "POST", path: `/api/channels/${showcaseChId}/threads`, token: userToken, serverId, body: { parentMessageId: anchorMsgId } });
  check("returns 403", w2.status === 403);
  check("error message mentions read-only", JSON.stringify(w2.body).includes("read-only"));

  // ── WRITE intercept 3: POST /api/channels/:id/join → 403 ────────────────
  console.log("\n[W3] POST /api/channels/:id/join for showcase — should 403");
  const w3 = await apiCall({ method: "POST", path: `/api/channels/${showcaseChId}/join`, token: userToken, serverId });
  check("returns 403", w3.status === 403);
  check("error message mentions read-only or visible", JSON.stringify(w3.body).toLowerCase().includes("showcase"));

  // ── WRITE intercept 4: POST /api/channels with type=showcase → 403 ──────
  console.log("\n[W4] POST /api/channels with type=showcase — should 403");
  const w4 = await apiCall({ method: "POST", path: "/api/channels", token: userToken, serverId, body: { name: "fake-showcase", type: "showcase" } });
  check("returns 403", w4.status === 403);
  check("error message mentions system-only creation", JSON.stringify(w4.body).includes("system"));

  // ── WRITE intercept 5: agent message/send to showcase → 403 ─────────────
  // resolveTarget resolves by channel NAME (not UUID); the showcase channel is named "showcase"
  console.log("\n[W5] agent message/send to showcase channel — should 403");
  const w5 = await agentApiCall({ method: "POST", path: "/agent-api/message/send", agentToken, agentId, serverId, body: { target: "showcase", content: "agent-injected" } });
  check("returns 403", w5.status === 403);
  check("error message mentions read-only", JSON.stringify(w5.body).includes("read-only"));
}

main()
  .then(cleanup)
  .then(() => {
    if (failures > 0) {
      console.log(`\n${failures} CHECK(S) FAILED ❌`);
      process.exit(1);
    } else {
      console.log("\nALL PASS ✅");
      process.exit(0);
    }
  })
  .catch(async (e) => { console.error("ERROR:", e); try { await cleanup(); } catch { /**/ } process.exit(1); });

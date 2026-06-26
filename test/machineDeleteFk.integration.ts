// Integration test: DELETE /api/servers/:sid/machines/:mid FK-violation bug.
//
// Root cause: machines.id → agents.machineId has no onDelete action (= RESTRICT by default).
// Soft-deleted agent rows (deletedAt IS NOT NULL) still physically reference the machine.
// The live-agent guard only counted rows WHERE deletedAt IS NULL, so it returned 0 and let
// the delete proceed — but PG's FK constraint refused the DELETE on machines, producing a 500.
//
// EXPECTED BEHAVIOUR (goal contract):
//   BEFORE fix: soft-deleted agent scenario returns 500  → [1] check FAILS (RED)
//   AFTER  fix: soft-deleted agent scenario returns 200  → [1] check PASSES (GREEN)
//   REGRESSION: live-agent scenario still returns 409    → [2] check is always GREEN
//
// Requires infra up: `npm run infra` (pg :5433, redis :6380).
// Run from the worktree root: npx tsx test/machineDeleteFk.integration.ts
import "../src/env.js"; // load .env before any DB/auth/redis import
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { handleApi } from "../src/server/routes-api/index.ts";
import { signUser } from "../src/server/auth.ts";
import { hashToken, newKey } from "../src/server/auth.ts";

const ts = Date.now();
let serverId = "";
let ownerId = "";
let ownerToken = "";
let failures = 0;

const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`);
  if (!cond) failures++;
};

// ── Mock HTTP helpers (same pattern as channelAccess.integration.ts) ──────────

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
  // Mirror the server's top-level catch (src/server/index.ts ~L93): unhandled handler
  // errors become 500 "internal" in production — reproduce that here so the test exercises
  // the same status code the user actually sees.
  try {
    await handleApi(req, res, url, opts.method);
  } catch (e: unknown) {
    const detail = e instanceof Error ? e.message : String(e);
    res.writeHead(500);
    res.end(JSON.stringify({ error: "internal", detail }));
  }
  let parsed: unknown;
  try { parsed = JSON.parse(getBody()); } catch { parsed = getBody(); }
  return { status: getStatus(), body: parsed };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Insert a machine row directly (bypasses HTTP — we're testing DELETE, not POST). */
async function insertMachine(name: string) {
  const key = newKey("sk_machine_");
  const [m] = await db.insert(schema.machines).values({
    serverId,
    userId: ownerId,
    name,
    apiKeyHash: hashToken(key),
    apiKeyPrefix: key.slice(0, 14),
    status: "offline",
    isComputer: false,
  }).returning();
  return m!;
}

/** Insert an agent bound to a machine, then immediately soft-delete it. */
async function insertSoftDeletedAgent(machineId: string, suffix: string) {
  const [a] = await db.insert(schema.agents).values({
    serverId,
    machineId,
    name: `agent_${suffix}_${ts}`,
    displayName: `Agent ${suffix}`,
  }).returning();
  await db.update(schema.agents)
    .set({ deletedAt: new Date() })
    .where(eq(schema.agents.id, a!.id));
  return a!;
}

/** Insert a live (not soft-deleted) agent bound to a machine. */
async function insertLiveAgent(machineId: string, suffix: string) {
  const [a] = await db.insert(schema.agents).values({
    serverId,
    machineId,
    name: `live_${suffix}_${ts}`,
    displayName: `Live ${suffix}`,
  }).returning();
  return a!;
}

// ── Setup / cleanup ───────────────────────────────────────────────────────────

async function setup() {
  const [u] = await db.insert(schema.users).values({
    name: `owner_mdfk_${ts}`,
    displayName: "Owner",
    email: `o_mdfk_${ts}@t.local`,
  }).returning();
  ownerId = u!.id;

  const [srv] = await db.insert(schema.servers).values({
    name: "T-mdfk",
    slug: `t-mdfk-${ts}`,
    ownerId,
  }).returning();
  serverId = srv!.id;

  // Owner role → has manageMachines capability
  await db.insert(schema.serverMembers).values({ serverId, userId: ownerId, role: "owner" });

  ownerToken = signUser(ownerId);
}

async function cleanup() {
  // FK-safe order: null out machineId on agents first (covers both test scenarios),
  // then delete agents → machines → members → server → user.
  await db.update(schema.agents)
    .set({ machineId: null })
    .where(eq(schema.agents.serverId, serverId));
  await db.delete(schema.agents).where(eq(schema.agents.serverId, serverId));
  await db.delete(schema.machines).where(eq(schema.machines.serverId, serverId));
  await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, serverId));
  await db.delete(schema.servers).where(eq(schema.servers.id, serverId));
  await db.delete(schema.users).where(eq(schema.users.id, ownerId));
}

// ── Test cases ────────────────────────────────────────────────────────────────

async function main() {
  await setup();

  // ── [1] Soft-deleted agent: DELETE machine must return 200 ────────────────
  // BUG on main: agents.machineId FK (RESTRICT) fires because soft-deleted row still
  // references the machine. Guard missed it → 500 "internal".
  // Fix: handler nullifies machineId on soft-deleted agents before deleting the machine.
  console.log("\n[1] DELETE machine with soft-deleted agent — expected 200 (was 500 on main)");
  const m1 = await insertMachine(`machine_soft_del_${ts}`);
  await insertSoftDeletedAgent(m1.id, "sd1");

  const r1 = await apiCall({
    method: "DELETE",
    path: `/api/servers/${serverId}/machines/${m1.id}`,
    token: ownerToken,
    serverId,
  });
  console.log(`     → status=${r1.status} body=${JSON.stringify(r1.body)}`);
  check("soft-deleted agent: DELETE machine returns 200 (not 500)", r1.status === 200);

  // Verify the machine row is gone
  const m1after = await db.select().from(schema.machines).where(eq(schema.machines.id, m1.id));
  check("machine row was deleted", m1after.length === 0);

  // Verify the soft-deleted agent row is still present (audit trail preserved) but machineId is null
  const a1after = await db.select().from(schema.agents).where(eq(schema.agents.serverId, serverId));
  check("soft-deleted agent row is retained (audit trail)", a1after.length === 1);
  check("soft-deleted agent machineId is now null (FK released)", a1after[0]!.machineId === null);

  // ── [2] Regression: live agent blocks machine delete (409 still fires) ────
  console.log("\n[2] DELETE machine with live agent — expected 409 (guard must remain)");
  const m2 = await insertMachine(`machine_live_agent_${ts}`);
  const _a2 = await insertLiveAgent(m2.id, "live1");

  const r2 = await apiCall({
    method: "DELETE",
    path: `/api/servers/${serverId}/machines/${m2.id}`,
    token: ownerToken,
    serverId,
  });
  console.log(`     → status=${r2.status} body=${JSON.stringify(r2.body)}`);
  check("live agent: DELETE machine returns 409 (guard intact)", r2.status === 409);

  // Machine must NOT have been deleted
  const m2after = await db.select().from(schema.machines).where(eq(schema.machines.id, m2.id));
  check("machine row is still present when live agent blocks delete", m2after.length === 1);
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

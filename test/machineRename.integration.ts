// Integration test: PATCH /api/servers/:sid/machines/:mid rename + authorization.
// EXPECTED (goal contract):
//   BEFORE: no PATCH route → falls through to 404 → [1] FAILS (RED)
//   AFTER : owner rename persists (200) [1]; cross-tenant id → 404 [2]; member (no cap) → 403 [3];
//           empty name → 400 [4]; oversize name → 400 [5]
// Requires infra up (npm run infra) + worktree .env. Run: npx tsx test/machineRename.integration.ts
import "../src/env.js";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { signUser, hashToken, newKey } from "../src/server/auth.ts";
import { handleApi } from "../src/server/routes-api/index.ts";

const ts = Date.now();
let failures = 0;
const check = (label: string, cond: boolean) => { console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`); if (!cond) failures++; };

function makeReq(o: { method: string; path: string; token: string; serverId: string; body?: object }): IncomingMessage {
  const s = o.body ? JSON.stringify(o.body) : "";
  const r = Readable.from(s ? [Buffer.from(s)] : ([] as Buffer[]));
  return Object.assign(r, { method: o.method, url: o.path, headers: { authorization: `Bearer ${o.token}`, "x-server-id": o.serverId, "content-type": "application/json" } }) as unknown as IncomingMessage;
}
function makeRes() {
  let status = 0, body = "";
  const em = new EventEmitter();
  const res = Object.assign(em, { statusCode: 0, headersSent: false, setHeader() {}, writeHead(c: number) { status = c; this.statusCode = c; }, end(d?: string | Buffer) { body = d ? String(d) : ""; em.emit("finish"); } }) as unknown as ServerResponse;
  return { res, getStatus: () => status, getBody: () => body };
}
async function apiCall(o: { method: string; path: string; token: string; serverId: string; body?: object }) {
  const PORT = Number(process.env.PORT ?? 7777);
  const { res, getStatus, getBody } = makeRes();
  const url = new URL(o.path, `http://localhost:${PORT}`);
  try { await handleApi(makeReq(o), res, url, o.method); }
  catch (e: unknown) { res.writeHead(500); res.end(JSON.stringify({ error: "internal", detail: e instanceof Error ? e.message : String(e) })); }
  let parsed: unknown; try { parsed = JSON.parse(getBody()); } catch { parsed = getBody(); }
  return { status: getStatus(), body: parsed as any };
}

let serverId = "", ownerId = "", ownerToken = "", memberId = "", memberToken = "";
let otherServerId = "", otherMachineId = "";

async function insertMachine(sid: string, uid: string, name: string) {
  const key = newKey("sk_machine_");
  const [m] = await db.insert(schema.machines).values({ serverId: sid, userId: uid, name, apiKeyHash: hashToken(key), apiKeyPrefix: key.slice(0, 14), status: "offline", isComputer: false }).returning();
  return m!;
}
async function setup() {
  const [owner] = await db.insert(schema.users).values({ name: `own_mr_${ts}`, displayName: "Owner", email: `own_mr_${ts}@t.local` }).returning();
  ownerId = owner!.id; ownerToken = signUser(ownerId);
  const [member] = await db.insert(schema.users).values({ name: `mem_mr_${ts}`, displayName: "Member", email: `mem_mr_${ts}@t.local` }).returning();
  memberId = member!.id; memberToken = signUser(memberId);
  const [srv] = await db.insert(schema.servers).values({ name: "T-mr", slug: `t-mr-${ts}`, ownerId }).returning();
  serverId = srv!.id;
  await db.insert(schema.serverMembers).values({ serverId, userId: ownerId, role: "owner" });
  await db.insert(schema.serverMembers).values({ serverId, userId: memberId, role: "member" });
  // A second server owned by the same user, to prove tenant isolation on machineId.
  const [srv2] = await db.insert(schema.servers).values({ name: "T-mr2", slug: `t-mr2-${ts}`, ownerId }).returning();
  otherServerId = srv2!.id;
  await db.insert(schema.serverMembers).values({ serverId: otherServerId, userId: ownerId, role: "owner" });
  const om = await insertMachine(otherServerId, ownerId, `other_${ts}`);
  otherMachineId = om.id;
}
async function cleanup() {
  for (const sid of [serverId, otherServerId]) {
    await db.delete(schema.machines).where(eq(schema.machines.serverId, sid));
    await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, sid));
    await db.delete(schema.servers).where(eq(schema.servers.id, sid));
  }
  await db.delete(schema.users).where(eq(schema.users.id, ownerId));
  await db.delete(schema.users).where(eq(schema.users.id, memberId));
}

async function main() {
  await setup();

  console.log("\n[1] owner renames own machine → 200 + persisted");
  const m = await insertMachine(serverId, ownerId, `before_${ts}`);
  const r1 = await apiCall({ method: "PATCH", path: `/api/servers/${serverId}/machines/${m.id}`, token: ownerToken, serverId, body: { name: "My Laptop" } });
  console.log(`     → status=${r1.status} body=${JSON.stringify(r1.body)}`);
  check("rename returns 200", r1.status === 200);
  check("response carries new name", r1.body?.name === "My Laptop");
  const after = await db.select().from(schema.machines).where(eq(schema.machines.id, m.id));
  check("DB name updated", after[0]?.name === "My Laptop");

  console.log("\n[2] cross-tenant machine id → 404 (tenant isolation)");
  const r2 = await apiCall({ method: "PATCH", path: `/api/servers/${serverId}/machines/${otherMachineId}`, token: ownerToken, serverId, body: { name: "Hijack" } });
  console.log(`     → status=${r2.status}`);
  check("foreign machine id rejected with 404", r2.status === 404);
  const oth = await db.select().from(schema.machines).where(eq(schema.machines.id, otherMachineId));
  check("foreign machine name unchanged", oth[0]?.name === `other_${ts}`);

  console.log("\n[3] member (no manageMachines) → 403");
  const r3 = await apiCall({ method: "PATCH", path: `/api/servers/${serverId}/machines/${m.id}`, token: memberToken, serverId, body: { name: "Nope" } });
  console.log(`     → status=${r3.status}`);
  check("member rename forbidden with 403", r3.status === 403);

  console.log("\n[4] empty name → 400");
  const r4 = await apiCall({ method: "PATCH", path: `/api/servers/${serverId}/machines/${m.id}`, token: ownerToken, serverId, body: { name: "   " } });
  check("empty name rejected with 400", r4.status === 400);

  console.log("\n[5] oversize name (>80) → 400");
  const r5 = await apiCall({ method: "PATCH", path: `/api/servers/${serverId}/machines/${m.id}`, token: ownerToken, serverId, body: { name: "x".repeat(81) } });
  check("oversize name rejected with 400", r5.status === 400);
}

main().then(cleanup).then(() => { console.log(`\n${failures === 0 ? "ALL PASS ✅" : `${failures} CHECK(S) FAILED ❌`}`); process.exit(failures === 0 ? 0 : 1); })
  .catch(async (e) => { console.error("ERROR:", e); try { await cleanup(); } catch {} process.exit(1); });

// Integration test: agent-plane `GET /agent-api/attachment/view` must tolerate short attachment ids.
//
// Live failure (getopentag.com, 2026-07-05): an agent posted a message citing its uploads by
// 8-char id prefix ("浅色 (78d92569)"); the reading agent's `attachment view` calls failed
// (prefix → PG uuid cast error → 500 "internal"; LLM-expanded fake full uuid → 404) and it
// retried in a loop. Message endpoints already tolerate short ids (`resolveMessageId`,
// core.ts:660); attachment/view was the outlier requiring an exact full UUID.
//
//   Case                                                  | BEFORE fix      | AFTER fix
//   ----------------------------------------------------- | --------------- | ---------
//   Cases run against a PRIVATE channel (public channels are readable by any server agent, core.ts
//   canAgentReadChannel — so only a private channel exercises the ACL boundary):
//
//   member agent, full uuid                               | 200             | 200
//   member agent, 8-char prefix                           | 500 (uuid cast) | 200
//   member agent, 6-char prefix                           | 500             | 200
//   NON-member agent, full uuid (ACL)                     | 404             | 404
//   NON-member agent, 8-char prefix (ACL)                 | 500             | 404
//   nonexistent prefix                                    | 500             | 404
//   5-char prefix (below the ≥6 hex floor, resolveMessageId convention) | 500 | 404
//
// Run from the worktree: npx tsx test/attachmentShortId.integration.ts
import "../src/env.js";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { handleAgentApi } from "../src/server/routes-agent.ts";
import { hashToken } from "../src/server/auth.ts";
import { saveObject } from "../src/server/storage.ts";

const ts = Date.now();
let serverId = "", ownerId = "";
let channelId = "", attachmentId = "";
let uploaderId = "", viewerId = "", outsiderId = "";
const viewerToken = `sk_agent_test_viewer_${ts}`;
const outsiderToken = `sk_agent_test_outsider_${ts}`;
let failures = 0;

const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`);
  if (!cond) failures++;
};

function makeReq(opts: { method: string; path: string; token: string; agentId: string }): IncomingMessage {
  const readable = Readable.from([] as Buffer[]);
  const headers: Record<string, string> = { authorization: `Bearer ${opts.token}`, "x-agent-id": opts.agentId };
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

async function view(id: string, opts: { token: string; agentId: string }): Promise<{ status: number; body: any }> {
  const path = `/agent-api/attachment/view?id=${encodeURIComponent(id)}`;
  const req = makeReq({ method: "GET", path, ...opts });
  const { res, getStatus, getBody } = makeRes();
  const url = new URL(path, "http://localhost:7801");
  try {
    await handleAgentApi(req, res, url, "GET");
  } catch (e: any) {
    // Mirror the server's global catch (index.ts): an escaped handler error becomes a 500 "internal".
    return { status: 500, body: { error: "internal", detail: String(e?.message ?? e) } };
  }
  let parsed: any;
  try { parsed = JSON.parse(getBody()); } catch { parsed = getBody(); }
  return { status: getStatus(), body: parsed };
}

async function setup() {
  const [u] = await db.insert(schema.users).values({ name: `owner_att_${ts}`, displayName: "Owner", email: `att_${ts}@t.local` }).returning();
  ownerId = u!.id;
  const [srv] = await db.insert(schema.servers).values({ name: "TATT", slug: `tatt-${ts}`, ownerId }).returning();
  serverId = srv!.id;
  await db.insert(schema.serverMembers).values({ serverId, userId: ownerId, role: "owner" });

  const [ch] = await db.insert(schema.channels).values({ serverId, name: `att-${ts}`, type: "private" }).returning();
  channelId = ch!.id;

  const mkAgent = async (name: string, token: string | null) => {
    const [a] = await db.insert(schema.agents).values({
      serverId, name: `${name}_${ts}`, displayName: name, agentTokenHash: token ? hashToken(token) : null,
    }).returning();
    return a!.id;
  };
  uploaderId = await mkAgent("uploader", null);
  viewerId = await mkAgent("viewer", viewerToken);
  outsiderId = await mkAgent("outsider", outsiderToken);
  await db.insert(schema.channelMembers).values([
    { channelId, memberType: "agent", memberId: uploaderId },
    { channelId, memberType: "agent", memberId: viewerId },
  ]);

  // Prod shape: uploaded to a channel (channelId recorded at upload), not yet attached to a message.
  const saved = await saveObject(`short-id-${ts}.txt`, Readable.from([Buffer.from("short id resolution test payload")]));
  const [att] = await db.insert(schema.attachments).values({
    serverId, channelId, uploaderType: "agent", uploaderId,
    filename: `short-id-${ts}.txt`, mimeType: "text/plain", sizeBytes: saved.size, storageKey: saved.key,
  }).returning();
  attachmentId = att!.id;
}

async function cleanup() {
  await db.delete(schema.attachments).where(eq(schema.attachments.serverId, serverId));
  await db.delete(schema.channelMembers).where(eq(schema.channelMembers.channelId, channelId));
  await db.delete(schema.channels).where(eq(schema.channels.serverId, serverId));
  await db.delete(schema.agents).where(eq(schema.agents.serverId, serverId));
  await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, serverId));
  await db.delete(schema.servers).where(eq(schema.servers.id, serverId));
  await db.delete(schema.users).where(eq(schema.users.id, ownerId));
}

async function main() {
  await setup();
  try {
    const asViewer = { token: viewerToken, agentId: viewerId };
    const asOutsider = { token: outsiderToken, agentId: outsiderId };

    console.log("member agent:");
    const full = await view(attachmentId, asViewer);
    check(`full uuid → 200 (got ${full.status})`, full.status === 200 && full.body?.text?.includes("short id resolution"));
    const p8 = await view(attachmentId.slice(0, 8), asViewer);
    check(`8-char prefix → 200 (got ${p8.status})`, p8.status === 200 && p8.body?.id === attachmentId);
    const p6 = await view(attachmentId.slice(0, 6), asViewer);
    check(`6-char prefix → 200 (got ${p6.status})`, p6.status === 200 && p6.body?.id === attachmentId);

    console.log("guards (private channel):");
    const aclFull = await view(attachmentId, asOutsider);
    check(`non-member, full uuid → 404 (got ${aclFull.status})`, aclFull.status === 404);
    const acl = await view(attachmentId.slice(0, 8), asOutsider);
    check(`non-member, 8-char prefix → 404 (got ${acl.status})`, acl.status === 404);
    const miss = await view("ffffff999999", asViewer);
    check(`nonexistent prefix → 404 (got ${miss.status})`, miss.status === 404);
    const tooShort = await view(attachmentId.slice(0, 5), asViewer);
    check(`5-char prefix (below ≥6 floor) → 404 (got ${tooShort.status})`, tooShort.status === 404);
  } finally {
    await cleanup();
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

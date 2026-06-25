// Auto-extracted from the former routes-api.ts monolith — bodies are verbatim.
import type { BaseCtx, ServerCtx } from "./ctx.js";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { parseUpload } from "../attachments.js";
import { verifyUser } from "../auth.js";
import { can, requireCap } from "../capabilities.js";
import { readObject } from "../storage.js";
import { bearer, sendErr, sendJson } from "../util.js";

/**
 * MIME types that are safe to serve inline in a browser without XSS risk.
 *
 * Exclusions (intentional):
 *   - text/html, application/xhtml+xml → browser renders as HTML, executes scripts.
 *   - image/svg+xml → SVG can contain inline <script> elements.
 *   - text/javascript, application/javascript → browser executes directly.
 *   - text/xml, application/xml → browsers may render with XSLT that loads resources.
 *   - Any unlisted type → defaults to attachment + octet-stream (defense-in-depth).
 */
const SAFE_INLINE_TYPES = new Set<string>([
  "image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp",
  "image/bmp", "image/tiff", "image/avif", "image/ico", "image/x-icon",
  "application/pdf",
  "video/mp4", "video/webm", "video/ogg", "video/quicktime",
  "audio/mpeg", "audio/ogg", "audio/wav", "audio/webm", "audio/aac",
]);

/**
 * Compute safe HTTP response headers for an attachment download.
 *
 * - Types in SAFE_INLINE_TYPES are served with their declared MIME and
 *   Content-Disposition: inline (e.g. images play in-page as expected).
 * - ALL other types — including text/html, image/svg+xml, text/javascript —
 *   are served as application/octet-stream with Content-Disposition: attachment.
 *   The browser is forced to download the file; it cannot inline-render it on
 *   the same origin and therefore cannot execute scripts in that file.
 *
 * This function is the primary XSS gate. It operates on stored MIME types, so
 * it also protects legacy records written before sanitizeMimeType() was added.
 */
export function safeDownloadHeaders(storedMime: string, filename: string): Record<string, string> {
  const encodedName = encodeURIComponent(filename);
  // nosniff: instruct browsers to strictly follow the declared content-type and not sniff the
  // file bytes. This matters even for safe inline types — e.g. a JPEG slot being served to an
  // older browser must not be MIME-sniffed as text/html if the bytes happen to look like HTML.
  const nosniff = { "x-content-type-options": "nosniff" };
  if (storedMime && SAFE_INLINE_TYPES.has(storedMime)) {
    return {
      "content-type": storedMime,
      "content-disposition": `inline; filename*=UTF-8''${encodedName}`,
      ...nosniff,
    };
  }
  return {
    "content-type": "application/octet-stream",
    "content-disposition": `attachment; filename*=UTF-8''${encodedName}`,
    ...nosniff,
  };
}

export async function handlePublicAttachmentGet(ctx: BaseCtx): Promise<boolean> {
  const { req, res, url, method, p } = ctx;
  // Attachment download/preview: browsers cannot set headers for anchor/img tags, so the token is passed as a query param (same approach as SSE). Placed before the auth check.
  const adl = /^\/api\/attachments\/([^/]+?)(\/preview)?$/.exec(p);
  if (adl && adl[1] !== "upload" && method === "GET") {
    const uid = verifyUser(url.searchParams.get("token") ?? bearer(req));
    if (!uid) return (sendErr(res, 401, "unauthorized"), true);
    const a = (await db.select().from(schema.attachments).where(eq(schema.attachments.id, adl[1]!)))[0];
    if (!a) return (sendErr(res, 404, "attachment not found"), true);
    let data: Buffer;
    try { data = await readObject(a.storageKey); } catch { return (sendErr(res, 404, "file missing"), true); }
    if (adl[2]) { // /preview: text preview
      if (data.includes(0) || (a.sizeBytes ?? 0) > 256 * 1024) return (sendJson(res, 200, { kind: "binary" }), true);
      return (sendJson(res, 200, { kind: "text", text: data.toString("utf8") }), true);
    }
    res.writeHead(200, safeDownloadHeaders(a.mimeType || "", a.filename));
    res.end(data); return true;
  }
  return false;
}

export async function handleAttachments(ctx: ServerCtx): Promise<boolean> {
  const { req, res, method, p, userId, serverId } = ctx;
  if (p === "/api/attachments/upload" && method === "POST") {
    const { fields, files } = await parseUpload(req);
    const out: any[] = [];
    for (const f of files) {
      const [a] = await db.insert(schema.attachments).values({ serverId, channelId: fields.channelId || null, uploaderType: "user", uploaderId: userId, filename: f.filename, mimeType: f.mimeType, sizeBytes: f.size, storageKey: f.storageKey }).returning();
      out.push({ attachmentId: a!.id, id: a!.id, filename: a!.filename, mimeType: a!.mimeType, sizeBytes: a!.sizeBytes });
    }
    return (sendJson(res, 200, { attachments: out, attachmentId: out[0]?.attachmentId }), true);
  }
  // Agent avatar upload: manageAgents capability required → stored as attachment → agents.avatarUrl
  const agavatar = /^\/api\/agents\/([^/]+)\/avatar$/.exec(p);
  if (agavatar && method === "POST") {
    if (!await requireCap(serverId, userId, "manageAgents")) return (sendErr(res, 403, "need manageAgents capability"), true);
    const agentId = agavatar[1]!;
    const { files } = await parseUpload(req);
    const f = files[0];
    if (!f) return (sendErr(res, 400, "no file"), true);
    if (!(f.mimeType || "").startsWith("image/")) return (sendErr(res, 400, "avatar must be an image"), true);
    const [att] = await db.insert(schema.attachments).values({ serverId, channelId: null, uploaderType: "user", uploaderId: userId, filename: f.filename, mimeType: f.mimeType, sizeBytes: f.size, storageKey: f.storageKey }).returning();
    const avatarUrl = `/api/attachments/${att!.id}`;
    await db.update(schema.agents).set({ avatarUrl }).where(and(eq(schema.agents.id, agentId), eq(schema.agents.serverId, serverId)));
    return (sendJson(res, 200, { avatarUrl }), true);
  }
  // Current user avatar upload → stored as attachment → users.avatarUrl
  if (p === "/api/auth/me/avatar" && method === "POST") {
    const { files } = await parseUpload(req);
    const f = files[0];
    if (!f) return (sendErr(res, 400, "no file"), true);
    if (!(f.mimeType || "").startsWith("image/")) return (sendErr(res, 400, "avatar must be an image"), true);
    const [att] = await db.insert(schema.attachments).values({ serverId, channelId: null, uploaderType: "user", uploaderId: userId, filename: f.filename, mimeType: f.mimeType, sizeBytes: f.size, storageKey: f.storageKey }).returning();
    const avatarUrl = `/api/attachments/${att!.id}`;
    await db.update(schema.users).set({ avatarUrl }).where(eq(schema.users.id, userId));
    return (sendJson(res, 200, { avatarUrl }), true);
  }
  // Workspace avatar upload: owner/admin uploads image → stored as attachment → servers.avatarUrl
  const savatar = /^\/api\/servers\/([^/]+)\/avatar$/.exec(p);
  if (savatar && method === "POST") {
    const sid = savatar[1]!;
    const mem = (await db.select().from(schema.serverMembers).where(and(eq(schema.serverMembers.serverId, sid), eq(schema.serverMembers.userId, userId))))[0];
    if (!mem || !can(mem.role, "manageServer")) return (sendErr(res, 403, "need manageServer capability"), true);
    const { files } = await parseUpload(req);
    const f = files[0];
    if (!f) return (sendErr(res, 400, "no file"), true);
    if (!(f.mimeType || "").startsWith("image/")) return (sendErr(res, 400, "avatar must be an image"), true);
    const [a] = await db.insert(schema.attachments).values({ serverId: sid, channelId: null, uploaderType: "user", uploaderId: userId, filename: f.filename, mimeType: f.mimeType, sizeBytes: f.size, storageKey: f.storageKey }).returning();
    const avatarUrl = `/api/attachments/${a!.id}`;
    await db.update(schema.servers).set({ avatarUrl }).where(eq(schema.servers.id, sid));
    return (sendJson(res, 200, { avatarUrl }), true);
  }
  // Channel file list (attachments linked to messages)
  return false;
}

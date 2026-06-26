// Auto-extracted from the former routes-api.ts monolith — bodies are verbatim.
import type { BaseCtx, ServerCtx } from "./ctx.js";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { parseUpload } from "../attachments.js";
import { verifyUser } from "../auth.js";
import { can, requireCap } from "../capabilities.js";
import { canUserReadChannel } from "../channelAccess.js";
import { readObject } from "../storage.js";
import { bearer, sendErr, sendJson } from "../util.js";

/**
 * MIME types safe for inline display with no additional restrictions.
 * Raster images, audio, video, and PDF cannot execute scripts even when
 * navigated to directly — browsers parse them as media, not as documents.
 *
 * Intentional exclusions:
 *   - text/html, application/xhtml+xml → HTML execution.
 *   - image/svg+xml → handled separately in SAFE_INLINE_WITH_CSP_TYPES.
 *   - text/javascript, application/javascript → direct execution.
 *   - text/xml, application/xml → XSLT may load external resources.
 *   - Any unlisted type → attachment + octet-stream (defense-in-depth).
 */
const SAFE_INLINE_TYPES = new Set<string>([
  "image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp",
  "image/bmp", "image/tiff", "image/avif", "image/ico", "image/x-icon",
  "application/pdf",
  "video/mp4", "video/webm", "video/ogg", "video/quicktime",
  "audio/mpeg", "audio/ogg", "audio/wav", "audio/webm", "audio/aac",
]);

/**
 * MIME types that need inline display (e.g. for browser image-element rendering) but carry
 * script-execution risk when navigated to directly as a same-origin document.
 *
 * These are served inline with their declared content-type AND a hardened
 * Content-Security-Policy that sandboxes the browsing context:
 *   - `sandbox` → treats the document as a unique origin, blocks scripts,
 *     blocks form submission, blocks popups; the SVG renders as an image
 *     but cannot reach the parent page's localStorage or cookies.
 *   - `default-src 'none'` → no external resources loaded.
 *   - `style-src 'unsafe-inline'` → inline SVG styles still render correctly.
 *
 * When loaded via <img src="..."> the CSP of this response is irrelevant
 * (browsers already forbid scripts in SVG images), so the sandbox is the
 * backstop for direct URL navigation.
 */
const SAFE_INLINE_WITH_CSP_TYPES = new Set<string>([
  "image/svg+xml",
]);

const SVG_SANDBOX_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/**
 * Compute safe HTTP response headers for an attachment download.
 *
 * Three tiers:
 *  1. SAFE_INLINE_TYPES        → inline, declared MIME, nosniff.
 *  2. SAFE_INLINE_WITH_CSP_TYPES (SVG) → inline, declared MIME, nosniff +
 *     CSP sandbox (neutralises same-origin script execution on direct nav).
 *  3. Everything else          → application/octet-stream, attachment, nosniff.
 *
 * Tier 3 covers legacy DB records too (operates on stored value, not upload-time
 * declared value), so old records with dangerous MIMEs are also protected.
 */
export function safeDownloadHeaders(storedMime: string, filename: string): Record<string, string> {
  const encodedName = encodeURIComponent(filename);
  // nosniff: prevent browsers from sniffing the bytes and overriding the declared type.
  const nosniff = { "x-content-type-options": "nosniff" };
  if (storedMime && SAFE_INLINE_TYPES.has(storedMime)) {
    return {
      "content-type": storedMime,
      "content-disposition": `inline; filename*=UTF-8''${encodedName}`,
      ...nosniff,
    };
  }
  if (storedMime && SAFE_INLINE_WITH_CSP_TYPES.has(storedMime)) {
    return {
      "content-type": storedMime,
      "content-disposition": `inline; filename*=UTF-8''${encodedName}`,
      "content-security-policy": SVG_SANDBOX_CSP,
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
    // Channel/server access gate — invariant 3: non-members of private/DM channels must not
    // access their attachments via direct UUID (IDOR-B3). Use 404 (not 403) to avoid leaking
    // whether the attachment exists at all.
    if (a.channelId) {
      // Attachment linked to a channel: apply the same channel-visibility logic as message reads.
      if (!(await canUserReadChannel(a.serverId, a.channelId, uid))) return (sendErr(res, 404, "attachment not found"), true);
    } else {
      // No channelId (server-scoped attachment such as an avatar): require server membership.
      const mem = (await db.select({ id: schema.serverMembers.userId }).from(schema.serverMembers)
        .where(and(eq(schema.serverMembers.serverId, a.serverId), eq(schema.serverMembers.userId, uid))))[0];
      if (!mem) return (sendErr(res, 404, "attachment not found"), true);
    }
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

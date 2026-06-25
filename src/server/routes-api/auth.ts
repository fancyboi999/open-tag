// Auto-extracted from the former routes-api.ts monolith — bodies are verbatim.
import type { BaseCtx, UserCtx } from "./ctx.js";
import { and, eq, or } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { devLoginEnabled, hashPassword, isValidEmail, passwordError, safeEqual, setupToken, signUser, verifyPassword } from "../auth.js";
import { DESC_TOO_LONG, createServer, descTooLong } from "../core.js";
import { clientIp, rateLimit } from "../ratelimit.js";
import { readJson, sendErr, sendJson } from "../util.js";

export async function handlePublicAuth(ctx: BaseCtx): Promise<boolean> {
  const { req, res, url, method, p } = ctx;

  // ---- auth ----
  // Dev-login: public username→JWT shortcut for local development ONLY. Gated behind ALLOW_DEV_LOGIN (default off),
  // so production never exposes it. When disabled it 404s — indistinguishable from a non-existent route (no endpoint leak).
  if (p === "/api/auth/dev-login" && method === "POST") {
    if (!devLoginEnabled()) return (sendErr(res, 404, "not found"), true);
    const b = await readJson(req);
    const name = String(b.name ?? "you").trim();
    if (!name || name.length > 64) return (sendErr(res, 400, "invalid name"), true);
    let u = (await db.select().from(schema.users).where(eq(schema.users.name, name)))[0];
    if (!u) [u] = await db.insert(schema.users).values({ name, displayName: name, email: `${name}@dev.local` }).returning();
    // Multi-tenant: each user has isolated data — ensure the user has their own server (creates an empty one if absent, zero channels/agents; "you" owns the seeded default workspace)
    const mine = (await db.select().from(schema.servers).where(eq(schema.servers.ownerId, u!.id)))[0];
    if (!mine) await createServer(`${name}'s workspace`, `u-${u!.id.slice(0, 8)}`, u!.id);
    if (!u) return (sendErr(res, 500, "dev-login failed"), true);
    return (sendJson(res, 200, { token: signUser(u!.id), user: { id: u!.id, name: u!.name, displayName: u!.displayName } }), true);
  }
  // First-deploy admin setup: one-time, token-gated. Disabled (404) unless ADMIN_SETUP_TOKEN is configured.
  // First-run guard: only initializes the seeded default-workspace owner while it still has no password — so it
  // self-closes (410) once an admin password exists. This unblocks the seeded "you" admin after dev-login is turned off,
  // without ever hard-coding a default password. Placed BEFORE the auth gate (the operator has no JWT yet).
  if (p === "/api/auth/setup" && method === "POST") {
    const tok = setupToken();
    if (!tok) return (sendErr(res, 404, "not found"), true);
    const rl = rateLimit("auth:setup", clientIp(req), 5);
    if (!rl.ok) return (sendErr(res, 429, "too many requests", { retryAfter: rl.retryAfter }), true);
    const b = await readJson(req);
    if (!safeEqual(String(b.token ?? ""), tok)) return (sendErr(res, 403, "invalid setup token"), true);
    const ws = (await db.select().from(schema.servers).where(eq(schema.servers.slug, "open-tag")))[0];
    if (!ws) return (sendErr(res, 409, "no default workspace; run seed first"), true);
    const admin = (await db.select().from(schema.users).where(eq(schema.users.id, ws.ownerId)))[0];
    if (!admin) return (sendErr(res, 409, "default workspace owner missing"), true);
    if (admin.passwordHash) return (sendErr(res, 410, "already initialized"), true);
    const pwErr = passwordError(b.password);
    if (pwErr) return (sendErr(res, 400, pwErr), true);
    const patch: Record<string, unknown> = { passwordHash: hashPassword(String(b.password)) };
    if (b.email !== undefined) {
      if (!isValidEmail(b.email)) return (sendErr(res, 400, "invalid email"), true);
      if (b.email !== admin.email) {
        const dup = (await db.select().from(schema.users).where(eq(schema.users.email, b.email)))[0];
        if (dup) return (sendErr(res, 409, "email already in use"), true);
        patch.email = b.email;
      }
    }
    if (typeof b.displayName === "string" && b.displayName.trim()) patch.displayName = b.displayName.trim();
    await db.update(schema.users).set(patch).where(eq(schema.users.id, admin.id));
    return (sendJson(res, 200, { token: signUser(admin.id), user: { id: admin.id, name: admin.name, email: (patch.email as string) ?? admin.email } }), true);
  }
  if (p === "/api/auth/register" && method === "POST") {
    const rl = rateLimit("auth:register", clientIp(req));
    if (!rl.ok) return (sendErr(res, 429, "too many requests", { retryAfter: rl.retryAfter }), true);
    const b = await readJson(req);
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name || name.length > 64) return (sendErr(res, 400, "invalid name"), true);
    if (!isValidEmail(b.email)) return (sendErr(res, 400, "invalid email"), true);
    const pwErr = passwordError(b.password);
    if (pwErr) return (sendErr(res, 400, pwErr), true);
    const dup = (await db.select().from(schema.users).where(or(eq(schema.users.email, b.email), eq(schema.users.name, name))))[0];
    if (dup) return (sendErr(res, 409, dup.email === b.email ? "email already registered" : "username already taken"), true);
    const [u] = await db.insert(schema.users).values({ name, displayName: typeof b.displayName === "string" && b.displayName.trim() ? b.displayName.trim() : name, email: b.email, passwordHash: hashPassword(String(b.password)) }).returning();
    await createServer(`${name}'s workspace`, `u-${u!.id.slice(0, 8)}`, u!.id); // Create personal workspace on registration (aligned with dev-login; without it, entering the app with no server causes bootstrap to crash)
    return (sendJson(res, 200, { token: signUser(u!.id), user: { id: u!.id, name: u!.name } }), true);
  }
  // Login: generic 401 on any failure (no user enumeration — same response whether the email is unknown or the password is wrong).
  if (p === "/api/auth/login" && method === "POST") {
    const rl = rateLimit("auth:login", clientIp(req));
    if (!rl.ok) return (sendErr(res, 429, "too many requests", { retryAfter: rl.retryAfter }), true);
    const b = await readJson(req);
    if (typeof b.email !== "string" || typeof b.password !== "string") return (sendErr(res, 400, "email and password required"), true);
    const u = (await db.select().from(schema.users).where(eq(schema.users.email, b.email)))[0];
    if (!u || !verifyPassword(b.password, u.passwordHash)) return (sendErr(res, 401, "bad credentials"), true);
    return (sendJson(res, 200, { token: signUser(u.id), user: { id: u.id, name: u.name } }), true);
  }
  // Invite info (public, no auth required): the /join/:token landing page uses this to display "X invited you to join workspace Y"
  if (p === "/api/auth/invite-info" && method === "GET") {
    const token = url.searchParams.get("token") ?? "";
    const link = token ? (await db.select().from(schema.joinLinks).where(eq(schema.joinLinks.token, token)))[0] : undefined;
    if (!link) return (sendJson(res, 200, { valid: false }), true);
    const expired = !!link.expiresAt && new Date(link.expiresAt as any).getTime() < Date.now();
    const exhausted = link.maxUses != null && link.useCount >= link.maxUses;
    const srv = (await db.select().from(schema.servers).where(eq(schema.servers.id, link.serverId)))[0];
    const inviter = link.createdByUserId ? (await db.select().from(schema.users).where(eq(schema.users.id, link.createdByUserId)))[0] : null;
    return (sendJson(res, 200, { valid: !expired && !exhausted && !!srv, serverName: srv?.name, serverSlug: srv?.slug, inviterName: inviter?.displayName || inviter?.name || null, role: link.role }), true);
  }

  // Attachment download/preview: browsers cannot set headers for anchor/img tags, so the token is passed as a query param (same approach as SSE). Placed before the auth check.
  return false;
}

export async function handleAuthedAuth(ctx: UserCtx): Promise<boolean> {
  const { req, res, url, method, p, userId } = ctx;
  // Accept invite (requires auth): join a workspace via a join-link token. Idempotent.
  if (p === "/api/auth/accept-invite" && method === "POST") {
    const b = await readJson(req);
    const link = b.token ? (await db.select().from(schema.joinLinks).where(eq(schema.joinLinks.token, String(b.token))))[0] : undefined;
    if (!link) return (sendErr(res, 404, "invalid invite"), true);
    if (link.expiresAt && new Date(link.expiresAt as any).getTime() < Date.now()) return (sendErr(res, 410, "invite expired"), true);
    if (link.maxUses != null && link.useCount >= link.maxUses) return (sendErr(res, 410, "invite exhausted"), true);
    const srv = (await db.select().from(schema.servers).where(eq(schema.servers.id, link.serverId)))[0];
    if (!srv) return (sendErr(res, 404, "server gone"), true);
    const existing = (await db.select().from(schema.serverMembers).where(and(eq(schema.serverMembers.serverId, link.serverId), eq(schema.serverMembers.userId, userId))))[0];
    if (!existing) {
      await db.insert(schema.serverMembers).values({ serverId: link.serverId, userId, role: link.role });
      await db.update(schema.joinLinks).set({ useCount: link.useCount + 1 }).where(eq(schema.joinLinks.id, link.id));
      const all = (await db.select().from(schema.channels).where(and(eq(schema.channels.serverId, link.serverId), eq(schema.channels.name, "all"))))[0];
      if (all) await db.insert(schema.channelMembers).values({ channelId: all.id, memberType: "user", memberId: userId }).onConflictDoNothing();
    }
    return (sendJson(res, 200, { serverSlug: srv.slug, serverId: srv.id, already: !!existing }), true);
  }

  if (p === "/api/auth/me" && method === "GET") {
    const u = (await db.select().from(schema.users).where(eq(schema.users.id, userId)))[0];
    return (u ? sendJson(res, 200, { id: u.id, name: u.name, displayName: u.displayName, email: u.email, description: u.description, avatarUrl: u.avatarUrl }) : sendErr(res, 404, "not found"), true);
  }
  if (p === "/api/auth/me" && method === "PATCH") {
    const b = await readJson(req); const patch: Record<string, unknown> = {};
    if (descTooLong(b.description)) return (sendErr(res, 400, DESC_TOO_LONG), true);
    for (const k of ["displayName", "description", "avatarUrl"]) if (b[k] !== undefined) patch[k] = b[k];
    if (Object.keys(patch).length) await db.update(schema.users).set(patch).where(eq(schema.users.id, userId));
    const u = (await db.select().from(schema.users).where(eq(schema.users.id, userId)))[0];
    return (sendJson(res, 200, { id: u!.id, name: u!.name, displayName: u!.displayName, email: u!.email, description: u!.description }), true);
  }
  return false;
}

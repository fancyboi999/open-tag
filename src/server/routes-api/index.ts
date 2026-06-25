// User-facing REST: /api/*  (Bearer JWT + x-server-id)
//
// Thin dispatcher. It owns ONLY the three auth gates and the dispatch order; the actual route
// logic lives in the per-domain handlers in this directory. Each gate widens the context
// (public → +userId → +serverId, see ./ctx.ts) and then delegates to the handlers registered
// behind that gate. A handler returns `true` once it has matched a route and written the
// response, `false` to let the next handler try.
//
// Two things here are security-load-bearing and must not be reordered casually:
//   1. Gate order — which gate a handler sits behind IS its auth level (see docs/authorization.md).
//   2. Gate-2 dispatch order — preserves the former monolith's EFFECTIVE first-match resolution
//      (not its physical line order: e.g. the `/api/channels/saved` routes now live in messages.ts
//      and are reached only after handleChannels declines them — safe because no channels.ts guard
//      matches those paths/methods). When adding a route, check it can't be shadowed by an
//      earlier-dispatched module's guard for the same path+method.
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { sendErr, bearer, serverIdHeader } from "../util.js";
import { verifyUser } from "../auth.js";
import type { BaseCtx, UserCtx, ServerCtx } from "./ctx.js";
import { handlePublicAuth, handleAuthedAuth } from "./auth.js";
import { handlePublicAttachmentGet, handleAttachments } from "./attachments.js";
import { handleServersUserScope, handleServersServerScope } from "./servers.js";
import { handleAgents } from "./agents.js";
import { handleReminders } from "./reminders.js";
import { handleChannels } from "./channels.js";
import { handleMessages } from "./messages.js";
import { handleTasks } from "./tasks.js";

export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean> {
  const p = url.pathname;
  if (!p.startsWith("/api/")) return false;
  const base: BaseCtx = { req, res, url, method, p };

  // ---- gate 0: public / self-authenticating ----
  if (await handlePublicAuth(base)) return true;
  if (await handlePublicAttachmentGet(base)) return true;

  // ---- gate 1: require a logged-in user ----
  const userId = verifyUser(bearer(req));
  if (!userId) return (sendErr(res, 401, "unauthorized"), true);
  const user: UserCtx = { ...base, userId };
  if (await handleAuthedAuth(user)) return true;
  if (await handleServersUserScope(user)) return true;

  // ---- gate 2: require a server context + membership ----
  const serverId = serverIdHeader(req);
  if (!serverId) return (sendErr(res, 400, "x-server-id header required"), true);
  const member = (await db.select().from(schema.serverMembers).where(and(eq(schema.serverMembers.serverId, serverId), eq(schema.serverMembers.userId, userId))))[0];
  if (!member) return (sendErr(res, 403, "not a member of this server"), true);
  const sctx: ServerCtx = { ...user, serverId };

  if (await handleAgents(sctx)) return true;
  if (await handleReminders(sctx)) return true;
  if (await handleChannels(sctx)) return true;
  if (await handleMessages(sctx)) return true;
  if (await handleAttachments(sctx)) return true;
  if (await handleServersServerScope(sctx)) return true;
  if (await handleTasks(sctx)) return true;

  return (sendErr(res, 404, "not found"), true);
}

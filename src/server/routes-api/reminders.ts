// Auto-extracted from the former routes-api.ts monolith — bodies are verbatim.
import type { ServerCtx } from "./ctx.js";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { sendJson } from "../util.js";

export async function handleReminders(ctx: ServerCtx): Promise<boolean> {
  const { req, res, url, method, p, userId, serverId } = ctx;
  if (p === "/api/reminders" && method === "GET") {
    const ownerAgentId = url.searchParams.get("ownerAgentId") || url.searchParams.get("agentId");
    const status = url.searchParams.get("status"); // scheduled = not yet fired
    let rows = await db.select().from(schema.reminders).where(eq(schema.reminders.serverId, serverId)).orderBy(asc(schema.reminders.remindAt));
    if (ownerAgentId) rows = rows.filter((r) => r.ownerType === "agent" && r.ownerId === ownerAgentId);
    if (status) rows = rows.filter((r) => r.status === status);
    return (sendJson(res, 200, { reminders: rows.map((r) => ({ id: r.id, content: r.content, status: r.status, recurrence: r.recurrence, anchorMessageId: r.anchorMessageId, remindAt: r.remindAt, firedAt: r.firedAt, channelId: r.channelId, ownerType: r.ownerType, ownerId: r.ownerId, createdAt: r.createdAt })) }), true);
  }
  return false;
}

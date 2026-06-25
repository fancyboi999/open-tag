// Auto-extracted from the former routes-api.ts monolith — bodies are verbatim.
import type { ServerCtx } from "./ctx.js";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { TASK_STATUSES, claimTask, convertMessageToTask, createMessage, deleteTask, setTaskStatus, unclaimTask } from "../core.js";
import { readJson, sendErr, sendJson } from "../util.js";
import { attachMentions } from "./shared.js";
import { canUserReadChannel } from "../channelAccess.js";

export async function handleTasks(ctx: ServerCtx): Promise<boolean> {
  const { req, res, method, p, userId, serverId } = ctx;
  // ---- Tasks (messages as tasks) ----
  const tch = /^\/api\/tasks\/channel\/([^/]+)$/.exec(p);
  if (tch && method === "GET") {
    if (!(await canUserReadChannel(serverId, tch[1]!, userId))) return (sendErr(res, 403, "forbidden"), true); // invariant 3: private/DM channel tasks not visible to non-members
    const rows = await db.select().from(schema.messages)
      .where(and(eq(schema.messages.channelId, tch[1]!), isNotNull(schema.messages.taskStatus)))
      .orderBy(asc(schema.messages.taskNumber));
    return (sendJson(res, 200, { tasks: await attachMentions(rows) }), true);
  }
  if (tch && method === "POST") { // New Task: bulk create tasks, body { tasks: [{ title }] }
    if (!(await canUserReadChannel(serverId, tch[1]!, userId))) return (sendErr(res, 403, "forbidden"), true); // invariant 3: non-members must not create tasks in private/DM channels
    const b = await readJson(req);
    const titles = (Array.isArray(b.tasks) ? b.tasks : []).map((t: any) => String(t?.title ?? "").trim()).filter(Boolean);
    if (!titles.length) return (sendErr(res, 400, "tasks[].title required"), true);
    const u = (await db.select().from(schema.users).where(eq(schema.users.id, userId)))[0];
    const created: (typeof schema.messages.$inferSelect)[] = [];
    for (const title of titles) created.push(await createMessage({ serverId, channelId: tch[1]!, senderType: "user", senderId: userId, senderName: u!.name, content: title, asTask: true }));
    return (sendJson(res, 200, { tasks: await attachMentions(created) }), true);
  }
  if (p === "/api/tasks/server" && method === "GET") {
    // Invariant 3: only surface tasks from channels the user may read — their own memberships + all public channels.
    // Private/DM channel tasks must not leak to non-members (same guard as GET /tasks/channel/:id above).
    const memberOf = await db.select({ channelId: schema.channelMembers.channelId }).from(schema.channelMembers)
      .where(and(eq(schema.channelMembers.memberType, "user"), eq(schema.channelMembers.memberId, userId)));
    const publicChs = await db.select({ id: schema.channels.id }).from(schema.channels)
      .where(and(eq(schema.channels.serverId, serverId), eq(schema.channels.type, "channel"), isNull(schema.channels.deletedAt)));
    const accessibleIds = [...new Set([...memberOf.map((m) => m.channelId), ...publicChs.map((c) => c.id)])];
    if (!accessibleIds.length) return (sendJson(res, 200, { tasks: [] }), true);
    const rows = await db.select().from(schema.messages)
      .where(and(eq(schema.messages.serverId, serverId), isNotNull(schema.messages.taskStatus), inArray(schema.messages.channelId, accessibleIds)))
      .orderBy(asc(schema.messages.taskNumber));
    return (sendJson(res, 200, { tasks: await attachMentions(rows) }), true);
  }
  if (p === "/api/tasks/convert-message" && method === "POST") {
    const b = await readJson(req);
    if (!b.messageId) return (sendErr(res, 400, "messageId required"), true);
    const t = await convertMessageToTask(serverId, b.messageId, { type: "user", id: userId });
    return (t ? sendJson(res, 200, { ok: true, id: t.id, taskNumber: t.taskNumber }) : sendErr(res, 404, "message not found"), true);
  }
  const tact = /^\/api\/tasks\/([^/]+)\/(claim|unclaim|status)$/.exec(p);
  if (tact && method === "PATCH") { // claim/unclaim/status are all PATCH
    const [, taskId, action] = tact;
    let r;
    if (action === "claim") {
      r = await claimTask(serverId, taskId!, "user", userId);
      if (!r) return (sendErr(res, 409, "already claimed", { code: "CLAIM_FAILED" }), true); // atomic claim failed: someone else got there first
    }
    else if (action === "unclaim") r = await unclaimTask(serverId, taskId!, { type: "user", id: userId });
    else { const b = await readJson(req).catch(() => ({})); const st = String(b?.status ?? ""); if (!(TASK_STATUSES as readonly string[]).includes(st)) return (sendErr(res, 400, `valid status is required (${TASK_STATUSES.join(", ")})`), true); r = await setTaskStatus(serverId, taskId!, st, { type: "user", id: userId }); }
    return (r ? sendJson(res, 200, { ok: true, taskStatus: r.taskStatus }) : sendErr(res, 404, "task not found"), true);
  }
  const tdel = /^\/api\/tasks\/([^/]+)$/.exec(p);
  if (tdel && method === "DELETE") { // delete task = revert to plain message (clear task fields); source message is preserved
    const r = await deleteTask(serverId, tdel[1]!);
    return (r ? sendJson(res, 200, { ok: true }) : sendErr(res, 404, "task not found"), true);
  }
  return false;
}

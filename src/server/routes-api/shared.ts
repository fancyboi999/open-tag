// Shared helpers used by ≥2 route modules — verbatim from the former routes-api.ts.
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { aggregateReactions } from "../core.js";

export async function attachMentions(msgs: (typeof schema.messages.$inferSelect)[]) {
  if (!msgs.length) return msgs.map((m) => ({ ...m, mentions: [] as any[], attachments: [] as any[], reactions: [] as any[] }));
  const ids = msgs.map((m) => m.id);
  const mts = await db.select().from(schema.messageMentions).where(inArray(schema.messageMentions.messageId, ids));
  const atts = await db.select().from(schema.attachments).where(inArray(schema.attachments.messageId, ids));
  const reactions = await aggregateReactions(ids);
  return msgs.map((m) => ({
    ...m,
    mentions: mts.filter((x) => x.messageId === m.id).map((x) => ({ type: x.mentionType, id: x.mentionId, name: x.mentionName })),
    attachments: atts.filter((a) => a.messageId === m.id).map((a) => ({ id: a.id, filename: a.filename, mimeType: a.mimeType, sizeBytes: a.sizeBytes })),
    reactions: reactions.get(m.id) ?? [],
  }));
}
export async function userChannels(serverId: string, userId: string) {
  const cms = await db.select().from(schema.channelMembers).where(and(eq(schema.channelMembers.memberType, "user"), eq(schema.channelMembers.memberId, userId)));
  const chs = await db.select().from(schema.channels).where(eq(schema.channels.serverId, serverId));
  const joined = new Set(cms.map((c) => c.channelId));
  return { chs, joined };
}
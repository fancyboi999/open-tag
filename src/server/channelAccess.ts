// Shared channel read-access guard for the human REST plane.
// The agent-plane mirror is canAgentReadChannel in core.ts.
// The socket.io room-join check is canReadChannel in socketio.ts (private; not exported).
// All three follow the same logic: channel member OR public channel OR thread of a readable parent.
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";

/**
 * May this human user read (and write to) this channel?
 *
 * True when any of:
 *   • the user is a channel member (channelMembers row exists)
 *   • the channel is public (type="channel") — any server member may access it
 *   • the channel is a thread whose parent channel passes this same check (depth-1 recursion)
 *
 * False for private / DM channels the user is not a member of, and for channels that
 * belong to a different server (invariant 1 + invariant 3, docs/authorization.md).
 *
 * Enforces authorization.md invariant 3 (channel visibility) on the human REST plane.
 */
export async function canUserReadChannel(
  serverId: string,
  channelId: string,
  userId: string,
): Promise<boolean> {
  const member = (
    await db
      .select()
      .from(schema.channelMembers)
      .where(
        and(
          eq(schema.channelMembers.channelId, channelId),
          eq(schema.channelMembers.memberType, "user"),
          eq(schema.channelMembers.memberId, userId),
        ),
      )
  )[0];
  if (member) return true;

  const ch = (
    await db.select().from(schema.channels).where(eq(schema.channels.id, channelId))
  )[0];
  if (!ch || ch.serverId !== serverId || ch.deletedAt) return false;
  if (ch.type === "channel") return true; // public: any server member may read

  if (ch.parentMessageId) {
    // thread: visibility follows its parent message's channel (depth 1 — a parent channel is never itself a thread)
    const parent = (
      await db.select().from(schema.messages).where(eq(schema.messages.id, ch.parentMessageId))
    )[0];
    if (parent) return canUserReadChannel(serverId, parent.channelId, userId);
  }

  return false; // private / DM the user is not a member of
}

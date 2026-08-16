// Shared channel read-access guard for the human REST plane.
// The agent-plane mirror is canAgentReadChannel in core.ts.
// The socket.io room-join check is canReadChannel in socketio.ts (private; not exported).
// All three follow the same logic: channel member OR public channel OR thread of a readable parent.
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { requireCap } from "./capabilities.js";
import { isUuid } from "./util.js";

/**
 * May this human user read (and write to) this channel?
 *
 * True when any of:
 *   • the user is a channel member (channelMembers row exists)
 *   • the channel is public (type="channel") — any server member may access it
 *   • the channel is a thread whose parent channel passes this same check (depth-1 recursion)
 *   • the channel is an agent-only DM (no human members) and the user holds manageAgents —
 *     owner/admin audit read of agent↔agent DMs (invariant 3 audit exemption)
 *
 * False for private / DM channels the user is not a member of, and for channels that
 * belong to a different server (invariant 1 + invariant 3, docs/authorization.md).
 * The agent plane (canAgentReadChannel in core.ts) has NO audit exemption — agents stay
 * isolated from each other's DMs.
 *
 * Enforces authorization.md invariant 3 (channel visibility) on the human REST plane.
 */
export async function canUserReadChannel(
  serverId: string,
  channelId: string,
  userId: string,
): Promise<boolean> {
  if (!isUuid(channelId)) return false; // a non-uuid can't name a channel; casting it into the uuid column would throw (→ 500) instead of refusing
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

  if (ch.type === "dm" && (await requireCap(serverId, userId, "manageAgents"))) {
    // Owner/admin audit: a DM with no human members is an agent↔agent DM; managers may
    // read it (and it lists in their /channels/dm). Human↔agent DMs stay member-private.
    const humanMembers = await db
      .select({ memberType: schema.channelMembers.memberType })
      .from(schema.channelMembers)
      .where(and(eq(schema.channelMembers.channelId, channelId), eq(schema.channelMembers.memberType, "user")));
    if (humanMembers.length === 0) return true;
  }

  if (ch.parentMessageId) {
    // thread: visibility follows its parent message's channel (depth 1 — a parent channel is never itself a thread)
    const parent = (
      await db.select().from(schema.messages).where(eq(schema.messages.id, ch.parentMessageId))
    )[0];
    if (parent) return canUserReadChannel(serverId, parent.channelId, userId);
  }

  return false; // private / DM the user is not a member of
}

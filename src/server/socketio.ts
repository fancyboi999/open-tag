// Human-facing realtime over socket.io.
// Auth: the client handshake auth carries { token, serverId }; the server verifies the JWT +
// checks server membership → joins room server:<serverId> → emits "rooms:joined".
// Events: the server fans out named events like 42["message:new",payload] (see emitMapped).
import { Server as IOServer, type Socket } from "socket.io";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { verifyUser } from "./auth.js";
import { createLogger } from "../log.js";

const log = createLogger("server:io");
let io: IOServer | null = null;

/** Mirror the HTTP CORS whitelist for socket.io handshake/polling requests.
 *  ALLOWED_ORIGIN (comma-separated) gates which browser origins may connect.
 *  Dev fallback (unset): any localhost / 127.0.0.1 origin is allowed. */
function socketIoCorsOrigin(): string | ((origin: string | undefined, cb: (err: Error | null, ok: boolean) => void) => void) {
  const v = process.env.ALLOWED_ORIGIN?.trim();
  if (v) {
    const origins = new Set(v.split(",").map(s => s.trim()).filter(Boolean));
    return (origin, cb) => cb(null, !origin || origins.has(origin));
  }
  // Dev mode: allow localhost / 127.0.0.1 (any port) or no origin (same-origin, postman)
  return (origin, cb) => {
    const ok = !origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    cb(ok ? null : new Error("CORS: origin not allowed"), ok);
  };
}

export function attachSocketIO(server: Server): void {
  io = new IOServer(server, { cors: { origin: socketIoCorsOrigin() }, path: "/socket.io/" });
  io.on("connection", async (socket: Socket) => {
    const auth = (socket.handshake.auth || {}) as { token?: string; serverId?: string };
    const uid = verifyUser(auth.token ?? null);
    const serverId = auth.serverId;
    if (!uid || !serverId) { socket.disconnect(true); return; }
    const mem = (await db.select().from(schema.serverMembers)
      .where(and(eq(schema.serverMembers.serverId, serverId), eq(schema.serverMembers.userId, uid))))[0];
    if (!mem) { socket.disconnect(true); return; }
    socket.data.uid = uid; socket.data.serverId = serverId;
    socket.join(`server:${serverId}`);
    // Channel isolation: join the channel:<id> room for every channel this user belongs to → content-bearing events only reach members, so private channels are not leaked to non-members
    const myChans = await db.select({ channelId: schema.channelMembers.channelId }).from(schema.channelMembers)
      .where(and(eq(schema.channelMembers.memberType, "user"), eq(schema.channelMembers.memberId, uid)));
    for (const c of myChans) socket.join(`channel:${c.channelId}`);
    socket.emit("rooms:joined");
    log.debug("socket connected", { uid, serverId, channels: myChans.length });
    // Mid-session join: client emits join:channel when it opens a channel/thread → server joins the room IFF the
    // user can read it (member / public channel / thread of a readable channel), so realtime tracks what you view.
    socket.on("join:channel", async (channelId: string) => {
      if (!channelId || typeof channelId !== "string") return;
      if (await canReadChannel(uid, serverId, channelId)) socket.join(`channel:${channelId}`); // refuses private/DM non-members (no content leak)
    });
    socket.on("leave:channel", (channelId: string) => { if (typeof channelId === "string") socket.leave(`channel:${channelId}`); });
    socket.on("disconnect", (reason) => log.debug("socket disconnected", { uid, reason }));
  });
  log.info("socket.io attached", { path: "/socket.io/" });
}

// May this user READ this channel (and thus join its realtime room)? Read access = channel member, OR a public
// channel in the user's server, OR a thread whose parent channel is readable. Private/DM channels the user is not a
// member of are refused → content stays isolated. The socket already verified server membership at connect time.
async function canReadChannel(uid: string, serverId: string, channelId: string): Promise<boolean> {
  const member = (await db.select().from(schema.channelMembers).where(and(eq(schema.channelMembers.channelId, channelId), eq(schema.channelMembers.memberType, "user"), eq(schema.channelMembers.memberId, uid))))[0];
  if (member) return true;
  const ch = (await db.select().from(schema.channels).where(eq(schema.channels.id, channelId)))[0];
  if (!ch || ch.serverId !== serverId || ch.deletedAt) return false;
  if (ch.type === "channel") return true;                                  // public: any server member may read realtime events
  if (ch.parentMessageId) {                                                 // thread: visibility follows its parent message's channel
    const parent = (await db.select().from(schema.messages).where(eq(schema.messages.id, ch.parentMessageId)))[0];
    if (parent) return canReadChannel(uid, serverId, parent.channelId);     // depth 1 (a parent channel is never itself a thread)
  }
  return false;                                                             // private / DM the user is not a member of
}

// Internal event object → named realtime events. Content-bearing events (message/task) only fan out to channel:<channelId> rooms (members only),
// preventing private channel content from leaking to non-members; metadata / server-level events (agent/machine/thread:updated) fan out to server:<serverId>.
export function emitMapped(serverId: string, event: any): void {
  if (!io) return;
  const srv = io;                                                           // capture non-null (io is not narrowed inside the closure)
  const room = srv.to(`server:${serverId}`);                                // server-level (all members)
  const chan = (cid: string) => srv.to(`channel:${cid}`);                   // channel-level (channel members only)
  switch (event?.type) {
    case "message": chan(event.message.channelId).emit("message:new", event.message); break; // content → channel members only
    case "task": {
      if (event.op === "deleted") { chan(event.channelId).emit("task:deleted", { channelId: event.channelId, taskId: event.taskId }); break; }
      const t = event.task; // = serializeMsg(message), includes channelId
      if (event.op === "created") chan(t.channelId).emit("task:created", { channelId: t.channelId, tasks: [t] });
      else chan(t.channelId).emit("task:updated", { channelId: t.channelId, task: t });
      chan(t.channelId).emit("message:updated", t); // task ops also emit message:updated to sync the source message's task fields (channel members only)
      break;
    }
    // agent:activity merges status + trajectory (carries entries[]). Internally we still keep status/trajectory as two sources; map both to this single event here.
    case "agent": room.emit("agent:activity", { agentId: event.id, name: event.name, status: event.status, activity: event.activity }); break;
    case "trajectory": room.emit("agent:activity", { agentId: event.agentId, name: event.name, entries: event.entries }); break;
    case "message:updated": chan(event.message.channelId).emit("message:updated", event.message); break; // reactions/edits (content) → channel members only
    case "thread:updated": room.emit("thread:updated", { threadChannelId: event.threadChannelId, parentMessageId: event.parentMessageId, replyCount: event.replyCount, participantIds: event.participantIds }); break;
    case "agent:created": room.emit("agent:created", event.agent); break;
    case "agent:deleted": room.emit("agent:deleted", { id: event.id }); break;
    case "machine": room.emit("machine:status", { machineId: event.machineId, status: event.online ? "online" : "offline", online: event.online, hostname: event.hostname, runtimes: event.runtimes }); break; // machine status payload: machineId + status ("online"/"offline")
    default: if (event?.type) room.emit(String(event.type), event);
  }
}

// Redis: global monotonic seq counter + SSE realtime fan-out (pub/sub) + agent receive long-poll helper
import { Redis } from "ioredis"; // named import: under NodeNext the default import does not resolve the constructor signature (tsc TS2351)
import { eq, max } from "drizzle-orm";
import { db, schema } from "./db/index.js";

const url = process.env.REDIS_URL ?? "redis://localhost:6380";
export const redis = new Redis(url);
export const pub = new Redis(url);
export const sub = new Redis(url);

/**
 * Startup alignment (durability guard): advances each server's Redis counters (seq / tasknum) to
 * at least the current Postgres maximum. Without this, if Redis loses data (flush / instance swap /
 * volume loss / eviction), INCR restarts from a low value → new message seq collides with existing
 * records, and seq < client lastSeq causes those messages to be silently dropped by /messages/sync.
 * Must complete before the server begins accepting connections (listen).
 */
export async function reconcileCounters(): Promise<{ servers: number; seqFixed: number; taskFixed: number }> {
  const seqRows = await db.select({ serverId: schema.messages.serverId, m: max(schema.messages.seq) }).from(schema.messages).groupBy(schema.messages.serverId);
  let seqFixed = 0, taskFixed = 0;
  for (const r of seqRows) {
    const dbMax = Number(r.m ?? 0);
    const cur = Number((await redis.get(`seq:${r.serverId}`)) ?? 0);
    if (dbMax > cur) { await redis.set(`seq:${r.serverId}`, String(dbMax)); seqFixed++; }
  }
  // tasknum is scoped per scope-key (see taskNumberKey): DM tasks counted per DM channel, all other
  // tasks counted per server. Group the DB max(taskNumber) by (server, channel, type), fold into the
  // matching Redis scope key, then advance each counter to its scope's max — so a Redis loss never
  // rewinds either a channel-wide or a per-DM sequence into existing numbers.
  const taskRows = await db
    .select({ serverId: schema.messages.serverId, channelId: schema.messages.channelId, type: schema.channels.type, m: max(schema.messages.taskNumber) })
    .from(schema.messages)
    .innerJoin(schema.channels, eq(schema.messages.channelId, schema.channels.id))
    .groupBy(schema.messages.serverId, schema.messages.channelId, schema.channels.type);
  const scopeMax = new Map<string, number>(); // redis scope key → highest taskNumber seen in DB
  for (const r of taskRows) {
    const dbMax = Number(r.m ?? 0);
    if (!dbMax) continue;
    const key = taskNumberKey(r.serverId, { type: r.type, id: r.channelId });
    scopeMax.set(key, Math.max(scopeMax.get(key) ?? 0, dbMax));
  }
  for (const [key, dbMax] of scopeMax) {
    const cur = Number((await redis.get(key)) ?? 0);
    if (dbMax > cur) { await redis.set(key, String(dbMax)); taskFixed++; }
  }
  return { servers: seqRows.length, seqFixed, taskFixed };
}

/** Global monotonic sequence number within a server (drives incremental sync). */
export function nextSeq(serverId: string): Promise<number> {
  return redis.incr(`seq:${serverId}`);
}

/**
 * Redis key for a task-number counter. Tasks in a DM are numbered per-DM (each conversation has its
 * own #1, #2, … independent of the workspace) so a private 1:1 thread never shares the channel-wide
 * sequence; every other channel type (channel / private / thread) shares the per-server counter.
 * Pure — unit-testable without Redis.
 */
export function taskNumberKey(serverId: string, channel?: { type: string; id: string } | null): string {
  return channel?.type === "dm" ? `tasknum:dm:${channel.id}` : `tasknum:${serverId}`;
}

/** Monotonic task number, incremented within the channel's scope (per-DM for DMs, per-server otherwise). */
export function nextTaskNumber(serverId: string, channel?: { type: string; id: string } | null): Promise<number> {
  return redis.incr(taskNumberKey(serverId, channel));
}

/** Broadcast an event to a server's realtime channel (SSE handler subscribes to events:{serverId}). */
export function publishEvent(serverId: string, event: unknown): Promise<number> {
  return pub.publish(`events:${serverId}`, JSON.stringify(event));
}

/** Wake an agent waiting on a receive long-poll (list push; consumed via BLPOP). */
export function pokeAgent(agentId: string): Promise<number> {
  return redis.rpush(`wake:${agentId}`, "1");
}

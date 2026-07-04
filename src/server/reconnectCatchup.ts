// Reconnect catch-up: when a machine's daemon (re)connects, wake the agents on it that accumulated a
// "wakeable" backlog while the machine was offline, so they process the messages they missed. This is the
// symmetric counterpart to the human side — the browser's socket reconnect path (store.tsx) re-syncs missed
// messages, but agents had no equivalent, so an @ sent to an offline agent's machine sat unread forever.
//
// "Backfilling" missed messages is NOT message replay: a woken agent's STARTUP_NUDGE / RESUME_NUDGE
// (daemon/prompt.ts) drives it to run `open-tag message check`, which pulls every unread (seq > lastReadSeq)
// including the ones missed while offline. So catch-up only needs to wake the right agents — the agent
// pulls the rest itself.
//
// The wake criterion is the conservative mirror of createMessage's wake branch (core.ts, "Agent-side wake"):
// DM/@ wake unconditionally; ambient (non-@) wakes only with the inbox:receive scope. The two stay in sync
// through agentWakePolicy — see docs/superpowers/specs/2026-06-25-agent-reachability-design.md §5.4.
import { and, eq, gt, ne, or, isNull, desc } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { agentHasScope } from "./scopes.js";
import { broadcastToDaemons } from "./daemonHub.js";
import { agentConfig } from "./core.js";
import { createLogger } from "../log.js";
import { isWakeable } from "./agentWakePolicy.js";

export { isWakeable } from "./agentWakePolicy.js";

const log = createLogger("server:catchup");
// Per-machine anti-thrash: a flapping link (connect/drop/connect) must not re-scan + re-wake on every blip.
// Single-instance, like daemonHub's in-memory registry. lastReadSeq advancing after the agent checks is the
// real idempotency guard (a checked agent has no backlog next time); this just caps the scan rate.
const COOLDOWN_MS = Number(process.env.OPEN_TAG_CATCHUP_COOLDOWN_MS ?? 30_000);
const lastRun = new Map<string, number>(); // machineId → last catch-up start ts

interface Backlog { count: number; from: string; targetName: string; }

/** Does this agent have a wakeable backlog (unread messages that would have woken it)? Returns a small
 *  summary used to build the soft-offline inbox notice, or null when there is nothing wakeable. */
async function computeBacklog(agentId: string, scopes: Parameters<typeof agentHasScope>[0]): Promise<Backlog | null> {
  const hasInbox = agentHasScope(scopes, "inbox:receive");
  const memberships = await db.select({
    channelId: schema.channelMembers.channelId,
    lastReadSeq: schema.channelMembers.lastReadSeq,
    type: schema.channels.type,
    name: schema.channels.name,
  }).from(schema.channelMembers)
    .innerJoin(schema.channels, eq(schema.channels.id, schema.channelMembers.channelId))
    .where(and(eq(schema.channelMembers.memberType, "agent"), eq(schema.channelMembers.memberId, agentId)));

  let count = 0;
  let latest: { seq: number; from: string; targetName: string } | null = null;
  // Exclude the agent's own messages; keep system (senderId null) — matches createMessage's `mem.id === senderId` skip.
  const notSelf = or(isNull(schema.messages.senderId), ne(schema.messages.senderId, agentId));

  for (const m of memberships) {
    const unread = and(eq(schema.messages.channelId, m.channelId), gt(schema.messages.seq, m.lastReadSeq), notSelf);
    const rowsBySeq = new Map<number, { seq: number; from: string }>();
    if (m.type === "dm") {
      const rows = await db.select({ seq: schema.messages.seq, from: schema.messages.senderName })
        .from(schema.messages).where(unread).orderBy(desc(schema.messages.seq));
      for (const row of rows) rowsBySeq.set(row.seq, row);
    } else {
      const mentionedRows = await db.select({ seq: schema.messages.seq, from: schema.messages.senderName })
        .from(schema.messages)
        .innerJoin(schema.messageMentions, eq(schema.messageMentions.messageId, schema.messages.id))
        .where(and(unread, eq(schema.messageMentions.mentionType, "agent"), eq(schema.messageMentions.mentionId, agentId)))
        .orderBy(desc(schema.messages.seq));
      for (const row of mentionedRows) rowsBySeq.set(row.seq, row);
      if (isWakeable({ channelType: m.type, mentioned: false, hasInboxScope: hasInbox, senderType: "user" })) {
        const ambientRows = await db.select({ seq: schema.messages.seq, from: schema.messages.senderName })
          .from(schema.messages)
          .where(and(unread, ne(schema.messages.senderType, "agent")))
          .orderBy(desc(schema.messages.seq));
        for (const row of ambientRows) rowsBySeq.set(row.seq, row);
      }
    }
    const rows = [...rowsBySeq.values()].sort((a, b) => b.seq - a.seq);
    if (rows.length) {
      count += rows.length;
      const top = rows[0]!; // highest seq in this channel
      if (!latest || top.seq > latest.seq) {
        latest = { seq: top.seq, from: top.from, targetName: m.type === "dm" ? `dm:@${top.from}` : `#${m.name ?? ""}` };
      }
    }
  }
  return latest ? { count, from: latest.from, targetName: latest.targetName } : null;
}

/** Wake every agent on this machine that has a wakeable backlog. Called from ws.ts onReady AFTER the
 *  stale-agent reconciliation, so `runningIds` (the agents the daemon reports actually running) is current.
 *  Best-effort: any failure is logged and never propagates — onReady's health takes priority. */
export async function catchUpAgentsOnMachine(serverId: string, machineId: string, runningIds: string[]): Promise<void> {
  const now = Date.now();
  if (now - (lastRun.get(machineId) ?? 0) < COOLDOWN_MS) { log.debug("catch-up skipped (cooldown)", { machineId }); return; }
  lastRun.set(machineId, now);

  const list = await db.select({ id: schema.agents.id, scopes: schema.agents.scopes })
    .from(schema.agents)
    .where(and(eq(schema.agents.machineId, machineId), eq(schema.agents.serverId, serverId), isNull(schema.agents.deletedAt)));

  let woke = 0;
  for (const a of list) {
    let backlog: Backlog | null = null;
    try { backlog = await computeBacklog(a.id, a.scopes); }
    catch (e: any) { log.warn("backlog scan failed", { agentId: a.id, detail: String(e?.message ?? e) }); continue; }
    if (!backlog) continue;
    if (!runningIds.includes(a.id)) {
      // hard offline (process dead): start with resume; the startup nudge self-checks the inbox and pulls the missed messages
      const cfg = await agentConfig(a.id);
      if (cfg) { broadcastToDaemons(serverId, { type: "agent:start", agentId: a.id, config: cfg }); woke++; }
    } else {
      // soft offline (WS dropped, process alive): agent:start is a no-op for a running agent (agentManager.ts),
      // so inject an inbox notice via deliver to drive a `message check`. Body-free: the agent pulls real unread.
      broadcastToDaemons(serverId, {
        type: "agent:deliver", agentId: a.id, seq: 0, from: backlog.from,
        target: "", targetName: backlog.targetName, msgShort: "", isTask: false, mentioned: false,
      });
      woke++;
    }
  }
  if (woke) log.info("reconnect catch-up woke agents with backlog", { machineId, woke, scanned: list.length });
}

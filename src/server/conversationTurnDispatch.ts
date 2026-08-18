import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { createLogger } from "../log.js";
import { expectAgentDeliveryAck } from "./agentDeliveryAck.js";
import { isWakeable } from "./agentWakePolicy.js";
import {
  activateConversationTurnDispatch,
  claimCausalAgentWake,
  claimConversationTurnDispatch,
  finishConversationTurnDispatch,
  messagesForConversationTurn,
  pauseActiveConversationTurnDispatch,
  recentConversationOwner,
  renewConversationTurnDispatchLease,
  retryActiveConversationTurnDispatch,
  retryConversationTurnDispatch,
  scheduleConversationTurn,
} from "./conversationTurns.js";
import { publish } from "./realtime.js";
import { ensureReplyRecipients, releaseUnavailableReplyGrant, reserveReplyRecipients, type ReplyRecipient } from "./replyCoordination.js";
import { agentHasScope } from "./scopes.js";
import { inputSenderAllowed } from "./agentInputPolicy.js";
import { attributedInputSenderType } from "./agentInputView.js";

type PersistedMessage = typeof schema.messages.$inferSelect;
type PersistedChannel = typeof schema.channels.$inferSelect;
type PersistedTurn = typeof schema.conversationTurns.$inferSelect;

export interface DispatchMember {
  type: "user" | "agent";
  id: string;
  name: string;
  displayName: string;
}

export interface ConversationTurnDispatchDeps<TTarget extends { ok: true }> {
  channelMembers(channelId: string): Promise<DispatchMember[]>;
  parseMentions(content: string, members: DispatchMember[]): DispatchMember[];
  agentStartTarget(serverId: string, agentId: string): Promise<TTarget | { ok: false; reason: string; retryable?: boolean }>;
  /** Pure capability/topology check used before an explicit multi-recipient Turn becomes visible. */
  agentStartPreflight?(serverId: string, agentId: string): Promise<{ ok: true } | { ok: false; reason: string; retryable?: boolean }>;
  sendAgentStart(serverId: string, target: TTarget, agentId: string, durableTurn?: boolean): boolean;
  sendAgentDeliver(serverId: string, target: TTarget, message: Record<string, unknown>): boolean;
  markAgentUnavailable(serverId: string, agentId: string, reason: string): Promise<void>;
  finalizeAgentActivityRun(serverId: string, agentId: string, channelId: string, streamId: string, agentName: string, state: "handled" | "error"): Promise<void>;
}

const log = createLogger("server:turn-dispatch");

async function allowedInputTargetIds(
  turn: Pick<PersistedTurn, "serverId" | "senderType" | "senderId">,
  targetIds: string[],
): Promise<Set<string>> {
  if (turn.senderType !== "agent" || !targetIds.length) return new Set(targetIds);
  const targets = await db.select({
    id: schema.agents.id,
    incomingMode: schema.agents.incomingMode,
    commandWhitelist: schema.agents.commandWhitelist,
  }).from(schema.agents).where(and(
    eq(schema.agents.serverId, turn.serverId),
    isNull(schema.agents.deletedAt),
    inArray(schema.agents.id, targetIds),
  ));
  return new Set(targets
    .filter((target) => inputSenderAllowed(target, turn.senderType, turn.senderId))
    .map((target) => target.id));
}

/** Reserve deterministic Turn responsibility before any early/manual inbox check can race for primary. */
export async function prepareConversationTurnResponsibility(
  turn: PersistedTurn,
  channel: PersistedChannel | undefined,
  members: DispatchMember[],
  mentions: DispatchMember[],
): Promise<void> {
  if (!channel) return;
  const agentMembers = members.filter((member) => member.type === "agent" && member.id !== turn.senderId);
  // Trigger-source policy: an agent-sender may only command (wake/assign) recipients whose
  // incoming_mode allows it. Humans are always allowed (senderAllowedByPolicy).
  const policyRows = turn.senderType === "agent" && agentMembers.length
    ? await db.select({ id: schema.agents.id, incomingMode: schema.agents.incomingMode, commandWhitelist: schema.agents.commandWhitelist })
      .from(schema.agents).where(inArray(schema.agents.id, agentMembers.map((member) => member.id)))
    : [];
  const policyById = new Map(policyRows.map((row) => [row.id, row]));
  const allowed = (member: DispatchMember) => {
    const row = policyById.get(member.id);
    return !row || inputSenderAllowed(row, turn.senderType, turn.senderId);
  };
  let recipients: ReplyRecipient[] = [];
  if (channel.type === "dm") {
    recipients = agentMembers.filter(allowed).map((member) => ({ agentId: member.id, attention: "dm" }));
  } else {
    const directed = mentions.filter((member) => member.type === "agent" && member.id !== turn.senderId && allowed(member));
    if (directed.length) {
      recipients = directed.map((member) => ({ agentId: member.id, attention: "direct" }));
    } else if (turn.senderType === "user") {
      const rows = agentMembers.length
        ? await db.select({ id: schema.agents.id, scopes: schema.agents.scopes }).from(schema.agents).where(inArray(schema.agents.id, agentMembers.map((member) => member.id)))
        : [];
      const scoped = new Set(rows.filter((agent) => agentHasScope(agent.scopes, "inbox:receive")).map((agent) => agent.id));
      const candidates = agentMembers.filter((member) => scoped.has(member.id));
      const activeAssignments = candidates.length
        ? await db.select({ agentId: schema.agentMessageDecisions.agentId }).from(schema.agentMessageDecisions).where(and(
          inArray(schema.agentMessageDecisions.agentId, candidates.map((member) => member.id)),
          eq(schema.agentMessageDecisions.attention, "assigned"),
          inArray(schema.agentMessageDecisions.grantStatus, ["reserved", "active", "publishing"]),
        ))
        : [];
      const load = new Map<string, number>();
      for (const assignment of activeAssignments) load.set(assignment.agentId, (load.get(assignment.agentId) ?? 0) + 1);
      candidates.sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0) || a.id.localeCompare(b.id));
      const stickyOwner = await recentConversationOwner(turn);
      if (stickyOwner) candidates.sort((a, b) => Number(b.id === stickyOwner) - Number(a.id === stickyOwner));
      if (candidates[0]) recipients = [{ agentId: candidates[0].id, attention: "assigned" }];
    }
  }
  const allowed = await allowedInputTargetIds(turn, recipients.map((recipient) => recipient.agentId));
  recipients = recipients.filter((recipient) => allowed.has(recipient.agentId));
  await reserveReplyRecipients({ serverId: turn.serverId, channelId: turn.channelId, messageId: turn.triggerMessageId, recipients });
  if (recipients[0]) {
    await db.update(schema.conversationTurns).set({
      ownerAgentId: recipients[0].agentId,
      responsibilityState: "assigned",
      updatedAt: new Date(),
    }).where(eq(schema.conversationTurns.id, turn.id));
  }
}

interface AgentDeliveryInput {
  serverId: string;
  channelId: string;
  trigger: PersistedMessage;
  latest: PersistedMessage;
  member: DispatchMember;
  attention: ReplyRecipient["attention"];
  mentioned: boolean;
  isTask: boolean;
  targetName: string;
  turnId?: string;
  turnMessageCount?: number;
  preserveGrantOnFailure?: boolean;
}

type AgentDeliveryOutcome = "delivered" | "retryable_failure" | "capability_blocked";

async function deliverAgentResponsibility<TTarget extends { ok: true }>(
  input: AgentDeliveryInput,
  deps: ConversationTurnDispatchDeps<TTarget>,
): Promise<AgentDeliveryOutcome> {
  await ensureReplyRecipients({
    serverId: input.serverId,
    channelId: input.channelId,
    messageId: input.trigger.id,
    recipients: [{ agentId: input.member.id, attention: input.attention }],
  });
  if (input.turnId) {
    const [existing] = await db.select({ deliveryAdmittedAt: schema.agentMessageDecisions.deliveryAdmittedAt })
      .from(schema.agentMessageDecisions).where(and(
        eq(schema.agentMessageDecisions.messageId, input.trigger.id),
        eq(schema.agentMessageDecisions.agentId, input.member.id),
      )).limit(1);
    if (existing?.deliveryAdmittedAt) return "delivered";
  }
  const target = await deps.agentStartTarget(input.serverId, input.member.id);
  if (!target.ok) {
    const capabilityBlocked = target.retryable === false;
    if (!input.preserveGrantOnFailure) await releaseUnavailableReplyGrant(input.trigger.id, input.member.id);
    if (target.reason !== "agent not found") await deps.markAgentUnavailable(input.serverId, input.member.id, target.reason);
    return capabilityBlocked ? "capability_blocked" : "retryable_failure";
  }

  const replyStreamId = `${input.trigger.id}:${input.member.id}`;
  const startSent = deps.sendAgentStart(input.serverId, target, input.member.id, Boolean(input.turnId));
  const deliveryId = input.turnId ? `${input.turnId}:${input.member.id}` : undefined;
  const ack = startSent && deliveryId ? expectAgentDeliveryAck(deliveryId, input.member.id, input.latest.seq) : null;
  let deliverSent = false;
  try {
    deliverSent = startSent && deps.sendAgentDeliver(input.serverId, target, {
      agentId: input.member.id,
      seq: input.latest.seq,
      from: input.latest.senderName,
      target: input.channelId,
      targetName: input.targetName,
      msgShort: input.trigger.id.slice(0, 8),
      isTask: input.isTask,
      mentioned: input.mentioned,
      streamId: replyStreamId,
      turnId: input.turnId,
      turnMessageCount: input.turnMessageCount,
      attention: input.attention,
      deliveryId,
    });
  } catch (error) {
    ack?.cancel();
    throw error;
  }
  if (deliverSent) {
    if (ack) await ack.promise;
    return "delivered";
  }
  ack?.cancel();

  if (!input.preserveGrantOnFailure) await releaseUnavailableReplyGrant(input.trigger.id, input.member.id);
  await publish(input.serverId, {
    type: "agent:reply",
    agentId: input.member.id,
    channelId: input.channelId,
    streamId: replyStreamId,
    name: input.member.displayName || input.member.name,
    op: "error",
    text: "machine offline",
  });
  await deps.finalizeAgentActivityRun(input.serverId, input.member.id, input.channelId, replyStreamId, input.member.displayName || input.member.name, "error");
  await deps.markAgentUnavailable(input.serverId, input.member.id, "machine offline");
  return "retryable_failure";
}

/** Compatibility path for non-conversational system messages. User/Agent chat uses durable Turn dispatch. */
export async function dispatchLegacyMessage<TTarget extends { ok: true }>(input: {
  msg: PersistedMessage;
  channel: PersistedChannel | undefined;
  members: DispatchMember[];
  mentions: DispatchMember[];
  asTask: boolean;
}, deps: ConversationTurnDispatchDeps<TTarget>): Promise<void> {
  const mentionedAgents = new Set(input.mentions.filter((member) => member.type === "agent").map((member) => member.id));
  const isDm = input.channel?.type === "dm";
  const targetName = isDm ? `dm:@${input.msg.senderName}` : `#${input.channel?.name ?? input.msg.channelId}`;
  const candidates = input.members.filter((candidate) => candidate.type === "agent"
    && (input.msg.senderType === "system" || candidate.id !== input.msg.senderId));
  const targetRows = candidates.length ? await db.select({
    id: schema.agents.id,
    serverId: schema.agents.serverId,
    incomingMode: schema.agents.incomingMode,
    commandWhitelist: schema.agents.commandWhitelist,
  }).from(schema.agents).where(and(
    eq(schema.agents.serverId, input.msg.serverId),
    isNull(schema.agents.deletedAt),
    inArray(schema.agents.id, candidates.map((candidate) => candidate.id)),
  )) : [];
  const targets = new Map(targetRows.map((target) => [target.id, target]));
  const senderType = await attributedInputSenderType(input.msg.serverId, input.msg);
  for (const member of candidates) {
    const target = targets.get(member.id);
    if (!target || !inputSenderAllowed(target, senderType, input.msg.senderId)) continue;
    const mentioned = mentionedAgents.has(member.id);
    if (!isDm && !mentioned) {
      const row = (await db.select({ scopes: schema.agents.scopes }).from(schema.agents).where(eq(schema.agents.id, member.id)))[0];
      if (!isWakeable({
        channelType: input.channel?.type ?? "channel",
        mentioned,
        hasInboxScope: agentHasScope(row?.scopes, "inbox:receive"),
        senderType,
      })) continue;
    }
    await deliverAgentResponsibility({
      serverId: input.msg.serverId,
      channelId: input.msg.channelId,
      trigger: input.msg,
      latest: input.msg,
      member,
      attention: mentioned ? "direct" : isDm ? "dm" : "ambient",
      mentioned,
      isTask: input.asTask,
      targetName,
    }, deps);
  }
}

/** Durable Turn dispatcher: exactly one process claims the turn before any Activity or daemon side effect. */
export async function dispatchConversationTurn<TTarget extends { ok: true }>(
  turnId: string,
  deps: ConversationTurnDispatchDeps<TTarget>,
): Promise<void> {
  const claimed = await claimConversationTurnDispatch(turnId);
  if (!claimed) {
    const current = (await db.select().from(schema.conversationTurns).where(eq(schema.conversationTurns.id, turnId)).limit(1))[0];
    if (current?.state === "collecting" || current?.state === "ready") scheduleConversationTurn(current.id, current.dispatchAfter);
    else if ((current?.state === "active" || current?.state === "dispatching") && current.dispatchLeaseUntil) scheduleConversationTurn(current.id, current.dispatchLeaseUntil);
    return;
  }

  let activeAttempt = claimed.state === "active";
  try {
    const attempt = claimed.dispatchAttempts;
    const turnMessages = await messagesForConversationTurn(claimed.id);
    if (!turnMessages.length) {
      await finishConversationTurnDispatch(claimed.id, attempt, null, "completed");
      return;
    }
    const trigger = turnMessages.find((message) => message.id === claimed.triggerMessageId) ?? turnMessages[0]!;
    const latest = turnMessages[turnMessages.length - 1]!;
    const channel = (await db.select().from(schema.channels).where(eq(schema.channels.id, claimed.channelId)).limit(1))[0];
    if (!channel) {
      await finishConversationTurnDispatch(claimed.id, attempt, null, "blocked");
      return;
    }
    const members = await deps.channelMembers(claimed.channelId);
    const mentionedOrder: string[] = [];
    for (const message of turnMessages) {
      for (const mention of deps.parseMentions(message.content, members)) {
        if (mention.type === "agent" && !mentionedOrder.includes(mention.id)) mentionedOrder.push(mention.id);
      }
    }
    const mentionedSet = new Set(mentionedOrder);
    const agentMembers = members.filter((member) => member.type === "agent" && member.id !== claimed.senderId);
    const byId = new Map(agentMembers.map((member) => [member.id, member]));
    const isDm = channel.type === "dm";
    const isTask = turnMessages.some((message) => !!message.taskStatus);
    const targetName = isDm ? `dm:@${latest.senderName}` : `#${channel.name}`;

    let candidates: DispatchMember[] = [];
    let attention: ReplyRecipient["attention"] = "assigned";
    let fallbackOwner = false;
    if (isDm) {
      candidates = agentMembers;
      attention = "dm";
      if (!candidates.length) {
        await finishConversationTurnDispatch(claimed.id, attempt, null, "completed");
        return;
      }
    } else if (mentionedOrder.length) {
      candidates = mentionedOrder.map((id) => byId.get(id)).filter((member): member is DispatchMember => !!member);
      attention = "direct";
    } else if (claimed.senderType === "user") {
      const agentRows = agentMembers.length
        ? await db.select({ id: schema.agents.id, scopes: schema.agents.scopes }).from(schema.agents).where(inArray(schema.agents.id, agentMembers.map((member) => member.id)))
        : [];
      const scoped = new Set(agentRows.filter((agent) => agentHasScope(agent.scopes, "inbox:receive")).map((agent) => agent.id));
      candidates = agentMembers.filter((member) => scoped.has(member.id)).sort((a, b) => a.id.localeCompare(b.id));
      const stickyOwner = await recentConversationOwner(claimed);
      if (stickyOwner) candidates.sort((a, b) => Number(b.id === stickyOwner) - Number(a.id === stickyOwner));
      fallbackOwner = true;
      attention = "assigned";
    } else {
      await finishConversationTurnDispatch(claimed.id, attempt, null, "completed");
      return;
    }
    const allowed = await allowedInputTargetIds(claimed, candidates.map((candidate) => candidate.id));
    const rejected = candidates.filter((candidate) => !allowed.has(candidate.id));
    candidates = candidates.filter((candidate) => allowed.has(candidate.id));
    for (const member of rejected) await releaseUnavailableReplyGrant(trigger.id, member.id);
    if (rejected.length && !candidates.length) {
      await finishConversationTurnDispatch(claimed.id, attempt, null, "completed");
      return;
    }
    if (claimed.ownerAgentId) candidates.sort((a, b) => Number(b.id === claimed.ownerAgentId) - Number(a.id === claimed.ownerAgentId));

    const admittedCandidates: DispatchMember[] = [];
    for (const member of candidates) {
      if (claimed.senderType === "agent" && (isDm || mentionedSet.has(member.id))) {
        const causal = await claimCausalAgentWake(claimed, member.id);
        if (causal !== "accepted") {
          await releaseUnavailableReplyGrant(trigger.id, member.id);
          log.warn("agent work wake suppressed", { turnId: claimed.id, sourceAgentId: claimed.senderId, targetAgentId: member.id, causal });
          continue;
        }
      }
      admittedCandidates.push(member);
    }

    let ownerAgentId: string | null = fallbackOwner ? null : admittedCandidates[0]?.id ?? null;
    if (!fallbackOwner && admittedCandidates.length) {
      await reserveReplyRecipients({
        serverId: claimed.serverId,
        channelId: claimed.channelId,
        messageId: trigger.id,
        recipients: admittedCandidates.map((member) => ({ agentId: member.id, attention })),
      });

      // Explicit fan-out is one user intent. Capability-check every recipient before the
      // Turn or its grants become visible so a mixed-version fleet cannot start only half the team.
      const preflight = await Promise.all(admittedCandidates.map(async (member) => ({
        member,
        target: await (deps.agentStartPreflight ?? deps.agentStartTarget)(claimed.serverId, member.id),
      })));
      const capabilityBlocked = preflight.find(({ target }) => !target.ok && target.retryable === false);
      if (capabilityBlocked && !capabilityBlocked.target.ok) {
        await deps.markAgentUnavailable(claimed.serverId, capabilityBlocked.member.id, capabilityBlocked.target.reason);
        await ensureReplyRecipients({
          serverId: claimed.serverId,
          channelId: claimed.channelId,
          messageId: trigger.id,
          recipients: admittedCandidates.map((member) => ({ agentId: member.id, attention })),
        });
        await pauseActiveConversationTurnDispatch(claimed, new Error(
          `directed recipient daemon lacks durable delivery admission: ${capabilityBlocked.member.id}`,
        ));
        return;
      }
      await ensureReplyRecipients({
        serverId: claimed.serverId,
        channelId: claimed.channelId,
        messageId: trigger.id,
        recipients: admittedCandidates.map((member) => ({ agentId: member.id, attention })),
      });
      if (!await activateConversationTurnDispatch(claimed.id, attempt, ownerAgentId)) return;
      activeAttempt = true;
    }

    const deliverCandidate = async (member: DispatchMember, preserveGrantOnFailure: boolean, isolateFailure: boolean): Promise<AgentDeliveryOutcome> => {
      try {
        const delivered = await deliverAgentResponsibility({
          serverId: claimed.serverId,
          channelId: claimed.channelId,
          trigger,
          latest,
          member,
          attention,
          mentioned: mentionedSet.has(member.id),
          isTask,
          targetName,
          turnId: claimed.id,
          turnMessageCount: turnMessages.length,
          preserveGrantOnFailure,
        }, deps);
        if (delivered !== "delivered" && !preserveGrantOnFailure) await releaseUnavailableReplyGrant(trigger.id, member.id);
        return delivered;
      } catch (error) {
        if (!isolateFailure) throw error;
        const replyStreamId = `${trigger.id}:${member.id}`;
        await publish(claimed.serverId, {
          type: "agent:reply",
          agentId: member.id,
          channelId: claimed.channelId,
          streamId: replyStreamId,
          name: member.displayName || member.name,
          op: "error",
          text: "delivery rejected",
        });
        await deps.finalizeAgentActivityRun(claimed.serverId, member.id, claimed.channelId, replyStreamId, member.displayName || member.name, "error");
        log.warn("conversation turn recipient delivery failed", {
          turnId: claimed.id,
          attempt,
          agentId: member.id,
          detail: String((error as Error)?.message ?? error),
        });
        return "retryable_failure";
      }
    };

    let delivered = 0;
    if (!fallbackOwner && admittedCandidates.length) {
      // Directed fan-out is bounded by one ACK timeout, not N sequential timeouts. This keeps
      // one dispatch attempt inside its lease and lets each recipient settle independently.
      const outcomes = await Promise.all(admittedCandidates.map((member) => deliverCandidate(member, true, true)));
      delivered = outcomes.filter((outcome) => outcome === "delivered").length;
      if (outcomes.includes("retryable_failure")) {
        await retryActiveConversationTurnDispatch(claimed, new Error(`${admittedCandidates.length - delivered} directed recipient(s) not admitted`));
        return;
      }
      if (outcomes.includes("capability_blocked")) {
        await pauseActiveConversationTurnDispatch(claimed, new Error("directed recipient daemon lacks durable delivery admission"));
        return;
      }
      if (!await renewConversationTurnDispatchLease(claimed.id, attempt)) return;
    } else {
      let capabilityBlocked = false;
      for (const [candidateIndex, member] of admittedCandidates.entries()) {
        if (fallbackOwner) {
          await ensureReplyRecipients({
            serverId: claimed.serverId,
            channelId: claimed.channelId,
            messageId: trigger.id,
            recipients: [{ agentId: member.id, attention }],
          });
          ownerAgentId = member.id;
          if (!await activateConversationTurnDispatch(claimed.id, attempt, ownerAgentId)) return;
          activeAttempt = true;
        }
        const deliveredToCandidate = await deliverCandidate(member, candidateIndex === admittedCandidates.length - 1, false);
        if (deliveredToCandidate !== "delivered") {
          capabilityBlocked ||= deliveredToCandidate === "capability_blocked" && candidateIndex === admittedCandidates.length - 1;
          continue;
        }
        ownerAgentId ??= member.id;
        delivered++;
        if (fallbackOwner) break;
      }
      if (!delivered && capabilityBlocked) {
        await pauseActiveConversationTurnDispatch(claimed, new Error("ambient owner daemon lacks durable delivery admission"));
        return;
      }
    }

    await finishConversationTurnDispatch(claimed.id, attempt, ownerAgentId, delivered ? "delivered" : "blocked");
    log.info("conversation turn dispatched", {
      turnId: claimed.id,
      messageCount: turnMessages.length,
      senderType: claimed.senderType,
      senderId: claimed.senderId,
      ownerAgentId,
      wakeAgents: delivered,
      directAgents: mentionedOrder.length,
    });
  } catch (error) {
    if (activeAttempt) await retryActiveConversationTurnDispatch(claimed, error);
    else await retryConversationTurnDispatch(claimed, error);
  }
}

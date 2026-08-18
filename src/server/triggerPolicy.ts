// Server-enforced trigger-source policy (live 2026-08-17 design): an agent's incoming_mode
// decides whether another agent's message may reach it as a COMMAND (wake + assigned
// attention + task). Humans are always allowed. "sanitized" will route through a stateless
// disinfection gateway; until that RPC lands it fails closed like "sealed".
export type IncomingMode = "open" | "sanitized" | "sealed";

export interface TriggerPolicySubject {
  incomingMode?: string | null;
  commandWhitelist?: string[] | null;
}

/** May this sender's message act as a command/trigger for the subject agent? */
export function senderAllowedByPolicy(agent: TriggerPolicySubject, senderType: string, senderId: string): boolean {
  const mode = (agent.incomingMode ?? "open") as IncomingMode;
  if (mode === "open") return true;
  if (senderType !== "agent") return true; // humans (and system) always allowed
  return (agent.commandWhitelist ?? []).includes(senderId);
}

/** Filter a message list down to what the subject agent may see act-on-able raw.
 *  Used by message check/read so sealed agents never ingest non-whitelisted agent text. */
export function filterByTriggerPolicy<T extends { senderType: string; senderId: string | null }>(
  agent: TriggerPolicySubject,
  messages: T[],
): T[] {
  const mode = (agent.incomingMode ?? "open") as IncomingMode;
  if (mode === "open") return messages;
  return messages.filter((m) => senderAllowedByPolicy(agent, m.senderType, m.senderId ?? ""));
}

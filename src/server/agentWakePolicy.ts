export type MessageSenderType = "user" | "agent" | "system";

export function canAutoJoinMentionedMembers(senderType: MessageSenderType): boolean {
  return senderType === "user";
}

/** Pure wake criterion shared by live message delivery and reconnect catch-up.
 * DM/@ wake unconditionally. Ambient channel/thread messages wake agents with inbox scope,
 * except agent-authored ambient chatter: that path can otherwise create self-sustaining loops. */
export function isWakeable(o: { channelType: string; mentioned: boolean; hasInboxScope: boolean; senderType: MessageSenderType }): boolean {
  if (o.channelType === "dm") return true;
  if (o.mentioned) return true;
  if (o.senderType === "agent") return false;
  return o.hasInboxScope;
}

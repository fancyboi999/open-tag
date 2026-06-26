export interface ThreadMeta {
  threadChannelId: string;
  replyCount: number;
  unreadCount?: number;
}

export function nextThreadMeta(
  prev: ThreadMeta | undefined,
  event: { threadChannelId: string; replyCount: number; senderId?: string | null },
  currentUserId?: string | null,
): ThreadMeta {
  const delta = prev ? Math.max(0, event.replyCount - prev.replyCount) : 0;
  const unreadDelta = threadUnreadDelta(delta, event.senderId, currentUserId);
  return {
    threadChannelId: event.threadChannelId,
    replyCount: event.replyCount,
    unreadCount: (prev?.unreadCount ?? 0) + unreadDelta,
  };
}

export function threadUnreadDelta(delta: number, senderId?: string | null, currentUserId?: string | null): number {
  return senderId && currentUserId && senderId === currentUserId ? 0 : delta;
}

export function messageUnreadDelta(senderId?: string | null, currentUserId?: string | null, channelType?: string | null): number {
  if (channelType === "thread") return 0;
  return threadUnreadDelta(1, senderId, currentUserId);
}

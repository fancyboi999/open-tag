// Pure helpers for channel message paging (consumed by Chat.tsx). React/DOM-free so they unit-test under tsx --test.

export const PAGE_SIZE = 50; // messages fetched per page: initial channel load + each scroll-to-top "load older"
export const MSG_CAP = 400;  // max messages kept in memory while live-tailing; older ones drop (re-fetchable via the keyset cursor)

// Append a live message, capping the in-memory window. Trims only when the user is pinned to the bottom
// (live-tailing) — dropping the oldest while they're scrolled up reading history would yank content out from
// under them. A trim opens a gap at the top, so `trimmed` tells the caller to mark hasMore=true (older
// messages become re-fetchable via the `before` keyset cursor).
export function appendWithCap<T>(
  msgs: T[],
  msg: T,
  atBottom: boolean,
  cap = MSG_CAP,
): { next: T[]; trimmed: boolean } {
  const grown = [...msgs, msg];
  if (atBottom && grown.length > cap) return { next: grown.slice(grown.length - cap), trimmed: true };
  return { next: grown, trimmed: false };
}

export function nextScrollState(
  metrics: { scrollHeight: number; scrollTop: number; clientHeight: number },
  currentShowJump: boolean,
): { atBottom: boolean; showJump: boolean; changed: boolean } {
  const atBottom = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight < 120;
  const showJump = !atBottom;
  return { atBottom, showJump, changed: showJump !== currentShowJump };
}

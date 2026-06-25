// Pure query-param parsing for the channel-messages pagination route (GET /api/messages/channel/:id).
// Dependency-free (no db) so it unit-tests in isolation; routes-api/messages.ts is the only consumer.
// `before` is a keyset cursor on the globally-monotonic message `seq` (Redis INCR per server): only messages
// with seq < before are returned (the older page). A garbage/empty/non-positive cursor parses to null so the
// route falls back to the latest page instead of applying a NaN filter that would return nothing.
export function parseMsgPageParams(sp: URLSearchParams): { limit: number; before: number | null } {
  const rawLimit = Number(sp.get("limit") ?? 50);
  // any non-finite or non-positive limit → the 50 default (a 0 limit would yield an empty page with hasMore stuck true)
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(Math.floor(rawLimit), 200) : 50;
  const rawBefore = sp.get("before");
  const beforeNum = rawBefore == null ? NaN : Number(rawBefore);
  const before = Number.isFinite(beforeNum) && beforeNum > 0 ? beforeNum : null;
  return { limit, before };
}

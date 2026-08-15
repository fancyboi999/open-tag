import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("a late older read response cannot overwrite a newer badge for the same sidebar channel", async () => {
  const { acceptLatestReadResponse } = await import("../web/src/readResponse.ts");
  const applied = new Map<string, number>();
  const unread: Record<string, number> = { parent: 4, other: 3 };

  const settle = (order: number, key: string, remaining: number) => {
    if (!acceptLatestReadResponse(applied, key, order)) return;
    if (remaining > 0) unread[key] = remaining;
    else delete unread[key];
  };

  settle(3, "parent", 0); // newer response finishes first
  settle(1, "other", 1);  // an unrelated channel is not blocked by the global order
  settle(2, "parent", 2); // older response finishes last and must be ignored

  assert.deepEqual(unread, { other: 1 });
});

test("markRead accepts a response once outside the replayable state updater", () => {
  const src = fs.readFileSync(new URL("../web/src/store.tsx", import.meta.url), "utf8");
  const start = src.indexOf("const markRead =");
  const end = src.indexOf("const uploadFiles =", start);
  assert.ok(start >= 0 && end > start, "markRead implementation must exist");
  const markRead = src.slice(start, end);

  const orderAt = markRead.indexOf("const order = ++readRequestOrderRef.current");
  const ownerAt = markRead.indexOf("const ownerServerId = sidRef.current");
  const requestAt = markRead.indexOf('api("POST"');
  const outerOwnerGuardAt = markRead.indexOf("sidRef.current !== ownerServerId", requestAt);
  const responseGateAt = markRead.indexOf("acceptLatestReadResponse(appliedReadResponsesRef.current, key, order)", outerOwnerGuardAt);
  const updateAt = markRead.indexOf("setUnread((u) =>", responseGateAt);
  const innerOwnerGuardAt = markRead.indexOf("sidRef.current !== ownerServerId", updateAt);
  const badgeCommitAt = markRead.indexOf("Number(r.unread)", innerOwnerGuardAt);

  assert.ok(
    orderAt >= 0 && ownerAt >= 0 && requestAt > orderAt && requestAt > ownerAt,
    "request order and workspace ownership must be captured before the HTTP request starts",
  );
  assert.ok(
    outerOwnerGuardAt > requestAt && responseGateAt > outerOwnerGuardAt && updateAt > responseGateAt,
    "the response must belong to the current workspace and win its per-badge-key order before entering React's replayable updater",
  );
  assert.ok(
    innerOwnerGuardAt > updateAt && badgeCommitAt > innerOwnerGuardAt,
    "the state updater must recheck workspace ownership before changing the badge",
  );
});

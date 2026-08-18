import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("a late older read response cannot overwrite a newer badge for the same sidebar channel", async () => {
  const mod = await import("../web/src/readResponse.ts") as any;
  assert.equal(typeof mod.createUnreadState, "function");
  assert.equal(typeof mod.applyUnreadValue, "function");
  let state = mod.createUnreadState(1);

  state = mod.applyUnreadValue(state, { owner: 1, order: 3 }, { owner: 1, order: 4 }, "parent", 0); // newer request finishes first
  state = mod.applyUnreadValue(state, { owner: 1, order: 2 }, { owner: 1, order: 5 }, "other", 1);  // an unrelated channel is independent
  state = mod.applyUnreadValue(state, { owner: 1, order: 1 }, { owner: 1, order: 6 }, "parent", 2); // older request finishes last

  assert.deepEqual(state.values, { other: 1 });
});

test("a slow read wins whether its newer snapshot responds before or after it", async () => {
  const mod = await import("../web/src/readResponse.ts") as any;
  assert.equal(typeof mod.createUnreadState, "function");
  assert.equal(typeof mod.applyUnreadSnapshot, "function");
  assert.equal(typeof mod.applyUnreadValue, "function");
  const readRequest = { owner: 1, order: 1 };
  const snapshotRequest = { owner: 1, order: 2 };
  const readApplied = { owner: 1, order: 3 };

  let snapshotFirst = mod.createUnreadState(1);
  snapshotFirst = mod.applyUnreadSnapshot(snapshotFirst, snapshotRequest, { parent: 2 });
  snapshotFirst = mod.applyUnreadValue(snapshotFirst, readRequest, readApplied, "parent", 0);

  let readFirst = mod.createUnreadState(1);
  readFirst = mod.applyUnreadValue(readFirst, readRequest, readApplied, "parent", 0);
  readFirst = mod.applyUnreadSnapshot(readFirst, snapshotRequest, { parent: 2 });

  assert.deepEqual(snapshotFirst.values, {});
  assert.deepEqual(readFirst.values, {});
});

test("a full snapshot preserves the newest read-request order against an even later old response", async () => {
  const mod = await import("../web/src/readResponse.ts") as any;
  let state = mod.createUnreadState(1);
  const oldRead = { owner: 1, order: 1 };
  const newerRead = { owner: 1, order: 2 };

  state = mod.applyUnreadValue(state, newerRead, { owner: 1, order: 3 }, "parent", 0);
  state = mod.applyUnreadSnapshot(state, { owner: 1, order: 4 }, { parent: 5 });
  state = mod.applyUnreadValue(state, oldRead, { owner: 1, order: 5 }, "parent", 2);

  assert.deepEqual(state.values, { parent: 5 });
});

test("markRead captures its reducer token before the request and applies the result inside the state updater", () => {
  const src = fs.readFileSync(new URL("../web/src/store.tsx", import.meta.url), "utf8");
  const start = src.indexOf("const markRead =");
  const end = src.indexOf("const uploadFiles =", start);
  assert.ok(start >= 0 && end > start, "markRead implementation must exist");
  const markRead = src.slice(start, end);

  const requestTokenAt = markRead.indexOf("unreadToken()");
  const requestAt = markRead.indexOf('api("POST"');
  const keyAt = markRead.indexOf("const key = r?.channelId", requestAt);
  const appliedTokenAt = markRead.indexOf("unreadToken(", keyAt);
  const updateAt = markRead.indexOf("setUnreadState((state) =>", appliedTokenAt);
  const reducerAt = markRead.indexOf("applyUnreadValue(state,", updateAt);
  const reducerCall = markRead.slice(reducerAt, markRead.indexOf(")", reducerAt) + 1);

  assert.ok(
    requestTokenAt >= 0 && requestAt > requestTokenAt,
    "request order and activation ownership must be captured before the HTTP request starts",
  );
  assert.ok(
    keyAt > requestAt && appliedTokenAt > keyAt && updateAt > appliedTokenAt && reducerAt > updateAt,
    "response application must receive a fresh order before entering React's replayable updater",
  );
  assert.match(reducerCall, /applyUnreadValue\(state,\s*\w+,\s*\w+,\s*key,\s*Number\(r\.unread\)/,
    "the reducer must receive distinct request and response-application tokens");
});

// Unit tests for the route-boundary UUID shape check (src/server/util.ts isUuid). Client-supplied ids
// destined for uuid columns must be rejected as not-found when malformed — Postgres throws on casting a
// non-uuid (22P02) and the route surfaces a 500 (prod-observed: a reaction POSTed to the web client's
// synthetic `agent-reply:*` streaming-preview id). These lock the accept/reject edges of that boundary.
// Run: npx tsx --test --test-force-exit test/uuidRouteBoundary.unit.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isUuid } from "../src/server/util.js";

test("accepts canonical uuids in either case", () => {
  assert.equal(isUuid("6af77179-d46b-41eb-98de-b8409cd8ba61"), true);
  assert.equal(isUuid("6AF77179-D46B-41EB-98DE-B8409CD8BA61"), true);
});

test("rejects the agent-reply streaming-preview id and other malformed ids", () => {
  assert.equal(isUuid("agent-reply:6af77179-d46b-41eb-98de-b8409cd8ba61:5c3564aa-5ca6-408d-b57a-51b48189d99f"), false);
  assert.equal(isUuid(""), false);
  assert.equal(isUuid("not-a-uuid"), false);
  assert.equal(isUuid("6af77179"), false); // short id (agent-plane convention) is not a full uuid
  assert.equal(isUuid("6af77179-d46b-41eb-98de-b8409cd8ba61 "), false); // trailing junk
});

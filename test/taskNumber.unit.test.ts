// Unit tests for task-number scope-key selection (no Redis round-trip; pure key derivation).
// Run: npx tsx --test --test-force-exit test/taskNumber.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { taskNumberKey } from "../src/redis.ts";

test("non-DM channels all share the per-server counter", () => {
  assert.equal(taskNumberKey("srv1", { type: "channel", id: "c1" }), "tasknum:srv1");
  assert.equal(taskNumberKey("srv1", { type: "private", id: "c2" }), "tasknum:srv1");
  assert.equal(taskNumberKey("srv1", { type: "thread", id: "c3" }), "tasknum:srv1");
  assert.equal(taskNumberKey("srv1", null), "tasknum:srv1");
  assert.equal(taskNumberKey("srv1"), "tasknum:srv1");
});

test("a DM gets its own counter keyed by the DM channel id (independent of the workspace)", () => {
  assert.equal(taskNumberKey("srv1", { type: "dm", id: "dmA" }), "tasknum:dm:dmA");
  assert.equal(taskNumberKey("srv1", { type: "dm", id: "dmB" }), "tasknum:dm:dmB");
});

test("two DMs never share a counter, and a DM never shares the server counter", () => {
  const dmA = taskNumberKey("srv1", { type: "dm", id: "dmA" });
  const dmB = taskNumberKey("srv1", { type: "dm", id: "dmB" });
  const server = taskNumberKey("srv1", { type: "channel", id: "c1" });
  assert.notEqual(dmA, dmB);
  assert.notEqual(dmA, server);
  assert.notEqual(dmB, server);
});

// Unit tests for the Agent Live Trace ring buffer (frontend memory bound). No DB / no DOM.
// Run: npx tsx --test --test-force-exit test/trajBuffer.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { appendCapped, groupTraj, TRAJ_CAP, type TrajItem } from "../web/src/trajBuffer.ts";

const mk = (n: number, from = 0): TrajItem[] => Array.from({ length: n }, (_, i) => ({ text: `e${from + i}` }));

test("appends below cap without dropping anything", () => {
  const out = appendCapped(mk(3), mk(2, 3), 10);
  assert.equal(out.length, 5);
  assert.deepEqual(out.map((x) => x.text), ["e0", "e1", "e2", "e3", "e4"]);
});

test("drops oldest (front) when over cap, keeps newest", () => {
  const out = appendCapped(mk(8), mk(5, 8), 10); // 8 + 5 = 13 → trim to newest 10
  assert.equal(out.length, 10);
  assert.equal(out[0]!.text, "e3");  // e0..e2 dropped
  assert.equal(out[9]!.text, "e12"); // newest retained
});

test("a single batch larger than cap is itself trimmed to newest cap", () => {
  const out = appendCapped([], mk(25), 10);
  assert.equal(out.length, 10);
  assert.equal(out[0]!.text, "e15");
  assert.equal(out[9]!.text, "e24");
});

test("empty batch returns the previous array unchanged (same reference)", () => {
  const prev = mk(3);
  assert.equal(appendCapped(prev, []), prev);
});

test("stays bounded at cap under sustained appends (memory bound)", () => {
  let buf: TrajItem[] = [];
  for (let i = 0; i < 5000; i++) buf = appendCapped(buf, [{ text: `e${i}` }], 300);
  assert.equal(buf.length, 300);
  assert.equal(buf[0]!.text, "e4700");
  assert.equal(buf[299]!.text, "e4999");
});

test("default cap is 300", () => {
  assert.equal(TRAJ_CAP, 300);
  assert.equal(appendCapped([], mk(400)).length, 300);
});

// ── groupTraj: turns raw streamed fragments into message-bar-like groups (avatar + one growing block per turn) ──

test("groupTraj merges consecutive text fragments from the same agent into one running block", () => {
  const groups = groupTraj([
    { name: "codex2", text: "先看下 " },
    { name: "codex2", text: "频道，" },
    { name: "codex2", text: "确认成员。" },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.name, "codex2");
  assert.deepEqual(groups[0]!.items, [{ kind: "text", text: "先看下 频道，确认成员。" }]);
});

test("groupTraj keeps tool calls as their own pill, resuming text as a new sub-item after", () => {
  const groups = groupTraj([
    { name: "codex2", text: "先读一下消息" },
    { name: "codex2", text: "open-tag message check", tool: true },
    { name: "codex2", text: "确认没有别人 claim" },
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]!.items, [
    { kind: "text", text: "先读一下消息" },
    { kind: "tool", text: "open-tag message check" },
    { kind: "text", text: "确认没有别人 claim" },
  ]);
});

test("groupTraj starts a new group when a different agent's fragments interleave", () => {
  const groups = groupTraj([
    { name: "codex-worker", text: "我先接" },
    { name: "codex2", text: "我来补一句" },
    { name: "codex-worker", text: "分工" },
  ]);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map((g) => g.name), ["codex-worker", "codex2", "codex-worker"]);
});

test("groupTraj starts a fresh group for the same agent's next turn after a boundary marker, without rendering the marker itself", () => {
  const groups = groupTraj([
    { name: "codex2", text: "先处理任务一" },
    { name: "codex2", text: "", boundary: true },
    { name: "codex2", text: "现在处理任务二" },
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0]!.items, [{ kind: "text", text: "先处理任务一" }]);
  assert.deepEqual(groups[1]!.items, [{ kind: "text", text: "现在处理任务二" }]);
});

test("groupTraj ignores a boundary marker for an agent that has not produced any content yet", () => {
  const groups = groupTraj([{ name: "codex2", text: "", boundary: true }, { name: "codex2", text: "开始工作" }]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]!.items, [{ kind: "text", text: "开始工作" }]);
});

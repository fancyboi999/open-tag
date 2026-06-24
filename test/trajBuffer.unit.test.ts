// Unit tests for the Agent Live Trace ring buffer (frontend memory bound). No DB / no DOM.
// Run: npx tsx --test --test-force-exit test/trajBuffer.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { appendCapped, TRAJ_CAP, type TrajItem } from "../web/src/trajBuffer.ts";

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

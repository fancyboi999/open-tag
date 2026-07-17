// Unit tests for the in-memory message window cap (channel live-tailing). appendWithCap drops the oldest
// messages only when the user is pinned to the bottom — trimming while they're scrolled up reading history
// would yank content out from under them. A trim opens a gap at the top, so it must report `trimmed` so the
// caller can mark hasMore=true (older messages become re-fetchable via the keyset pagination cursor).
// Run: npx tsx --test --test-force-exit test/msgPaging.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { appendWithCap, nextScrollState } from "../web/src/lib/msgPaging.js";

test("appends below the cap without trimming", () => {
  const { next, trimmed } = appendWithCap([1, 2, 3], 4, true, 10);
  assert.deepEqual(next, [1, 2, 3, 4]);
  assert.equal(trimmed, false);
});

test("trims the oldest when over the cap and at the bottom, keeping the last `cap`", () => {
  const { next, trimmed } = appendWithCap([1, 2, 3], 4, true, 3);
  assert.deepEqual(next, [2, 3, 4]);
  assert.equal(trimmed, true);
});

test("does NOT trim when the user is scrolled up (not at bottom)", () => {
  const { next, trimmed } = appendWithCap([1, 2, 3], 4, false, 3);
  assert.deepEqual(next, [1, 2, 3, 4]);
  assert.equal(trimmed, false);
});

test("scroll state reports a UI update only when the jump-button visibility changes", () => {
  assert.deepEqual(nextScrollState({ scrollHeight: 1000, scrollTop: 700, clientHeight: 250 }, false), {
    atBottom: true,
    showJump: false,
    changed: false,
  });
  assert.deepEqual(nextScrollState({ scrollHeight: 1000, scrollTop: 500, clientHeight: 250 }, false), {
    atBottom: false,
    showJump: true,
    changed: true,
  });
  assert.deepEqual(nextScrollState({ scrollHeight: 1000, scrollTop: 450, clientHeight: 250 }, true), {
    atBottom: false,
    showJump: true,
    changed: false,
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import { animateBackToBottom, BACK_TO_BOTTOM_SCROLL_MS, keepPinnedToBottomDuringEnter, MESSAGE_ENTER_PIN_MS } from "../web/src/views/Chat.tsx";

test("back-to-bottom scrolls over 0.8s with non-linear easing", () => {
  const originalRaf = globalThis.requestAnimationFrame;
  const originalPerformance = globalThis.performance;
  const frames: FrameRequestCallback[] = [];
  let now = 0;
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; },
  });
  Object.defineProperty(globalThis, "performance", {
    configurable: true,
    value: { now: () => now },
  });

  try {
    const el = { scrollTop: 100, scrollHeight: 1100 };
    let done = false;
    animateBackToBottom(el, () => { done = true; });

    assert.equal(BACK_TO_BOTTOM_SCROLL_MS, 800);
    assert.equal(frames.length, 1);

    now = BACK_TO_BOTTOM_SCROLL_MS / 2;
    frames.shift()!(now);
    assert.ok(el.scrollTop > 600, "halfway through time should move more than a linear half because easing is non-linear");
    assert.ok(el.scrollTop < 1100, "halfway through time should not jump to the end");
    assert.equal(done, false);

    now = BACK_TO_BOTTOM_SCROLL_MS;
    frames.shift()!(now);
    assert.equal(el.scrollTop, 1100);
    assert.equal(done, true);
  } finally {
    Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: originalRaf });
    Object.defineProperty(globalThis, "performance", { configurable: true, value: originalPerformance });
  }
});

test("new message enter animation keeps an already pinned chat at the real bottom", () => {
  const originalRaf = globalThis.requestAnimationFrame;
  const originalPerformance = globalThis.performance;
  const frames: FrameRequestCallback[] = [];
  let now = 0;
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; },
  });
  Object.defineProperty(globalThis, "performance", {
    configurable: true,
    value: { now: () => now },
  });

  try {
    let pinned = true;
    const el = { scrollTop: 1000, scrollHeight: 1100 };
    keepPinnedToBottomDuringEnter(el, () => pinned);

    assert.equal(MESSAGE_ENTER_PIN_MS, 1000);
    assert.equal(el.scrollTop, 1100);
    assert.equal(frames.length, 1);

    el.scrollHeight = 1240;
    now = 120;
    frames.shift()!(now);
    assert.equal(el.scrollTop, 1240, "the viewport should track the expanding message height");
    assert.equal(frames.length, 1);

    pinned = false;
    el.scrollHeight = 1320;
    now = 240;
    frames.shift()!(now);
    assert.equal(el.scrollTop, 1240, "manual scroll-away should stop forced bottom pinning");
  } finally {
    Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: originalRaf });
    Object.defineProperty(globalThis, "performance", { configurable: true, value: originalPerformance });
  }
});

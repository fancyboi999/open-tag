// Unit regression for the Showcase open-case hover highlight.
// Run: npx tsx --test --test-force-exit test/showcaseOpenHoverHighlight.unit.test.ts
//
// Bug: a Showcase case whose thread is open (.showcase-case.open) gets a surface-strong fill + an
// inset accent bar. It reuses Chat's .msg, whose :hover paints an opaque, LIGHTER (canvas-soft)
// rounded block — on the open case's darker fill that reads as a reversed, half-height highlight AND,
// being opaque, clips the inset accent bar to a stray segment above the avatar ("hover makes half the
// message vanish" + "blue bar under the avatar"). Fix: inside an open case, suppress the per-message
// hover fill so the fill stays uniform and the accent bar runs full-height. Must stay SCOPED — the
// global .msg:hover (real Chat channels) must be untouched.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const css = fs.readFileSync(new URL("../web/src/styles.css", import.meta.url), "utf8");

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(m, `missing CSS rule for ${selector}`);
  return m[1]!;
}

test("open Showcase case clears the per-message hover fill (no reversed half-height block; accent bar stays full-height)", () => {
  const body = ruleBody(".showcase-case.open .msg:hover");
  assert.match(body, /background\s*:\s*transparent\b/, `open-case hover must clear the .msg fill, got: ${body}`);
});

test("global .msg:hover (real Chat channels) is untouched — still the canvas-soft hover block", () => {
  const body = ruleBody(".msg:hover");
  assert.match(body, /background\s*:\s*var\(--canvas-soft\)/, `global .msg:hover must keep its hover block, got: ${body}`);
});

test("the open case still carries the fill + accent bar the hover fix relies on", () => {
  const body = ruleBody(".showcase-case.open");
  assert.match(body, /background\s*:\s*var\(--surface-strong\)/, `open case lost its fill: ${body}`);
  assert.match(body, /box-shadow\s*:\s*inset\s+3px\s+0\s+0\s+var\(--g-sky\)/, `open case lost its accent bar: ${body}`);
});

test("open case is a contained card — content indents off the accent bar (avatar not flush on the bar)", () => {
  const body = ruleBody(".showcase-case.open .msg");
  // drop the reused negative side-margins (Chat's .msg uses 0 -12px) so content sits inside the card…
  assert.match(body, /margin\s*:\s*0\s+0\s+6px/, `open-case .msg must drop its negative side-margins: ${body}`);
  // …and indent past the 3px inset accent bar so the avatar clears it instead of sitting flush.
  assert.match(body, /padding-left\s*:\s*18px/, `open-case content must indent off the accent bar: ${body}`);
});

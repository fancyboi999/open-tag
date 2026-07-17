// Unit regression for the Showcase open-case hover highlight.
// Run: npx tsx --test --test-force-exit test/showcaseOpenHoverHighlight.unit.test.ts
//
// Bug: a Showcase case whose thread is open (.showcase-case.open) gets a surface-strong fill + an
// inset accent bar. Chat message hover now uses a transparent background plus a subtle hairline/shadow
// instead of an opaque fill. Showcase open cases must keep the same transparent hover contract so the
// open-case fill stays uniform and the accent bar runs full-height.
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

test("global .msg:hover (real Chat channels) uses the readable border-only hover contract", () => {
  const body = ruleBody(".msg:hover");
  assert.match(body, /background\s*:\s*transparent\b/, `global .msg:hover must not dim message contents, got: ${body}`);
  assert.match(body, /box-shadow\s*:\s*inset 0 0 0 \.5px rgba\(87,96,106,\.18\),0 6px 18px rgba\(15,23,42,\.035\)/, `global .msg:hover should expose only a quiet full-message border and shadow, got: ${body}`);
  assert.equal(ruleBody(".msg-col"), "min-width:0;padding:0", "message body column should not carry a nested card skin");
});

test("the open case still carries the fill + accent bar the hover fix relies on", () => {
  const body = ruleBody(".showcase-case.open");
  assert.match(body, /background\s*:\s*var\(--surface-strong\)/, `open case lost its fill: ${body}`);
  assert.match(body, /box-shadow\s*:\s*inset\s+3px\s+0\s+0\s+var\(--g-sky\)/, `open case lost its accent bar: ${body}`);
});

test("open case is a contained card — content indents off the accent bar (avatar not flush on the bar)", () => {
  const body = ruleBody(".showcase-case.open .msg");
  // keep the reused message row contained so content sits inside the case card…
  assert.match(body, /margin\s*:\s*0\s+0\s+6px/, `open-case .msg must drop its negative side-margins: ${body}`);
  // …and indent past the 3px inset accent bar so the avatar clears it instead of sitting flush.
  assert.match(body, /padding-left\s*:\s*18px/, `open-case content must indent off the accent bar: ${body}`);
});

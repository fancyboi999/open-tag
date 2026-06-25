// Unit regression for the workspace-switcher "create workspace" row layout.
// Run: npx tsx --test --test-force-exit test/swCreateOverflow.unit.test.ts
//
// The switcher popover (.sw-pop) is a fixed 230px-wide box. The create row (.sw-create) is a
// flex row holding a text <input> (flex:1) + a "Create" button (.sw-go). A flex <input> defaults
// to min-width:auto, whose intrinsic min size (driven by the input's `size` attr) is wider than
// the available track — so flex:1 can't shrink it and the row overflows the popover's right edge.
// Pinning the input to min-width:0 lets flex:1 actually shrink it to fit the container.
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

function assertDecl(body: string, prop: string, value: string): void {
  assert.match(body, new RegExp(`${prop}\\s*:\\s*${value}(?:;|$)`), `expected ${prop}:${value} in:\n${body}`);
}

test("workspace-switcher create row keeps its input shrinkable so it never overflows the popover", () => {
  const row = ruleBody(".sw-create");
  assertDecl(row, "display", "flex");

  const input = ruleBody(".sw-create input");
  assertDecl(input, "flex", "1");
  // The fix: without min-width:0 the flex input refuses to shrink below its intrinsic size and
  // pushes the Create button past .sw-pop's right edge.
  assertDecl(input, "min-width", "0");
});

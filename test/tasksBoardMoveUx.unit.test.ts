// Unit regression for the Tasks board move-interaction overhaul (PR: board-move-ux).
// Run: npx tsx --test --test-force-exit test/tasksBoardMoveUx.unit.test.ts
//
// Three CSS contracts make the drag/click-to-move interaction good:
//  1. the WHOLE column is a drop target — a `.task-col-body` grows to a generous min-height while a drag
//     is in flight (`.task-board.dragging`), so you no longer have to hit the thin title strip;
//  2. the drop indicator is a `.drop-slot` appended AFTER the cards (never the old `.drop-hint` banner that
//     overlapped the dragged card);
//  3. cards animate between columns via a `.tk-slot` transition, with a prefers-reduced-motion off-switch.
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

test("columns are full-height lanes that fill the pane, so the whole column is a drop target", () => {
  // the tasks pane is a flex column; the board fills the height left under the toolbar
  assertDecl(ruleBody(".board-scroll"), "display", "flex");
  assertDecl(ruleBody(".board-scroll"), "flex-direction", "column");
  assertDecl(ruleBody(".task-board.columns"), "flex", "1 1 auto");      // board fills the pane
  assertDecl(ruleBody(".task-board.columns"), "align-items", "stretch"); // every column spans the full height
  assertDecl(ruleBody(".task-col-body"), "flex", "1 1 auto");            // body fills the lane → whole column is droppable
  assertDecl(ruleBody(".task-col-body"), "overflow-y", "auto");          // cards scroll inside the lane when they overflow
  // stack layout: full-width columns get a generous body target while dragging
  assertDecl(ruleBody(".task-board.stack.dragging .task-col-body"), "min-height", "96px");
});

test("drop indicator is an appended slot, not the old overlapping banner", () => {
  const slot = ruleBody(".drop-slot");
  assertDecl(slot, "min-height", "62px");
  assertDecl(slot, "border-radius", "12px"); // on the DESIGN.md radius scale
  assert.ok(!/\.drop-hint\b/.test(css), "the old .drop-hint banner (overlapped the dragged card) must be gone");
});

test("cards animate between columns, with a reduced-motion off-switch", () => {
  assert.match(ruleBody(".tk-slot"), /transition\s*:\s*transform/, "the FLIP slot must transition transform");
  assert.match(css, /prefers-reduced-motion:\s*reduce\)\s*\{\s*\.tk-slot\s*\{\s*transition:\s*none/, "reduced-motion must disable the slot transition");
});

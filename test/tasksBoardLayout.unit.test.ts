// Unit regression for the Tasks board layout toggle (horizontal columns ↔ vertical stack).
// Run: npx tsx --test --test-force-exit test/tasksBoardLayout.unit.test.ts
//
// The Board view can render its five status columns either as a horizontal Kanban
// (.task-board.columns — flex row, min-width columns, horizontal scroll on overflow so
// the narrow embedded channel tasks tab degrades gracefully) or as the legacy vertical
// stack (.task-board.stack — block flow, each column full-width). These CSS rules are
// what make the toggle work; assert them so the layout can't silently regress.
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

test("horizontal Kanban lays the columns out in a scrollable flex row", () => {
  const cols = ruleBody(".task-board.columns");
  assertDecl(cols, "display", "flex");
  assertDecl(cols, "overflow-x", "auto");

  const colInCols = ruleBody(".task-board.columns .task-col");
  // fixed-basis columns with a min-width so they stay readable and overflow into a
  // horizontal scroll instead of squashing in the narrow embedded panel
  assertDecl(colInCols, "flex", "0 0 300px");
  assertDecl(colInCols, "min-width", "280px");
  assertDecl(colInCols, "margin-bottom", "0");
  // every lane is a soft surface container, so columns read as distinct containers (collapsed ones too —
  // they keep the same width/height and just hide their cards)
  assertDecl(colInCols, "background", "var\\(--surface-strong\\)");
});

test("vertical stack keeps the legacy block-flow spacing", () => {
  const colInStack = ruleBody(".task-board.stack .task-col");
  assertDecl(colInStack, "margin-bottom", "20px");
});

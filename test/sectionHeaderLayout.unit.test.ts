// Unit regression for section-header (.sec) layout + centered content-pane empty states.
// Run: npx tsx --test --test-force-exit test/sectionHeaderLayout.unit.test.ts
//
// A section header (.sec) holds a label, an optional count (.cnt) and an optional add button (.addbtn).
// The count counts what the label names, so it must hug its label; only the add affordance floats to the
// right edge. The previous `justify-content:space-between` flung a lone count to the far edge of wide
// panes and — when both a count and a button were present (the Machines header) — stranded the count in
// the dead centre between label and button. See web/src/views/misc.tsx (Computers) + Members roster.
//
// Content-pane empty states (.pane-empty) must centre their message rather than pin a small grey line to
// the top-left of an otherwise blank pane (the Inbox "No messages" complaint).
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

test("section header lays out as a flex row whose count hugs the label (no space-between)", () => {
  const sec = ruleBody(".sec");
  assertDecl(sec, "display", "flex");
  assertDecl(sec, "align-items", "center");
  assertDecl(sec, "gap", "\\d+px");
  // The bug: space-between detaches the count from its label — flush-right in wide panes, and stranded
  // in the centre once an add button follows it.
  assert.doesNotMatch(
    sec,
    /justify-content\s*:\s*space-between/,
    "`.sec` must not use justify-content:space-between; the count must hug its label",
  );
});

test("only the add affordance floats to the right edge of a section header", () => {
  const addbtn = ruleBody(".sec .addbtn");
  assertDecl(addbtn, "margin-left", "auto");
});

test("content-pane empty states centre their message instead of pinning it top-left", () => {
  const paneEmpty = ruleBody(".pane-empty");
  assertDecl(paneEmpty, "display", "flex");
  assertDecl(paneEmpty, "align-items", "center");
  assertDecl(paneEmpty, "justify-content", "center");
});

test("inline empty-state body text clears WCAG AA (uses --muted, not the sub-AA --muted-soft)", () => {
  // --muted-soft (#a8a29e) is the design's tertiary/disabled tier (~2.4:1 on the off-white canvas) — fine
  // for metadata, but it fails AA when carrying readable content. Empty-state messages are content.
  for (const sel of [".empty", ".sel-empty", ".msg-sys"]) {
    const body = ruleBody(sel);
    assertDecl(body, "color", "var\\(--muted\\)");
    assert.doesNotMatch(body, /var\(--muted-soft\)/, `${sel} carries readable text and must not use --muted-soft`);
  }
});

test("modal entry animation does not retain a transform after it finishes", () => {
  const modal = ruleBody(".modal,.qs");
  assert.doesNotMatch(
    modal,
    /animation\s*:[^;]*(?:\bboth\b|\bforwards\b)/,
    "modal animations must not keep fill-mode:both/forwards; retained identity transforms can break fixed-position overlays and menus",
  );
});

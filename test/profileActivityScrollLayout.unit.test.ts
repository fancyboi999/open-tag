// Unit regression for embedded agent profile layout.
// Run: npx tsx --test --test-force-exit test/profileActivityScrollLayout.unit.test.ts
//
// The chat right-column profile panel hosts AgentProfile(Activity). The visible activity history
// must scroll inside the tab body, not on the outer aside; otherwise opening the panel starts at
// the profile header and ActivityTab's auto-scroll writes to a non-scrolling inner node.
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

test("embedded profile panel keeps the outer aside fixed and scrolls only the active tab body", () => {
  const profileMode = ruleBody("aside.traj-col.profile-mode");
  assertDecl(profileMode, "display", "flex");
  assertDecl(profileMode, "flex-direction", "column");
  assertDecl(profileMode, "overflow", "hidden");

  const profileBody = ruleBody("aside.traj-col.profile-mode .scroll");
  assertDecl(profileBody, "flex", "1");
  assertDecl(profileBody, "min-height", "0");
  assertDecl(profileBody, "overflow", "auto");
});

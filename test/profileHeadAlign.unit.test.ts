// Unit regression: the profile header (agent + human) must align avatar, name and action
// buttons on one centered row. The .head base rule sets align-items:baseline (correct for plain
// section headers), so the .head.head-agent variant must override it with a higher-specificity
// compound selector — otherwise .head (later in the file) wins and the row falls back to baseline.
// The name block (.head-id) must grow so the actions sit flush-right instead of the name floating
// to the middle (the centered-name symptom in the bug report).
// Run: npx tsx --test --test-force-exit test/profileHeadAlign.unit.test.ts
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

test(".head base header is baseline-aligned (plain section headers)", () => {
  assertDecl(ruleBody(".head"), "align-items", "baseline");
});

test(".head.head-agent variant centers the row and outranks .head", () => {
  const variant = ruleBody(".head.head-agent");
  assertDecl(variant, "align-items", "center");
});

test(".head-id name block grows so actions stay flush-right", () => {
  assertDecl(ruleBody(".head-id"), "flex", "1 1 auto");
});

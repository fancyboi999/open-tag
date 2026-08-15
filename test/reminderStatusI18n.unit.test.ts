// Unit regression for reminder status badges freezing in the language active at module load.
// Run: npx tsx --test --test-force-exit test/reminderStatusI18n.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import i18n from "../web/src/i18n.ts";

const membersSrc = fs.readFileSync(new URL("../web/src/views/Members.tsx", import.meta.url), "utf8");
const statusMap = /const REM_STATUS:[\s\S]*?\n};/.exec(membersSrc)?.[0] ?? "";

test("reminder status badges translate at render time after a language switch", async () => {
  assert.doesNotMatch(statusMap, /i18n\.t\(/);
  assert.match(statusMap, /scheduled:\s*["']members\.remScheduled["']/);
  assert.match(statusMap, /fired:\s*["']members\.remFired["']/);
  assert.match(statusMap, /cancelled:\s*["']members\.remCancelled["']/);
  assert.match(membersSrc, /REM_STATUS\[r\.status\]\s*\?\s*t\(REM_STATUS\[r\.status\]\)\s*:\s*r\.status/);

  const previous = i18n.language;
  try {
    await i18n.changeLanguage("en");
    assert.equal(i18n.t("members.remScheduled"), "Scheduled");
    await i18n.changeLanguage("zh");
    assert.equal(i18n.t("members.remScheduled"), "待触发");
  } finally {
    await i18n.changeLanguage(previous);
  }
});

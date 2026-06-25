// Unit: date-time formatter shows the full calendar date (year/month/day) + time, not time-of-day only.
// fmtTime (store.tsx) is intentionally time-only and used for message/reminder timestamps; member
// join time and agent creation date need the calendar date too — hence a separate fmtDateTime.
// Run: npx tsx --test --test-force-exit test/format.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { fmtDateTime } from "../web/src/format.ts";

test("fmtDateTime renders year-month-day and time, not a bare time-of-day", () => {
  const out = fmtDateTime("2026-06-25T14:30:00Z");
  assert.match(out, /2026/, `expected calendar year in: ${out}`);
  assert.match(out, /\d{1,2}:\d{2}/, `expected HH:MM in: ${out}`);
  assert.ok(out.length > "14:30:00".length, `expected date+time, got: ${out}`);
});

test("fmtDateTime is empty for missing/invalid input", () => {
  assert.equal(fmtDateTime(undefined), "");
  assert.equal(fmtDateTime(""), "");
});

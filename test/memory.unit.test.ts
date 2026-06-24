// Unit tests for the MEMORY.md profile-sync surgery (no DB / no disk).
// Run: npx tsx --test --test-force-exit test/memory.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { seedMemory, applyProfileToMemory } from "../src/daemon/memory.ts";

test("seedMemory lays out title / Role / Key Knowledge / Active Context", () => {
  assert.equal(
    seedMemory("Ada", "local helper"),
    "# Ada\n\n## Role\nlocal helper\n\n## Key Knowledge\n- None yet\n\n## Active Context\n- First startup\n",
  );
});

test("seedMemory falls back to Undefined for empty/whitespace description", () => {
  assert.match(seedMemory("Ada", ""), /## Role\nUndefined\n/);
  assert.match(seedMemory("Ada", "   "), /## Role\nUndefined\n/);
  assert.match(seedMemory("Ada", null), /## Role\nUndefined\n/);
});

test("applyProfileToMemory rewrites title + Role, preserves the agent's other sections", () => {
  const before = seedMemory("old name", "old role")
    .replace("- None yet", "- notes/users.md — preferences")
    .replace("- First startup", "- mid-refactor of the API layer");
  const after = applyProfileToMemory(before, "claudecode", "全栈资深工程师，精益求精");
  assert.match(after, /^# claudecode\n/);
  assert.match(after, /## Role\n全栈资深工程师，精益求精\n/);
  // agent-owned content survives untouched
  assert.match(after, /## Key Knowledge\n- notes\/users\.md — preferences/);
  assert.match(after, /## Active Context\n- mid-refactor of the API layer/);
  assert.doesNotMatch(after, /old name|old role/);
});

test("applyProfileToMemory is a no-op when title + role already match", () => {
  const doc = seedMemory("Ada", "local helper").replace("- None yet", "- notes/x.md");
  assert.equal(applyProfileToMemory(doc, "Ada", "local helper"), doc);
});

test("applyProfileToMemory handles a multi-line description", () => {
  const before = seedMemory("Ada", "one-liner");
  const after = applyProfileToMemory(before, "Ada", "line 1\nline 2\nline 3");
  assert.match(after, /## Role\nline 1\nline 2\nline 3\n\n## Key Knowledge/);
});

test("applyProfileToMemory empty description becomes Undefined", () => {
  const after = applyProfileToMemory(seedMemory("Ada", "x"), "Ada", "   ");
  assert.match(after, /## Role\nUndefined\n\n## Key Knowledge/);
});

test("applyProfileToMemory handles Role as the last section (no trailing heading)", () => {
  const before = "# Ada\n\n## Role\nold\n";
  const after = applyProfileToMemory(before, "Bob", "new role");
  assert.equal(after, "# Bob\n\n## Role\nnew role");
});

test("applyProfileToMemory reinstates a Role heading the agent removed", () => {
  const before = "# Ada\n\n## Key Knowledge\n- notes/x.md\n";
  const after = applyProfileToMemory(before, "Ada", "reassigned");
  assert.match(after, /^# Ada\n\n## Role\nreassigned\n/);
  assert.match(after, /## Key Knowledge\n- notes\/x\.md/);
});

test("applyProfileToMemory prepends a header when there is no H1 at all", () => {
  const before = "## Key Knowledge\n- notes/x.md\n";
  const after = applyProfileToMemory(before, "Ada", "role");
  assert.match(after, /^# Ada\n\n## Role\nrole\n/);
  assert.match(after, /## Key Knowledge\n- notes\/x\.md/);
});

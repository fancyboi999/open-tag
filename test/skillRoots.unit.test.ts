// Unit: skills directory resolution is per-runtime (ported from multica's localSkillRootsForProvider,
// multica/server/internal/daemon/local_skills.go). A codex/opencode/cursor agent must read its own
// provider skills dir, not Claude's ~/.claude/skills (the previous hardcoded behavior). Agents run
// with the operator's real $HOME, so the home provider dir is the one the agent actually loads.
// Run: npx tsx --test --test-force-exit test/skillRoots.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { skillRootsFor } from "../src/daemon/workspace.ts";

// Resolved dirs use the platform separator; normalize so suffix checks hold on Windows too.
const posix = (s: string) => s.replaceAll("\\", "/");

test("claude resolves ~/.claude/skills (default, unchanged behavior)", () => {
  const r = skillRootsFor("claude", "agent-1");
  assert.ok(r.global.some((g) => posix(g.dir).endsWith("/.claude/skills")), JSON.stringify(r.global));
});

test("codex resolves ~/.codex/skills and not Claude's dir", () => {
  const r = skillRootsFor("codex", "agent-1");
  assert.ok(r.global.some((g) => posix(g.dir).endsWith("/.codex/skills")), JSON.stringify(r.global));
  assert.ok(!r.global.some((g) => posix(g.dir).endsWith("/.claude/skills")), "codex must not read ~/.claude/skills");
});

test("opencode/cursor/pi resolve their own nested provider dirs", () => {
  assert.ok(skillRootsFor("opencode", "a").global.some((g) => posix(g.dir).endsWith("/.config/opencode/skills")));
  assert.ok(skillRootsFor("cursor", "a").global.some((g) => posix(g.dir).endsWith("/.cursor/skills")));
  assert.ok(skillRootsFor("pi", "a").global.some((g) => posix(g.dir).endsWith("/.pi/agent/skills")));
});

test("every runtime also includes the universal ~/.agents/skills convention", () => {
  for (const rt of ["claude", "codex", "opencode", "cursor", "pi", "copilot", "kimi"]) {
    assert.ok(skillRootsFor(rt, "a").global.some((g) => posix(g.dir).endsWith("/.agents/skills")), rt);
  }
});

test("kimi/unknown runtime falls back to the universal dir only (no invented provider dir)", () => {
  assert.deepEqual(skillRootsFor("kimi", "a").global.map((g) => g.label), ["~/.agents/skills"]);
  assert.deepEqual(skillRootsFor("totally-unknown", "a").global.map((g) => g.label), ["~/.agents/skills"]);
});

test("workspace root mirrors the runtime's project-local provider dir", () => {
  assert.ok(posix(skillRootsFor("claude", "agent-1").workspace?.dir ?? "").endsWith("agent-1/.claude/skills"));
  assert.ok(posix(skillRootsFor("codex", "agent-1").workspace?.dir ?? "").endsWith("agent-1/.codex/skills"));
  assert.equal(skillRootsFor("kimi", "agent-1").workspace, null);
});

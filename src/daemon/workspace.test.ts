import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = mkdtempSync(join(tmpdir(), "ws-test-"));
process.env.OPEN_TAG_HOME = join(tmp, "open-tag");
const DATA_DIR = join(tmp, "open-tag", "agents");
const AGENT_ID = "test-agent-1";

// Reset env and create fresh agent dir
mkdirSync(join(DATA_DIR, AGENT_ID, ".claude", "skills", "existing-skill"), { recursive: true });
writeFileSync(join(DATA_DIR, AGENT_ID, ".claude", "skills", "existing-skill", "SKILL.md"), `---
name: existing-skill
description: A test skill
userInvocable: true
---
# Test Skill

This is a test skill.
`);

// Import AFTER setting env
const { writeWorkspaceFile, readWorkspaceFile, deleteWorkspaceFile, listSkills, skillRootsFor } = await import("./workspace.js");

test("writeWorkspaceFile creates file and parent dirs", async () => {
  const r = await writeWorkspaceFile(AGENT_ID, "personality.md", "# My Personality\n\nI am a test agent.");
  assert.equal(r.error, undefined);
  assert.ok(existsSync(join(DATA_DIR, AGENT_ID, "personality.md")));
  assert.equal(readFileSync(join(DATA_DIR, AGENT_ID, "personality.md"), "utf8"), "# My Personality\n\nI am a test agent.");
});

test("readWorkspaceFile reads file back", async () => {
  const r = await readWorkspaceFile(AGENT_ID, "personality.md");
  assert.equal(r.error, undefined);
  assert.equal(r.content, "# My Personality\n\nI am a test agent.");
});

test("writeWorkspaceFile writes SKILL.md to skills dir", async () => {
  const r = await writeWorkspaceFile(AGENT_ID, ".claude/skills/my-skill/SKILL.md", `---
name: my-skill
description: User uploaded skill
userInvocable: true
---
# My Skill

Uploaded via web UI.
`);
  assert.equal(r.error, undefined);
  assert.ok(existsSync(join(DATA_DIR, AGENT_ID, ".claude", "skills", "my-skill", "SKILL.md")));
});

test("listSkills includes newly written workspace skill", async () => {
  const s = await listSkills(AGENT_ID, "claude");
  assert.ok(Array.isArray(s.workspace));
  assert.ok(s.workspace.some((sk: any) => sk.name === "my-skill"), "should find my-skill in workspace");
  assert.ok(s.workspace.some((sk: any) => sk.name === "existing-skill"), "should find existing-skill in workspace");
});

test("listSkills returns global+workspace for known runtime", async () => {
  const s = await listSkills(AGENT_ID, "claude");
  assert.ok(Array.isArray(s.global));
  assert.ok(Array.isArray(s.workspace));
});

test("deleteWorkspaceFile removes SKILL.md", async () => {
  const r = await deleteWorkspaceFile(AGENT_ID, ".claude/skills/my-skill/SKILL.md");
  assert.equal(r.error, undefined);
  assert.ok(!existsSync(join(DATA_DIR, AGENT_ID, ".claude", "skills", "my-skill", "SKILL.md")));
});

test("listSkills no longer includes deleted skill", async () => {
  const s = await listSkills(AGENT_ID, "claude");
  assert.ok(!s.workspace.some((sk: any) => sk.name === "my-skill"), "should not find deleted my-skill");
});

test("deleteWorkspaceFile removes personality.md", async () => {
  const r = await deleteWorkspaceFile(AGENT_ID, "personality.md");
  assert.equal(r.error, undefined);
  assert.ok(!existsSync(join(DATA_DIR, AGENT_ID, "personality.md")));
});

test("deleteWorkspaceFile returns error for nonexistent file", async () => {
  const r = await deleteWorkspaceFile(AGENT_ID, "nonexistent.md");
  assert.ok(r.error, "should return an error for missing file");
});

test("writeWorkspaceFile rejects path traversal", async () => {
  const r = await writeWorkspaceFile(AGENT_ID, "../../etc/passwd", "hack");
  assert.equal(r.error, "invalid path");
});

test("skillRootsFor returns workspace path for known runtime", () => {
  const roots = skillRootsFor("claude", AGENT_ID);
  assert.ok(roots.workspace);
  assert.ok(roots.workspace.dir.includes(AGENT_ID));
  assert.ok(roots.workspace.dir.includes(".claude"));
  assert.ok(roots.workspace.dir.includes("skills"));
});

test("skillRootsFor returns no workspace for unknown runtime", () => {
  const roots = skillRootsFor("unknown-runtime", AGENT_ID);
  assert.equal(roots.workspace, null);
});

test("skillRootsFor includes global paths for known runtime", () => {
  const roots = skillRootsFor("codex", AGENT_ID);
  assert.ok(roots.global.length >= 2); // home + universal
  assert.ok(roots.global.some((r) => r.label.includes(".codex")));
  assert.ok(roots.global.some((r) => r.label.includes(".agents")));
});

test("readWorkspaceFile returns error for invalid path", async () => {
  const r = await readWorkspaceFile(AGENT_ID, "../../../etc/passwd");
  assert.ok(r.error);
});

test("readWorkspaceFile returns error for directory", async () => {
  const r = await readWorkspaceFile(AGENT_ID, ".claude");
  assert.ok(r.error);
});

test("auto-generated frontmatter is parsed correctly by readSkillsDir", async () => {
  // Create agent dir for this test only
  mkdirSync(join(DATA_DIR, AGENT_ID, ".claude", "skills", "auto-skill"), { recursive: true });
  // Simulate what the frontend does: raw file without frontmatter → prepend frontmatter
  const raw = "# My Auto Skill\n\nThis has no frontmatter in the original file.";
  const name = "auto-skill";
  const content = raw.match(/^---\s*\n/) ? raw : `---\nname: ${name}\nuserInvocable: true\n---\n\n${raw}`;
  writeFileSync(join(DATA_DIR, AGENT_ID, ".claude", "skills", "auto-skill", "SKILL.md"), content);

  const s = await listSkills(AGENT_ID, "claude");
  const skill = s.workspace.find((sk: any) => sk.name === "auto-skill");
  assert.ok(skill, "auto-skill should be found");
  assert.equal(skill.name, "auto-skill");
  assert.equal(skill.userInvocable, true);
});

after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

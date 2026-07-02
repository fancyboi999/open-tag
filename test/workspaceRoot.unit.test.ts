// listWorkspace returns the real on-disk workspace root, so the web UI can show the path
// truthfully instead of a hardcoded `~/.open-tag/agents/<id>` template that's wrong whenever
// OPEN_TAG_HOME is non-default (worktree isolation, custom data dir).
// Run: npx tsx --test --test-force-exit test/workspaceRoot.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

// MUST be set before importing workspace.ts — DATA_DIR = agentsDir() is computed at module load.
const HOME = mkdtempSync(path.join(tmpdir(), "ot-ws-root-"));
process.env.OPEN_TAG_HOME = HOME;

const { listWorkspace } = await import("../src/daemon/workspace.ts");

test("listWorkspace returns the absolute workspace root + the file tree", async () => {
  const agentId = "11111111-1111-4111-8111-111111111111";
  const agentDir = path.join(HOME, "agents", agentId);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(path.join(agentDir, "MEMORY.md"), "# test");

  const r = await listWorkspace(agentId);

  assert.equal(r.root, agentDir);
  assert.ok(r.files!.some((f) => f.name === "MEMORY.md"), "file tree includes MEMORY.md");
});

test("listWorkspace returns root even when the agent dir is missing — root is a pure path, no disk IO", async () => {
  const agentId = "22222222-2222-4222-8222-222222222222";
  const r = await listWorkspace(agentId);

  assert.equal(r.root, path.join(HOME, "agents", agentId));
  assert.ok(!r.error, "missing dir → empty tree, not an error (walk tolerates readdir failure)");
});

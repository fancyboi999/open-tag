// Unit tests for OPEN_TAG_HOME path resolution (no DB / no disk).
// Run: npx tsx --test --test-force-exit test/paths.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import * as p from "../src/paths.ts";

test("defaults to ~/.open-tag when OPEN_TAG_HOME is unset", () => {
  delete process.env.OPEN_TAG_HOME;
  delete process.env.OPEN_TAG_LOG_DIR;
  delete process.env.OPEN_TAG_UPLOAD_DIR;
  const home = path.join(os.homedir(), ".open-tag");
  assert.equal(p.openTagHome(), home);
  assert.equal(p.agentsDir(), path.join(home, "agents"));
  assert.equal(p.binDir(), path.join(home, "bin"));
  assert.equal(p.machineIdFile(), path.join(home, "machine-id"));
  assert.equal(p.logsDir(), path.join(home, "logs"));
  assert.equal(p.uploadsDir(), path.join(home, "uploads"));
});

test("OPEN_TAG_HOME relocates every derived dir", () => {
  process.env.OPEN_TAG_HOME = "/tmp/ot-wtX";
  delete process.env.OPEN_TAG_LOG_DIR;
  delete process.env.OPEN_TAG_UPLOAD_DIR;
  // path.join normalizes separators, so these expectations hold on Windows too
  assert.equal(p.agentsDir(), path.join("/tmp/ot-wtX", "agents"));
  assert.equal(p.binDir(), path.join("/tmp/ot-wtX", "bin"));
  assert.equal(p.machineIdFile(), path.join("/tmp/ot-wtX", "machine-id"));
  assert.equal(p.logsDir(), path.join("/tmp/ot-wtX", "logs"));
  assert.equal(p.uploadsDir(), path.join("/tmp/ot-wtX", "uploads"));
});

test("legacy OPEN_TAG_LOG_DIR / OPEN_TAG_UPLOAD_DIR still win", () => {
  process.env.OPEN_TAG_HOME = "/tmp/ot-wtX";
  process.env.OPEN_TAG_LOG_DIR = "/var/log/ot";
  process.env.OPEN_TAG_UPLOAD_DIR = "/var/up/ot";
  assert.equal(p.logsDir(), "/var/log/ot");
  assert.equal(p.uploadsDir(), "/var/up/ot");
});

// Regression for #163: a missing Codex binary must not crash the daemon process.
// Run: npx tsx --test src/daemon/codexRuntime.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { codexRuntime } from "./codexRuntime.js";

test("missing codex binary reports offline instead of crashing daemon", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-codex-missing-"));
  const events: { activity: string; detail?: string }[] = [];
  let exitCode: number | null | undefined;

  try {
    const session = codexRuntime.start({
      cwd: root,
      env: { PATH: root },
      systemPrompt: "system",
      initialPrompt: "start",
    }, {
      onSession: () => {},
      onActivity: (activity, detail) => events.push({ activity, detail }),
      onTrajectory: () => {},
      onExit: (code) => { exitCode = code; },
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    session.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  assert.equal(exitCode, 1);
  assert.ok(
    events.some((e) => e.activity === "offline" && /codex not found/.test(e.detail ?? "")),
    "expected a visible offline activity for missing codex",
  );
});

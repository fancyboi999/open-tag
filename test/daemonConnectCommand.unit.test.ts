// Run: npx tsx --test --test-force-exit test/daemonConnectCommand.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { daemonConnectCommand } from "../web/src/machineUi.ts";

test("daemonConnectCommand embeds origin and key", () => {
  const cmd = daemonConnectCommand("https://x.test", "sk_machine_abc");
  assert.equal(cmd, "npx @fancyboi999/open-tag-daemon@latest --server-url https://x.test --api-key sk_machine_abc");
});

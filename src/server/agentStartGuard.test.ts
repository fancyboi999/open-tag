// Unit regression for #163: server must not start an agent on a machine that did not advertise its runtime.
// Run: npx tsx --test src/server/agentStartGuard.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentStartBlockReason } from "./agentStartGuard.js";

test("blocks start when selected machine lacks the requested runtime", () => {
  const reason = agentStartBlockReason(
    { machineId: "m1", runtime: "codex" },
    { id: "m1", status: "online", runtimes: ["claude"] },
    true,
  );

  assert.equal(reason, "runtime codex unavailable on selected machine");
});

test("allows start when selected machine is online and reports requested runtime", () => {
  const reason = agentStartBlockReason(
    { machineId: "m1", runtime: "codex" },
    { id: "m1", status: "online", runtimes: ["claude", "codex"] },
    true,
  );

  assert.equal(reason, null);
});

test("blocks start when no daemon is online", () => {
  const reason = agentStartBlockReason(
    { machineId: "m1", runtime: "codex" },
    { id: "m1", status: "online", runtimes: ["codex"] },
    false,
  );

  assert.equal(reason, "no daemon online");
});

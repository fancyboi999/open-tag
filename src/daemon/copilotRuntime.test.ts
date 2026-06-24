// Parser test for the Copilot runtime's pure event mapping, run against REAL JSONL captured from
// GitHub Copilot CLI 1.0.61 (src/daemon/__fixtures__/copilot-*.jsonl). Run: `npx tsx --test src/daemon/copilotRuntime.test.ts`.
// This is the repo's first test — open-tag otherwise verifies via typecheck + real-run E2E. node:test
// is stdlib (no new dependency) so it adds no infrastructure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleCopilotEvent } from "./copilotRuntime.js";

const here = path.dirname(fileURLToPath(import.meta.url));
function fixtureEvents(name: string): any[] {
  return readFileSync(path.join(here, "__fixtures__", name), "utf8")
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

test("happy stream: surfaces assistant text and captures sessionId from result", () => {
  const events = fixtureEvents("copilot-happy.jsonl");
  const traj: any[] = [];
  let sessionId = "";
  let sawWorking = false;
  for (const e of events) {
    const emit = handleCopilotEvent(e);
    traj.push(...emit.trajectory);
    if (emit.sessionId) sessionId = emit.sessionId;
    if (emit.activity?.activity === "working") sawWorking = true;
  }
  assert.ok(traj.some((t) => t.kind === "text" && t.text.includes("PONG")), "expected the PONG text entry");
  assert.match(sessionId, /^[0-9a-f-]{36}$/, "expected a UUID sessionId captured from the result line");
  assert.ok(sawWorking, "expected assistant.turn_start to set working");
});

test("bad-model stream has no result event (error is on stderr, not JSON)", () => {
  // Confirms the load-bearing fact behind stderr-based failure handling: when --model is invalid,
  // copilot emits no `result` on stdout, so the adapter must rely on exit code + stderr tail.
  const events = fixtureEvents("copilot-badmodel.jsonl");
  let sawResult = false;
  for (const e of events) if (handleCopilotEvent(e).sessionId) sawResult = true;
  assert.equal(sawResult, false, "bad-model stream must not yield a sessionId/result");
});

test("empty reasoning content is skipped (reasoning is usually encrypted)", () => {
  const emit = handleCopilotEvent({ type: "assistant.reasoning", data: { reasoningId: "x", content: "" } });
  assert.equal(emit.trajectory.length, 0);
  const withText = handleCopilotEvent({ type: "assistant.reasoning", data: { content: "thinking out loud" } });
  assert.deepEqual(withText.trajectory, [{ kind: "thinking", text: "thinking out loud" }]);
});

test("toolRequests become tool trajectory entries with summarized args", () => {
  const emit = handleCopilotEvent({
    type: "assistant.message",
    data: { content: "", toolRequests: [{ name: "bash", arguments: { command: "ls -la /tmp" } }] },
  });
  assert.equal(emit.trajectory.length, 1);
  const entry = emit.trajectory[0];
  assert.ok(entry, "expected a tool entry");
  assert.equal(entry.kind, "tool");
  assert.equal(entry.toolName, "bash");
  assert.ok(entry.toolInput?.includes("ls -la /tmp"));
});

test("result carries sessionId and exitCode", () => {
  const emit = handleCopilotEvent({ type: "result", sessionId: "abc", exitCode: 0 });
  assert.equal(emit.sessionId, "abc");
  assert.equal(emit.exitCode, 0);
});

test("unknown / ignored events produce no output", () => {
  for (const type of ["session.skills_loaded", "assistant.message_delta", "assistant.turn_end", "user.message"]) {
    const emit = handleCopilotEvent({ type, data: { deltaContent: "x" } });
    assert.equal(emit.trajectory.length, 0, `${type} should emit no trajectory`);
    assert.equal(emit.activity, undefined, `${type} should emit no activity`);
  }
});

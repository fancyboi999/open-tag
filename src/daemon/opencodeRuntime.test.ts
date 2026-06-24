// Parser test for the OpenCode runtime's pure event mapping, run against REAL JSONL captured from
// opencode 1.15.5 (src/daemon/__fixtures__/opencode-*.jsonl). Run: `npx tsx --test src/daemon/opencodeRuntime.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleOpencodeEvent } from "./opencodeRuntime.js";

const here = path.dirname(fileURLToPath(import.meta.url));
function fixtureEvents(name: string): any[] {
  return readFileSync(path.join(here, "__fixtures__", name), "utf8")
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

test("happy stream: surfaces assistant text and captures the ses_ session id", () => {
  const events = fixtureEvents("opencode-happy.jsonl");
  const traj: any[] = [];
  let sessionId = "";
  let sawWorking = false;
  for (const e of events) {
    const emit = handleOpencodeEvent(e);
    traj.push(...emit.trajectory);
    if (emit.sessionId) sessionId = emit.sessionId;
    if (emit.activity?.activity === "working") sawWorking = true;
  }
  assert.ok(traj.some((t) => t.kind === "text" && t.text.includes("PONG")), "expected the PONG text entry");
  assert.match(sessionId, /^ses_/, "expected a ses_ session id captured from the event stream");
  assert.ok(sawWorking, "expected step_start to set working");
});

test("tool stream: tool_use becomes a tool entry with the bash command", () => {
  const events = fixtureEvents("opencode-tool.jsonl");
  const traj = events.flatMap((e) => handleOpencodeEvent(e).trajectory);
  const tool = traj.find((t) => t.kind === "tool");
  assert.ok(tool, "expected a tool trajectory entry");
  assert.equal(tool.toolName, "bash");
  assert.ok(tool.toolInput?.includes("ls"), "expected the summarized bash command");
  assert.ok(traj.some((t) => t.kind === "text" && t.text?.includes("done")), "expected the final text");
});

test("tool_use input is summarized from part.state.input", () => {
  const emit = handleOpencodeEvent({
    type: "tool_use",
    sessionID: "ses_x",
    part: { type: "tool", tool: "edit", state: { input: { filePath: "/srv/app.ts" } } },
  });
  assert.equal(emit.trajectory.length, 1);
  assert.equal(emit.trajectory[0]?.kind, "tool");
  assert.equal(emit.trajectory[0]?.toolName, "edit");
  assert.ok(emit.trajectory[0]?.toolInput?.includes("/srv/app.ts"));
});

test("reasoning maps to thinking; empty text is skipped; lifecycle events are silent", () => {
  assert.deepEqual(handleOpencodeEvent({ type: "reasoning", part: { text: "pondering" } }).trajectory,
    [{ kind: "thinking", text: "pondering" }]);
  assert.equal(handleOpencodeEvent({ type: "text", part: { text: "" } }).trajectory.length, 0);
  const fin = handleOpencodeEvent({ type: "step_finish", sessionID: "ses_y", part: { type: "step-finish" } });
  assert.equal(fin.trajectory.length, 0);
  assert.equal(fin.activity, undefined);
  assert.equal(fin.sessionId, "ses_y"); // session id is still captured from any event
});

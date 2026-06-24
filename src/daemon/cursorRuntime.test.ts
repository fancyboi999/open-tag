// Parser test for the Cursor runtime's pure event mapping, run against REAL JSONL captured from
// cursor-agent 2025.09.17 (src/daemon/__fixtures__/cursor-*.jsonl). Run: `npx tsx --test src/daemon/cursorRuntime.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleCursorEvent } from "./cursorRuntime.js";

const here = path.dirname(fileURLToPath(import.meta.url));
function fixtureEvents(name: string): any[] {
  return readFileSync(path.join(here, "__fixtures__", name), "utf8")
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

test("happy stream: final result text + session id captured from the system event", () => {
  const events = fixtureEvents("cursor-happy.jsonl");
  const traj: any[] = [];
  let sessionId = "";
  for (const e of events) {
    const emit = handleCursorEvent(e);
    traj.push(...emit.trajectory);
    if (emit.sessionId) sessionId = emit.sessionId;
  }
  assert.ok(traj.some((t) => t.kind === "text" && t.text.includes("PONG")), "expected the PONG result text");
  assert.match(sessionId, /^[0-9a-f-]{36}$/, "expected a UUID session id");
  // streamed assistant chunks ("P","ONG") must NOT each become a row — only the result text
  assert.equal(traj.filter((t) => t.kind === "text").length, 1, "expected exactly one text entry (the result)");
});

test("tool stream: tool_call(started) becomes a tool entry with the shell command", () => {
  const events = fixtureEvents("cursor-tool.jsonl");
  const traj = events.flatMap((e) => handleCursorEvent(e).trajectory);
  const tool = traj.find((t) => t.kind === "tool");
  assert.ok(tool, "expected a tool trajectory entry");
  assert.equal(tool.toolName, "shell");
  assert.ok(tool.toolInput?.includes("echo hi"), "expected the summarized command");
});

test("tool_call shape: <kind>ToolCall key → name; args → input; completed not double-counted", () => {
  const started = handleCursorEvent({ type: "tool_call", subtype: "started", session_id: "s", tool_call: { shellToolCall: { args: { command: "ls -la" } } } });
  assert.equal(started.trajectory[0]?.toolName, "shell");
  assert.ok(started.trajectory[0]?.toolInput?.includes("ls -la"));
  const completed = handleCursorEvent({ type: "tool_call", subtype: "completed", tool_call: { shellToolCall: { args: { command: "ls -la" } } } });
  assert.equal(completed.trajectory.length, 0, "completed must not re-emit (avoid double-count)");
});

test("result is_error surfaces an error; assistant streaming chunks are skipped", () => {
  assert.match(handleCursorEvent({ type: "result", is_error: true, result: "rate limited" }).error ?? "", /rate limited/);
  assert.equal(handleCursorEvent({ type: "assistant", message: { content: [{ type: "text", text: "P" }] } }).trajectory.length, 0);
});

test("system:error event is surfaced as an error", () => {
  const emit = handleCursorEvent({ type: "system", subtype: "error", session_id: "s", error: "fatal: crashed" });
  assert.match(emit.error ?? "", /fatal: crashed/);
  assert.equal(emit.trajectory.length, 0);
});

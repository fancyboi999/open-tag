// Parser test for the Kimi runtime's pure event mapping, run against REAL JSONL captured from
// kimi-code 0.19.2 (src/daemon/__fixtures__/kimi-*.jsonl). Run: `npx tsx --test src/daemon/kimiRuntime.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleKimiEvent } from "./kimiRuntime.js";

const here = path.dirname(fileURLToPath(import.meta.url));
function fixtureEvents(name: string): any[] {
  return readFileSync(path.join(here, "__fixtures__", name), "utf8")
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

test("happy stream: assistant text + session id from resume_hint", () => {
  const events = fixtureEvents("kimi-happy.jsonl");
  const traj: any[] = [];
  let sessionId = "";
  for (const e of events) {
    const emit = handleKimiEvent(e);
    traj.push(...emit.trajectory);
    if (emit.sessionId) sessionId = emit.sessionId;
  }
  assert.ok(traj.some((t) => t.kind === "text" && t.text.includes("PONG")), "expected the PONG text entry");
  assert.match(sessionId, /^session_/, "expected session_… id captured from session.resume_hint");
});

test("tool stream: assistant.tool_calls become tool entries; tool results not surfaced", () => {
  const events = fixtureEvents("kimi-tool.jsonl");
  const traj = events.flatMap((e) => handleKimiEvent(e).trajectory);
  const tool = traj.find((t) => t.kind === "tool");
  assert.ok(tool, "expected a tool trajectory entry");
  assert.equal(tool.toolName, "Bash");
  assert.ok(tool.toolInput?.includes("echo hi"), "expected the summarized command from arguments JSON");
  assert.ok(traj.some((t) => t.kind === "text" && t.text?.includes("Done")), "expected final text");
  // role:"tool" result lines must NOT add trajectory entries
  const toolResult = handleKimiEvent({ role: "tool", tool_call_id: "x", content: "hi\n" });
  assert.equal(toolResult.trajectory.length, 0);
});

test("tool_calls arguments are parsed from the JSON string", () => {
  const emit = handleKimiEvent({ role: "assistant", tool_calls: [{ type: "function", id: "Edit_0", function: { name: "Edit", arguments: '{"filePath":"/srv/x.ts"}' } }] });
  assert.equal(emit.trajectory.length, 1);
  assert.equal(emit.trajectory[0]?.toolName, "Edit");
  assert.ok(emit.trajectory[0]?.toolInput?.includes("/srv/x.ts"));
});

test("empty content and user echo produce no trajectory", () => {
  assert.equal(handleKimiEvent({ role: "assistant", content: "" }).trajectory.length, 0);
  assert.equal(handleKimiEvent({ role: "user", content: "hi" }).trajectory.length, 0);
});

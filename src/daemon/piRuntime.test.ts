// Parser test for the Pi runtime's pure event mapping, run against REAL JSONL captured from
// pi 0.73.1 (src/daemon/__fixtures__/pi-*.jsonl). Run: `npx tsx --test src/daemon/piRuntime.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handlePiEvent } from "./piRuntime.js";

const here = path.dirname(fileURLToPath(import.meta.url));
function fixtureEvents(name: string): any[] {
  return readFileSync(path.join(here, "__fixtures__", name), "utf8")
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

test("happy stream: assistant text + session id from the session event", () => {
  const events = fixtureEvents("pi-happy.jsonl");
  const traj: any[] = [];
  let sessionId = "";
  for (const e of events) {
    const emit = handlePiEvent(e);
    traj.push(...emit.trajectory);
    if (emit.sessionId) sessionId = emit.sessionId;
  }
  assert.ok(traj.some((t) => t.kind === "text" && t.text.includes("PONG")), "expected the PONG text entry");
  assert.match(sessionId, /^[0-9a-f-]{36}$/, "expected a UUID session id from the session event");
});

test("tool stream: toolCall blocks become tool entries; final text surfaced", () => {
  const events = fixtureEvents("pi-tool.jsonl");
  const traj = events.flatMap((e) => handlePiEvent(e).trajectory);
  const tool = traj.find((t) => t.kind === "tool");
  assert.ok(tool, "expected a tool trajectory entry");
  assert.equal(tool.toolName, "bash");
  assert.ok(tool.toolInput?.includes("echo hi"), "expected the summarized command from arguments");
  assert.ok(traj.some((t) => t.kind === "text" && t.text?.includes("done")), "expected final text");
});

test("toolCall arguments object is summarized; text/toolCall blocks mapped", () => {
  const emit = handlePiEvent({ type: "message_end", message: { role: "assistant", content: [
    { type: "toolCall", id: "x", name: "edit", arguments: { filePath: "/srv/app.ts" } },
    { type: "text", text: "patched" },
  ] } });
  assert.equal(emit.trajectory.length, 2);
  assert.equal(emit.trajectory[0]?.kind, "tool");
  assert.equal(emit.trajectory[0]?.toolName, "edit");
  assert.ok(emit.trajectory[0]?.toolInput?.includes("/srv/app.ts"));
  assert.equal(emit.trajectory[1]?.kind, "text");
});

test("user echo and non-message events produce no trajectory (no double-count with agent_end)", () => {
  assert.equal(handlePiEvent({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }] } }).trajectory.length, 0);
  assert.equal(handlePiEvent({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "PONG" }] }] }).trajectory.length, 0);
  assert.equal(handlePiEvent({ type: "turn_start" }).trajectory.length, 0);
});

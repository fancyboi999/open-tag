// Parser test for the Reasonix runtime's pure event mapping, run against REAL JSONL captured from
// reasonix v1.18.0 and re-verified live on v1.19.1 (src/daemon/__fixtures__/reasonix-*.jsonl). Run:
// `npx tsx --test src/daemon/reasonixRuntime.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleReasonixEvent, reasonixSessionFile, buildArgs, flushReasonixThinking, findReasonixSessionFile } from "./reasonixRuntime.js";

const here = path.dirname(fileURLToPath(import.meta.url));
function fixtureEvents(name: string): any[] {
  return readFileSync(path.join(here, "__fixtures__", name), "utf8")
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

test("happy stream: surfaces text and captures the session id from the final result", () => {
  const events = fixtureEvents("reasonix-happy.jsonl");
  const traj: any[] = [];
  let sessionId = "";
  let sawWorking = false;
  for (const e of events) {
    const emit = handleReasonixEvent(e);
    traj.push(...emit.trajectory);
    if (emit.sessionId) sessionId = emit.sessionId;
    if (emit.activity?.activity === "working") sawWorking = true;
  }
  assert.ok(traj.some((t) => t.kind === "text" && t.text?.includes("PONG")), "expected the PONG text entry");
  assert.match(sessionId, /^20260801-/, "expected the session id captured from the final result object");
  assert.ok(sawWorking, "expected turn_started/phase to set working");
});

test("tool stream: partial+full tool_dispatch pair surfaces a single tool entry with args", () => {
  const events = fixtureEvents("reasonix-tool.jsonl");
  const seen = new Set<string>();
  const traj = events.flatMap((e) => handleReasonixEvent(e, seen).trajectory);
  const tools = traj.filter((t) => t.kind === "tool");
  assert.equal(tools.length, 1, "the partial marker and the full dispatch must collapse to ONE tool entry");
  assert.equal(tools[0]?.toolName, "ls");
  assert.ok(tools[0]?.toolInput?.includes("."), "expected the summarized args");
  assert.ok(traj.some((t) => t.kind === "text" && t.text?.includes("文件")), "expected the assembled message text");
});

test("resume turn: the result carries the SAME session id so the --resume chain is stable", () => {
  const events = fixtureEvents("reasonix-resume.jsonl");
  let sessionId = "";
  for (const e of events) { const emit = handleReasonixEvent(e); if (emit.sessionId) sessionId = emit.sessionId; }
  assert.equal(sessionId, "20260801-121455.600066000-hy3-ioa + planner kimi-k3-ioa");
});

test("a resumed session id maps to the persisted session file reasonix --resume expects", () => {
  // v1.19.1 keys storage on its LOGICAL cwd (honors PWD): a run in /tmp/x — where getcwd() reports
  // /private/tmp/x on macOS — writes projects/-tmp-x, so the encoding must use cwd as given. Verified
  // live against v1.19.1; v1.18.0 used getcwd() instead and is covered by the by-id fallback.
  const id = "20260801-121455.600066000-hy3-ioa + planner kimi-k3-ioa";
  assert.equal(
    reasonixSessionFile(id, "/tmp/rxpwd", "/home/u/.reasonix"),
    `/home/u/.reasonix/projects/-tmp-rxpwd/sessions/${id}.jsonl`,
    "a symlinked cwd must NOT be realpath-resolved",
  );
  // dots in the path are encoded to dashes too (agent state dirs like ~/.open-tag/agents/a1)
  assert.equal(
    reasonixSessionFile(id, "/home/u/.open-tag/agents/a1", "/home/u/.reasonix"),
    `/home/u/.reasonix/projects/-home-u--open-tag-agents-a1/sessions/${id}.jsonl`,
  );
});

test("findReasonixSessionFile finds a session by id even when the cwd encoding differs", () => {
  // bind-mount hosts (e.g. Synology /var/services/homes) key the project dir by a path realpath does
  // not reproduce, so the computed path misses; the by-id search must still find the persisted file.
  const root = mkdtempSync(path.join(os.tmpdir(), "rx-home-"));
  const sessionsDir = path.join(root, "projects", "var-services-homes-user-.open-tag-agents-a1", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const id = "20260801-121455.600066000-hy3-ioa + planner kimi-k3-ioa";
  writeFileSync(path.join(sessionsDir, id + ".jsonl"), "{}\n");
  assert.equal(findReasonixSessionFile(id, root), path.join(sessionsDir, id + ".jsonl"));
  assert.equal(findReasonixSessionFile("no-such-id", root), null);
  assert.equal(findReasonixSessionFile(id, "/nonexistent/home"), null, "missing projects dir is not an error");
});

test("an exit-0 execution error (result.is_error) is surfaced, not swallowed", () => {
  const events = fixtureEvents("reasonix-error.jsonl");
  let error = "";
  for (const e of events) { const emit = handleReasonixEvent(e); if (emit.error) error = emit.error; }
  assert.match(error, /error_during_execution|no such model/);
});

test("partial dispatch without a following full event is skipped; empty text is skipped", () => {
  const seen = new Set<string>();
  const emit = handleReasonixEvent({ kind: "tool_dispatch", tool: { id: "t1", name: "ls", readOnly: true, partial: true } }, seen);
  assert.equal(emit.trajectory.length, 0, "the partial marker must not surface a tool entry");
  const full = handleReasonixEvent({ kind: "tool_dispatch", tool: { id: "t1", name: "ls", args: "{\"path\": \".\"}", readOnly: true } }, seen);
  assert.equal(full.trajectory.length, 1);
  assert.equal(full.trajectory[0]?.kind, "tool");
  assert.equal(handleReasonixEvent({ kind: "text", text: "" }).trajectory.length, 0);
});

test("reasoning maps to thinking; lifecycle + usage events are silent", () => {
  // NOTE: v1.18.0 and v1.19.1 emit no `reasoning` events at all (reasoningTokens>0 in usage, but
  // only `text` slices on the wire, with or without --show-thinking). This covers the mapping
  // defensively for a future build; it is not a live path today.
  assert.deepEqual(handleReasonixEvent({ kind: "reasoning", text: "pondering" }).trajectory,
    [{ kind: "thinking", text: "pondering" }]);
  assert.equal(handleReasonixEvent({ kind: "reasoning" }).trajectory.length, 0);
  for (const k of ["turn_started", "usage", "tool_result"]) {
    assert.equal(handleReasonixEvent({ kind: k }).trajectory.length, 0, `kind ${k} must be silent`);
  }
});

test("reasoning token slices accumulate into one thinking entry per newline boundary", () => {
  const acc: { thinking: string } = { thinking: "" };
  const seen = new Set<string>();
  const emit = (s: string) => handleReasonixEvent({ kind: "reasoning", text: s }, seen, acc);
  // incremental slices (as reasonix actually streams) must NOT push per-slice entries
  assert.equal(emit("The").trajectory.length, 0);
  assert.equal(emit(" user wants").trajectory.length, 0);
  assert.equal(emit(" a check.\n\n").trajectory.length, 1, "a newline boundary flushes the accumulated thinking");
  assert.equal(emit("Then ").trajectory.length, 0);
  assert.equal(flushReasonixThinking(acc).length, 1, "the trailing partial flushes at turn end");
});

test("text token slices are dropped; the assembled message event is the authoritative output", () => {
  const seen = new Set<string>();
  // real reasonix stream: `text` carries one glyph at a time, `message` the assembled sentence
  const slices = ["没有", "配置", " M", "CP", " ", "服务器", "，"];
  const fromText = slices.flatMap((s) => handleReasonixEvent({ kind: "text", text: s }, seen).trajectory);
  assert.equal(fromText.length, 0, "incremental text slices must not be pushed verbatim");
  const msg = handleReasonixEvent({ kind: "message", text: "没有配置 MCP 服务器。" }, seen);
  assert.deepEqual(msg.trajectory, [{ kind: "text", text: "没有配置 MCP 服务器。" }]);
});

test("the reasonix max-steps injection is flagged so the daemon can log the cap firing", () => {
  const normal = handleReasonixEvent({ kind: "message", text: "## 本轮执行结果汇总" });
  assert.equal(normal.maxStepsReached, undefined, "an ordinary message must not be mistaken for the cap");
  const capped = handleReasonixEvent({ kind: "message", text: "Do not call any more tools — your tool-call round limit (--max-steps) has been reached. Instead, synthesize a final answer…" });
  assert.equal(capped.maxStepsReached, true, "the round-limit sentence marks the turn as cap-terminated");
});

test("buildArgs always bounds tool-call rounds with --max-steps so a turn cannot loop forever", () => {
  const opts = { model: "deepseek-v4-flash", runtimeConfig: null } as any;
  const args = buildArgs("hello", opts, null);
  const i = args.indexOf("--max-steps");
  assert.ok(i >= 0, "must pass --max-steps");
  assert.equal(Number(args[i + 1]), 100, "wide observation bound: real turns never hit it, a livelock still terminates");
  assert.equal(args[args.length - 1], "hello", "the message is the trailing argv");
  const resumed = buildArgs("again", opts, "/home/u/.reasonix/projects/x/sessions/s.jsonl");
  assert.ok(resumed.includes("--resume"), "resume file is passed through");
  assert.equal(resumed[resumed.length - 1], "again");
});

test("buildArgs only forwards --effort values the CLI accepts", () => {
  // Probed against v1.18.0 and v1.19.1: an openai-kind provider rejects anything outside
  // low|medium|high with an exit-0 `is_error: true` result ("effort must be low, medium, or high");
  // `max` is accepted. The claude/codex vocabulary must never reach argv.
  const effortOf = (reasoningEffort: unknown): string | undefined => {
    const args = buildArgs("hi", { model: "hy3", runtimeConfig: { reasoningEffort } } as any, null);
    const i = args.indexOf("--effort");
    return i >= 0 ? args[i + 1] : undefined;
  };
  for (const ok of ["low", "medium", "high", "max"]) assert.equal(effortOf(ok), ok, `${ok} must forward`);
  for (const bad of ["none", "xhigh", "minimal", "", "HIGH", 3, null]) {
    assert.equal(effortOf(bad), undefined, `${JSON.stringify(bad)} must be dropped, not passed to the CLI`);
  }
  assert.equal(buildArgs("hi", { model: "hy3" } as any, null).includes("--effort"), false, "no runtimeConfig → no --effort");
});

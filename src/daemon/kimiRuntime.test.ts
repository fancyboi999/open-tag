// Parser test for the Kimi runtime's pure event mapping, run against REAL JSONL captured from
// kimi-code 0.19.2 (src/daemon/__fixtures__/kimi-*.jsonl). Run: `npx tsx --test src/daemon/kimiRuntime.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildKimiPrompt, handleKimiEvent, isMissingKimiSession, kimiRuntime } from "./kimiRuntime.js";

const here = path.dirname(fileURLToPath(import.meta.url));
function fixtureEvents(name: string): any[] {
  return readFileSync(path.join(here, "__fixtures__", name), "utf8")
    .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

const PATH_KEY = process.platform === "win32" ? "Path" : "PATH";

function fakeKimi(binDir: string, source: string): void {
  const scriptName = "kimi-fake.cjs";
  writeFileSync(path.join(binDir, scriptName), source, "utf8");
  if (process.platform === "win32") {
    writeFileSync(path.join(binDir, "kimi.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0${scriptName}" %*\r\n`, "utf8");
  } else {
    const executable = path.join(binDir, "kimi");
    writeFileSync(executable, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(binDir, scriptName))} "$@"\n`, "utf8");
    chmodSync(executable, 0o755);
  }
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

const noLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any;

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

test("Kimi compatibility mode composes standing instructions on every turn", () => {
  const prompt = buildKimiPrompt("open-tag standing instructions", "user turn");
  assert.match(prompt, /open-tag standing instructions/);
  assert.match(prompt, /user turn/);
});

test("Kimi stale-session detection is bound to the resumed session id", () => {
  assert.equal(isMissingKimiSession('Session "session_stale" not found', "session_stale"), true);
  assert.equal(isMissingKimiSession('Session "another_session" not found', "session_stale"), false);
  assert.equal(isMissingKimiSession("Model not found", "session_stale"), false);
});

test("Kimi clears a stale resume id and retries the same admitted turn before queued work", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-kimi-stale-"));
  const binDir = path.join(root, "bin");
  const attemptsFile = path.join(root, "attempts.json");
  mkdirSync(binDir);
  fakeKimi(binDir, [
    'const fs = require("node:fs");',
    "const file = process.env.OPEN_TAG_TEST_ATTEMPTS;",
    'const attempts = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];',
    "attempts.push(process.argv.slice(2));",
    "fs.writeFileSync(file, JSON.stringify(attempts));",
    'if (attempts.length === 1) { console.error(\'Session "session_stale" not found\'); process.exit(1); }',
    'console.log(JSON.stringify({ role: "meta", type: "session.resume_hint", session_id: "session_fresh" }));',
  ].join("\n"));

  const sessions: Array<string | null> = [];
  const admissions: Array<Error | undefined> = [];
  const failures: number[] = [];
  const activities: string[] = [];
  const exits: Array<number | null> = [];
  let session: ReturnType<typeof kimiRuntime.start> | undefined;
  try {
    session = kimiRuntime.start({
      cwd: root,
      stateDir: root,
      env: { [PATH_KEY]: binDir, HOME: root, OPEN_TAG_TEST_ATTEMPTS: attemptsFile },
      sessionId: "session_stale",
      systemPrompt: "standing instructions",
      initialPrompt: "current turn",
    }, {
      onSession: (sessionId) => sessions.push(sessionId),
      onInitialTurnAdmission: (error) => admissions.push(error),
      onAcceptedTurnFailure: () => failures.push(failures.length + 1),
      onActivity: (activity) => activities.push(activity),
      onTrajectory: () => {},
      onExit: (code) => exits.push(code),
      log: noLog,
    });
    let queuedError: Error | undefined;
    const queued = session.deliver("queued turn").catch((error) => { queuedError = error; });
    await waitFor(() => existsSync(attemptsFile) && JSON.parse(readFileSync(attemptsFile, "utf8")).length === 3, "stale retry and queued turn");
    await queued;
    await waitFor(() => activities.filter((activity) => activity === "online").length === 2, "both successful turns");
    assert.equal(queuedError, undefined);

    const attempts: string[][] = JSON.parse(readFileSync(attemptsFile, "utf8"));
    const promptOf = (args: string[]) => args[args.indexOf("-p") + 1];
    assert.deepEqual(attempts[0]?.slice(-2), ["-r", "session_stale"]);
    assert.equal(attempts[1]?.includes("-r"), false, "the stale input must retry without resume");
    assert.equal(promptOf(attempts[1]!), promptOf(attempts[0]!), "fresh retry must preserve the current input");
    assert.deepEqual(attempts[2]?.slice(-2), ["-r", "session_fresh"]);
    assert.notEqual(promptOf(attempts[2]!), promptOf(attempts[1]!), "queued work runs only after the retry");
    assert.deepEqual(sessions, ["session_stale", null, "session_fresh"]);
    assert.deepEqual(admissions, [undefined]);
    assert.deepEqual(failures, []);
    assert.deepEqual(exits, []);
    assert.equal(activities.filter((activity) => activity === "online").length, 2);
    assert.equal(activities.includes("error"), false, "stale resume recovery is not a terminal failure");
  } finally {
    session?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Kimi stop during stale-session clearing cannot start the fresh retry", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-kimi-stale-stop-"));
  const binDir = path.join(root, "bin");
  const attemptsFile = path.join(root, "attempts.json");
  mkdirSync(binDir);
  fakeKimi(binDir, [
    'const fs = require("node:fs");',
    "const file = process.env.OPEN_TAG_TEST_ATTEMPTS;",
    'const attempts = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];',
    "attempts.push(process.argv.slice(2));",
    "fs.writeFileSync(file, JSON.stringify(attempts));",
    'console.error(\'Session "session_stale" not found\');',
    "process.exit(1);",
  ].join("\n"));

  const sessions: Array<string | null> = [];
  const failures: number[] = [];
  const activities: string[] = [];
  const exits: Array<number | null> = [];
  let session: ReturnType<typeof kimiRuntime.start> | undefined;
  try {
    session = kimiRuntime.start({
      cwd: root,
      stateDir: root,
      env: { [PATH_KEY]: binDir, HOME: root, OPEN_TAG_TEST_ATTEMPTS: attemptsFile },
      sessionId: "session_stale",
      systemPrompt: "standing instructions",
      initialPrompt: "current turn",
    }, {
      onSession: (sessionId) => {
        sessions.push(sessionId);
        if (sessionId === null) session?.stop();
      },
      onInitialTurnAdmission: () => {},
      onAcceptedTurnFailure: () => failures.push(failures.length + 1),
      onActivity: (activity) => activities.push(activity),
      onTrajectory: () => {},
      onExit: (code) => exits.push(code),
      log: noLog,
    });
    const queuedError = session.deliver("queued turn").then(() => null, (error) => error as Error);
    await waitFor(() => sessions.includes(null), "stale session clearing");
    const error = await queuedError;
    assert.ok(error instanceof Error);
    assert.match(error.message, /stopped before input admission/);
    await waitFor(() => exits.length === 1, "single stop exit");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(JSON.parse(readFileSync(attemptsFile, "utf8")).length, 1);
    assert.deepEqual(sessions, ["session_stale", null]);
    assert.deepEqual(failures, []);
    assert.deepEqual(exits, [0]);
    assert.equal(activities.includes("online"), false);
    assert.equal(activities.includes("error"), false);
  } finally {
    session?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

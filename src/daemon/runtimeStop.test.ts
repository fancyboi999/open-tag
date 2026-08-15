import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Runtime, RuntimeCallbacks } from "./runtime.js";
import { copilotRuntime } from "./copilotRuntime.js";
import { cursorRuntime } from "./cursorRuntime.js";
import { hermesRuntime } from "./hermesRuntime.js";
import { kimiRuntime } from "./kimiRuntime.js";
import { opencodeRuntime } from "./opencodeRuntime.js";
import { piRuntime } from "./piRuntime.js";

const adapters: Array<{ command: string; runtime: Runtime }> = [
  { command: "copilot", runtime: copilotRuntime },
  { command: "cursor-agent", runtime: cursorRuntime },
  { command: "hermes", runtime: hermesRuntime },
  { command: "kimi", runtime: kimiRuntime },
  { command: "opencode", runtime: opencodeRuntime },
  { command: "pi", runtime: piRuntime },
];

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(predicate(), `timed out waiting for ${label}`);
}

function fakeCommand(binDir: string, command: string, body: string): void {
  if (process.platform === "win32") {
    const batchBody = body === "exit 0"
      ? "exit /b 0"
      : "ping -n 31 127.0.0.1 >nul";
    writeFileSync(path.join(binDir, `${command}.cmd`), `@echo off\r\n${batchBody}\r\n`, "utf8");
  } else {
    const file = path.join(binDir, command);
    writeFileSync(file, `#!/bin/sh\n${body}\n`, "utf8");
    chmodSync(file, 0o755);
  }
}

function fakeNodeCommand(binDir: string, command: string, source: string): void {
  const scriptName = `${command}-fake.cjs`;
  writeFileSync(path.join(binDir, scriptName), source, "utf8");
  if (process.platform === "win32") {
    writeFileSync(path.join(binDir, `${command}.cmd`), `@echo off\r\n"${process.execPath}" "%~dp0${scriptName}"\r\n`, "utf8");
  } else {
    const file = path.join(binDir, command);
    writeFileSync(file, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(binDir, scriptName))}\n`, "utf8");
    chmodSync(file, 0o755);
  }
}

function callbacks(
  admissions: Array<Error | undefined>,
  activities: string[],
  exits: Array<number | null>,
  acceptedFailures: number[] = [],
): RuntimeCallbacks {
  return {
    onSession: () => {},
    onInitialTurnAdmission: (error) => admissions.push(error),
    onAcceptedTurnFailure: () => acceptedFailures.push(acceptedFailures.length + 1),
    onActivity: (activity) => activities.push(activity),
    onTrajectory: () => {},
    onExit: (code) => exits.push(code),
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
  };
}

async function assertAcceptedFailureKeepsSessionReusable(
  adapter: { command: string; runtime: Runtime },
  source: string,
): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), `open-tag-${adapter.runtime.name}-accepted-failure-`));
  const binDir = path.join(root, "bin");
  const stateDir = path.join(root, "state");
  const countFile = path.join(root, "turn-count");
  mkdirSync(binDir); mkdirSync(stateDir);
  fakeNodeCommand(binDir, adapter.command, source);
  const admissions: Array<Error | undefined> = [];
  const activities: string[] = [];
  const exits: Array<number | null> = [];
  const acceptedFailures: number[] = [];
  let session: ReturnType<Runtime["start"]> | undefined;
  try {
    session = adapter.runtime.start({
      cwd: root,
      stateDir,
      env: { PATH: binDir, HOME: root, OPEN_TAG_TEST_STATE: countFile },
      systemPrompt: "system",
      initialPrompt: "start",
    }, callbacks(admissions, activities, exits, acceptedFailures));
    await waitFor(() => activities.filter((activity) => activity === "online").length === 1, `${adapter.runtime.name} initial success`);
    await session.deliver("fail after admission");
    await waitFor(() => acceptedFailures.length === 1, `${adapter.runtime.name} accepted failure terminal`);
    assert.equal(activities.at(-1), "error", "the failure stays visible instead of being reported as online");
    assert.deepEqual(exits, [], "a recoverable turn failure keeps the runtime session alive");

    await session.deliver("retry after failure");
    await waitFor(() => activities.filter((activity) => activity === "online").length === 2, `${adapter.runtime.name} retry success`);
    assert.equal(acceptedFailures.length, 1, "one failed turn reports exactly one failure terminal");
  } finally {
    session?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

test("one-shot runtime stop waits for a live child exit and reports it exactly once", async (t) => {
  for (const adapter of adapters) await t.test(adapter.runtime.name, async () => {
    const root = mkdtempSync(path.join(tmpdir(), `open-tag-${adapter.runtime.name}-stop-live-`));
    const binDir = path.join(root, "bin");
    const stateDir = path.join(root, "state");
    mkdirSync(binDir); mkdirSync(stateDir);
    fakeCommand(binDir, adapter.command, "exec /bin/sleep 30");
    const admissions: Array<Error | undefined> = [];
    const activities: string[] = [];
    const exits: Array<number | null> = [];
    try {
      const session = adapter.runtime.start({
        cwd: root, stateDir, env: { PATH: binDir, HOME: root }, systemPrompt: "system", initialPrompt: "start",
      }, callbacks(admissions, activities, exits));
      await waitFor(() => admissions.length === 1, `${adapter.runtime.name} initial admission`);
      assert.equal(admissions[0], undefined);
      assert.equal(exits.length, 0);
      session.stop();
      await waitFor(() => exits.length === 1, `${adapter.runtime.name} child exit`);
      session.stop();
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(exits.length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("one-shot runtime stop completes immediately after its turn process is already idle", async (t) => {
  for (const adapter of adapters) await t.test(adapter.runtime.name, async () => {
    const root = mkdtempSync(path.join(tmpdir(), `open-tag-${adapter.runtime.name}-stop-idle-`));
    const binDir = path.join(root, "bin");
    const stateDir = path.join(root, "state");
    mkdirSync(binDir); mkdirSync(stateDir);
    fakeCommand(binDir, adapter.command, "exit 0");
    const admissions: Array<Error | undefined> = [];
    const activities: string[] = [];
    const exits: Array<number | null> = [];
    try {
      const session = adapter.runtime.start({
        cwd: root, stateDir, env: { PATH: binDir, HOME: root }, systemPrompt: "system", initialPrompt: "start",
      }, callbacks(admissions, activities, exits));
      await waitFor(() => activities.includes("online"), `${adapter.runtime.name} idle state`);
      assert.equal(exits.length, 0, "clean one-shot turn exit keeps the reusable runtime session alive");
      session.stop();
      assert.deepEqual(exits, [0]);
      session.stop();
      assert.deepEqual(exits, [0]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("one-shot runtimes report an admitted non-zero turn failure and remain reusable", async (t) => {
  const source = `
const fs = require("node:fs");
const file = process.env.OPEN_TAG_TEST_STATE;
const count = (fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0) + 1;
fs.writeFileSync(file, String(count));
if (count === 2) { console.error("accepted turn failed"); process.exit(1); }
`;
  for (const adapter of adapters) await t.test(adapter.runtime.name, () => assertAcceptedFailureKeepsSessionReusable(adapter, source));
});

test("Cursor reports an exit-zero result error as an admitted terminal failure", async () => {
  const source = `
const fs = require("node:fs");
const file = process.env.OPEN_TAG_TEST_STATE;
const count = (fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0) + 1;
fs.writeFileSync(file, String(count));
if (count === 2) console.log(JSON.stringify({ type: "result", is_error: true, result: "rate limited" }));
`;
  await assertAcceptedFailureKeepsSessionReusable(adapters.find((adapter) => adapter.runtime === cursorRuntime)!, source);
});

test("Hermes reports an unbridgeable exit-zero response as an admitted terminal failure", async () => {
  const source = `
const fs = require("node:fs");
const file = process.env.OPEN_TAG_TEST_STATE;
const count = (fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0) + 1;
fs.writeFileSync(file, String(count));
if (count === 2) {
  fs.appendFileSync(process.env.OPEN_TAG_TURN_FILE, JSON.stringify({ type: "check", target: "dm:@User", count: 1, messageId: "1234abcd", grant: "primary" }) + "\\n");
  console.log("Error: provider rejected the request");
}
`;
  await assertAcceptedFailureKeepsSessionReusable(adapters.find((adapter) => adapter.runtime === hermesRuntime)!, source);
});

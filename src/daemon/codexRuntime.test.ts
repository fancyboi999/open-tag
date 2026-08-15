// Regression for #163: a missing Codex binary must not crash the daemon process.
// Run: npx tsx --test src/daemon/codexRuntime.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { codexRuntime } from "./codexRuntime.js";
import { AgentManager, type AgentConfig } from "./agentManager.js";
import { ResourceBudget } from "./resourceBudget.js";

const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any;
// Full-suite parallelism can delay spawning the fake app-server well beyond one second.
// This guards the test harness only; the production delivery ACK timeout is unchanged.
const waitFor = async (predicate: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for runtime callback");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test("missing codex binary reports offline instead of crashing daemon", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-codex-missing-"));
  const events: { activity: string; detail?: string }[] = [];
  let exitCode: number | null | undefined;
  const admissions: Array<Error | undefined> = [];

  try {
    const session = codexRuntime.start({
      cwd: root,
      stateDir: root,
      env: { PATH: root },
      systemPrompt: "system",
      initialPrompt: "start",
    }, {
      onSession: () => {},
      onInitialTurnAdmission: (error) => admissions.push(error),
      onAcceptedTurnFailure: () => {},
      onActivity: (activity, detail) => events.push({ activity, detail }),
      onTrajectory: () => {},
      onExit: (code) => { exitCode = code; },
      log,
    });
    const runningDelivery = assert.rejects(session.deliver("queued while codex is starting"));

    await new Promise((resolve) => setTimeout(resolve, 50));
    await runningDelivery;
    session.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  assert.equal(exitCode, 1);
  assert.equal(admissions.length, 1);
  assert.ok(admissions[0] instanceof Error);
  assert.ok(
    events.some((e) => e.activity === "offline" && /codex not found/.test(e.detail ?? "")),
    "expected a visible offline activity for missing codex",
  );
});

test("initial admission rejects exactly once when Codex turn/start RPC rejects", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-codex-turn-reject-"));
  const executable = path.join(root, "codex");
  const admissions: Array<Error | undefined> = [];
  let session: ReturnType<typeof codexRuntime.start> | undefined;
  try {
    writeFileSync(executable, `#!${process.execPath}\nconst readline = require("node:readline");\nconst rl = readline.createInterface({ input: process.stdin });\nrl.on("line", (line) => {\n  const request = JSON.parse(line);\n  if (request.id === undefined) return;\n  if (request.method === "initialize") console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }));\n  else if (request.method === "thread/start") console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { thread: { id: "thread-test" } } }));\n  else if (request.method === "turn/start") console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "turn rejected" } }));\n});\n`);
    chmodSync(executable, 0o755);
    session = codexRuntime.start({ cwd: root, stateDir: root, env: { PATH: root }, systemPrompt: "system", initialPrompt: "start" }, {
      onSession: () => {},
      onInitialTurnAdmission: (error) => admissions.push(error),
      onAcceptedTurnFailure: () => {},
      onActivity: () => {},
      onTrajectory: () => {},
      onExit: () => {},
      log,
    });

    await waitFor(() => admissions.length > 0);
    assert.equal(admissions.length, 1);
    assert.match(admissions[0]?.message ?? "", /turn rejected/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(admissions.length, 1, "RPC failure and process cleanup must not settle admission twice");
  } finally {
    session?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const reasoningEffort of ["max", "ultra"] as const) test(`GPT-5.6 model and ${reasoningEffort} effort reach Codex thread/start and turn/start`, async () => {
  const root = mkdtempSync(path.join(tmpdir(), `open-tag-codex-gpt56-${reasoningEffort}-`));
  const executable = path.join(root, "codex");
  const requestsFile = path.join(root, "requests.jsonl");
  const admissions: Array<Error | undefined> = [];
  let session: ReturnType<typeof codexRuntime.start> | undefined;
  try {
    writeFileSync(executable, `#!${process.execPath}\nconst fs = require("node:fs");\nconst path = require("node:path");\nconst readline = require("node:readline");\nconst rl = readline.createInterface({ input: process.stdin });\nrl.on("line", (line) => {\n  const request = JSON.parse(line);\n  if (request.id === undefined) return;\n  fs.appendFileSync(path.join(process.cwd(), "requests.jsonl"), line + "\\n");\n  if (request.method === "initialize") console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }));\n  else if (request.method === "thread/start") console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { thread: { id: "thread-gpt56" } } }));\n  else if (request.method === "turn/start") {\n    console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { turn: { id: "turn-gpt56" } } }));\n    console.log(JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-gpt56", turn: { status: "completed" } } }));\n  }\n});\n`);
    chmodSync(executable, 0o755);
    session = codexRuntime.start({
      cwd: root,
      stateDir: root,
      env: { PATH: root },
      systemPrompt: "system",
      initialPrompt: "start",
      model: "gpt-5.6-sol",
      runtimeConfig: { reasoningEffort },
    }, {
      onSession: () => {},
      onInitialTurnAdmission: (error) => admissions.push(error),
      onAcceptedTurnFailure: () => {},
      onActivity: () => {},
      onTrajectory: () => {},
      onExit: () => {},
      log,
    });

    await waitFor(() => admissions.length > 0);
    assert.equal(admissions[0], undefined);
    const requests = readFileSync(requestsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const threadStart = requests.find((request) => request.method === "thread/start");
    const turnStart = requests.find((request) => request.method === "turn/start");
    assert.equal(threadStart.params.model, "gpt-5.6-sol");
    assert.equal(threadStart.params.config.model_reasoning_effort, reasoningEffort);
    assert.equal(turnStart.params.effort, reasoningEffort);
  } finally {
    session?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("running Codex turn/start rejection NACKs, clears the fence, and executes the same-id retry", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-codex-running-retry-"));
  const executable = path.join(root, "codex");
  const agentId = "codex-running-retry";
  const turnCountFile = path.join(root, agentId, "turn-count");
  const config: AgentConfig = {
    agentId,
    name: "codex",
    displayName: "Codex",
    description: "test",
    runtime: "codex",
    model: "default",
    serverUrl: "http://localhost:7777",
    serverId: "server-1",
    agentToken: "test-token",
  };
  const mgr = new AgentManager(() => {}, {
    dataDir: root,
    binDir: root,
    deliverDebounceMs: 0,
    budget: new ResourceBudget({ availableMemMB: () => 999999 }),
    runtimeResolver: () => codexRuntime,
  });
  try {
    writeFileSync(executable, `#!${process.execPath}\nconst fs = require("node:fs");\nconst path = require("node:path");\nconst readline = require("node:readline");\nlet turns = 0;\nconst rl = readline.createInterface({ input: process.stdin });\nrl.on("line", (line) => {\n  const request = JSON.parse(line);\n  if (request.id === undefined) return;\n  if (request.method === "initialize") console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }));\n  else if (request.method === "thread/start") console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { thread: { id: "thread-test" } } }));\n  else if (request.method === "turn/start") {\n    turns += 1;\n    fs.writeFileSync(path.join(process.cwd(), "turn-count"), String(turns));\n    if (turns === 2) console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "running turn rejected" } }));\n    else {\n      console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { turn: { id: "turn-" + turns } } }));\n      console.log(JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-test", turn: { status: "completed" } } }));\n    }\n  }\n});\n`);
    chmodSync(executable, 0o755);
    await mgr.start(agentId, config);
    await waitFor(() => {
      try { return Number(readFileSync(turnCountFile, "utf8")) >= 1; } catch { return false; }
    });

    const meta = { turnId: "turn-running", deliveryId: `turn-running:${agentId}` };
    const rejected = mgr.deliver(agentId, "Alice", "channel-1", false, meta);
    await assert.rejects(rejected, /running turn rejected/);

    const retry = mgr.deliver(agentId, "Alice", "channel-1", false, meta);
    assert.notEqual(retry, rejected, "a protocol-level NACK must clear the durable-id fence");
    await retry;
    await waitFor(() => {
      try { return Number(readFileSync(turnCountFile, "utf8")) >= 3; } catch { return false; }
    });
  } finally {
    mgr.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const terminal of ["raw-error", "legacy-error", "legacy-abort"] as const) test(`Codex ${terminal} releases an admitted turn so the next FIFO delivery runs`, async () => {
  const root = mkdtempSync(path.join(tmpdir(), `open-tag-codex-${terminal}-`));
  const executable = path.join(root, "codex");
  const agentId = `codex-${terminal}`;
  const turnCountFile = path.join(root, agentId, "turn-count");
  const errorGateFile = path.join(root, agentId, "release-error");
  const completionGateFile = path.join(root, agentId, "release-completion");
  const config: AgentConfig = {
    agentId,
    name: "codex",
    displayName: "Codex",
    description: "test",
    runtime: "codex",
    model: "default",
    serverUrl: "http://localhost:7777",
    serverId: "server-1",
    agentToken: "test-token",
  };
  const sent: any[] = [];
  const mgr = new AgentManager((message) => sent.push(message), {
    dataDir: root,
    binDir: root,
    deliverDebounceMs: 0,
    budget: new ResourceBudget({ availableMemMB: () => 999999 }),
    runtimeResolver: () => codexRuntime,
  });
  try {
    writeFileSync(executable, [
      `#!${process.execPath}`,
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const readline = require("node:readline");',
      "let turns = 0;",
      `const terminal = ${JSON.stringify(terminal)};`,
      'const errorGate = path.join(process.cwd(), "release-error");',
      'const completionGate = path.join(process.cwd(), "release-completion");',
      'const response = (request, turnId) => console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { turn: { id: turnId } } }));',
      'const complete = (turnId, status, error) => console.log(JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-test", turn: { id: turnId, status, ...(error ? { error: { message: error } } : {}) } } }));',
      'const afterGate = (gate, fn) => { const timer = setInterval(() => { if (fs.existsSync(gate)) { clearInterval(timer); fn(); } }, 2); };',
      'const rl = readline.createInterface({ input: process.stdin });',
      'rl.on("line", (line) => {',
      "  const request = JSON.parse(line);",
      "  if (request.id === undefined) return;",
      '  if (request.method === "initialize") console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }));',
      '  else if (request.method === "thread/start") console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { thread: { id: "thread-test" } } }));',
      '  else if (request.method === "turn/start") {',
      "    turns += 1;",
      '    fs.writeFileSync(path.join(process.cwd(), "turn-count"), String(turns));',
      '    const turnId = "turn-" + turns;',
      '    if (turns === 2 && terminal === "raw-error") {',
      "      response(request, turnId);",
      "      afterGate(errorGate, () => {",
      '        console.log(JSON.stringify({ jsonrpc: "2.0", method: "error", params: { threadId: "thread-test", turnId, willRetry: false, error: { message: "provider rejected" } } }));',
      '        afterGate(completionGate, () => complete(turnId, "failed", "provider rejected"));',
      "      });",
      '    } else if (turns === 2 && terminal === "legacy-abort") {',
      '      console.log(JSON.stringify({ jsonrpc: "2.0", method: "codex/event", params: { msg: { type: "turn_aborted", turn_id: turnId } } }));',
      "      response(request, turnId);",
      "    } else if (turns === 2) {",
      '      console.log(JSON.stringify({ jsonrpc: "2.0", method: "codex/event", params: { msg: { type: "task_complete", turn_id: turnId, error: { message: "provider rejected" } } } }));',
      "      response(request, turnId);",
      '    } else if (terminal !== "raw-error") {',
      '      if (turns === 3) console.log(JSON.stringify({ jsonrpc: "2.0", method: "codex/event", params: { msg: { type: "turn_aborted", turn_id: "stale-" + turnId } } }));',
      '      console.log(JSON.stringify({ jsonrpc: "2.0", method: "codex/event", params: { msg: { type: "task_complete", turn_id: turnId } } }));',
      "      response(request, turnId);",
      "    } else if (turns === 3) {",
      '      complete("stale-" + turnId, "failed", "late prior failure");',
      '      complete(turnId, "completed");',
      "      response(request, turnId);",
      "    } else {",
      '      complete(turnId, "completed");',
      "      response(request, turnId);",
      "    }",
      "  }",
      "});",
      "",
    ].join("\n"));
    chmodSync(executable, 0o755);
    await mgr.start(agentId, config);
    await waitFor(() => {
      try { return Number(readFileSync(turnCountFile, "utf8")) >= 1; } catch { return false; }
    });

    const failed = mgr.deliver(agentId, "Alice", "channel-1", false, { turnId: `turn-${terminal}-failed` });
    const queued = mgr.deliver(agentId, "Bob", "channel-1", false, { turnId: `turn-${terminal}-queued` });
    let queuedSettled = false;
    void queued.then(() => { queuedSettled = true; }, () => { queuedSettled = true; });
    await failed;
    if (terminal === "raw-error") {
      const replyStartsBeforeError = sent.filter((message) => message.type === "agent:reply" && message.op === "start").length;
      writeFileSync(errorGateFile, "go");
      await waitFor(() => sent.some((message) => message.type === "agent:trajectory"
        && message.entries?.some((entry: any) => entry.text === "[codex error] provider rejected")));
      assert.equal(
        sent.filter((message) => message.type === "agent:reply" && message.op === "start").length,
        replyStartsBeforeError,
        "processing a raw error must not start the queued Turn preview",
      );
      assert.equal(Number(readFileSync(turnCountFile, "utf8")), 2, "a raw error alone must not start the queued Turn");
      assert.equal(queuedSettled, false, "a raw error is diagnostic, not a terminal admission boundary");
      writeFileSync(completionGateFile, "go");
    }
    await waitFor(() => {
      try { return Number(readFileSync(turnCountFile, "utf8")) >= 3; } catch { return false; }
    });
    await queued;
    const after = mgr.deliver(agentId, "Carol", "channel-1", false, { turnId: `turn-${terminal}-after` });
    await waitFor(() => {
      try { return Number(readFileSync(turnCountFile, "utf8")) >= 4; } catch { return false; }
    });
    await after;
    const activities = sent.filter((message) => message.type === "agent:activity");
    assert.equal(activities.filter((message) => message.activity === "error").length, 1, "the failed Turn has one visible terminal error");
    assert.equal(activities.at(-1)?.activity, "online", "later successful Turns restore online readiness");
    if (terminal !== "raw-error") assert.equal(activities.some((message) => message.detail === "starting"), false, "a terminal initial Turn must not be overwritten by late startup Activity");
  } finally {
    mgr.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});

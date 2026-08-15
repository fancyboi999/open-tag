import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildHermesArgs, buildHermesPrompt, hermesBridgeDecision, hermesProfile, hermesProfileHome, hermesRuntime, hermesRuntimeEnv, parseHermesSessionId, parseHermesTurnEvents, postHermesBridgeMessage } from "./hermesRuntime.js";
import { discoverHermesProfilesFromRoots } from "./listModels.js";

const PATH_KEY = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";

test("Hermes profile comes from runtimeConfig first, then model, then default", () => {
  assert.equal(hermesProfile("codex", { profile: "alpha-helper" }), "alpha-helper");
  assert.equal(hermesProfile("gemini", {}), "gemini");
  assert.equal(hermesProfile("default", {}), "default");
  assert.equal(hermesProfile(undefined, null), "default");
});

test("Hermes CLI args use quiet chat mode for OpenTag", () => {
  assert.deepEqual(buildHermesArgs("hello"), ["chat", "-q", "hello", "-Q", "--source", "open-tag"]);
});

test("Hermes CLI args resume the captured native Hermes session", () => {
  assert.deepEqual(buildHermesArgs("hello", "20260702_221211_1991f1"), ["chat", "-q", "hello", "-Q", "--source", "open-tag", "--resume", "20260702_221211_1991f1"]);
});

test("Hermes session id is parsed from quiet stderr", () => {
  assert.equal(parseHermesSessionId("noise\nsession_id: 20260702_221211_1991f1\n"), "20260702_221211_1991f1");
  assert.equal(parseHermesSessionId("session_id: old\nmore\nsession_id: new"), "new");
  assert.equal(parseHermesSessionId("Session not found: missing"), null);
});

test("Hermes prompt carries OpenTag system prompt, project cwd, state dir, and user message", () => {
  const prompt = buildHermesPrompt("please help", { cwd: "/tmp/project", stateDir: "/tmp/open-tag-agent", systemPrompt: "use open-tag cli" });
  assert.match(prompt, /operator-selected project directory: \/tmp\/project/);
  assert.match(prompt, /OpenTag-owned state directory is: \/tmp\/open-tag-agent/);
  assert.match(prompt, /use open-tag cli/);
  assert.match(prompt, /please help/);
});

test("Hermes profile discovery reads profile dirs with default first, then alphabetical", () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-hermes-"));
  try {
    mkdirSync(path.join(root, "zeta-helper"));
    writeFileSync(path.join(root, "zeta-helper", "SOUL.md"), "# Zeta\n");
    mkdirSync(path.join(root, "alpha-helper"));
    writeFileSync(path.join(root, "alpha-helper", "profile.yaml"), "display_name: Alpha Profile\n");
    mkdirSync(path.join(root, "misc-helper"));
    writeFileSync(path.join(root, "misc-helper", "config.yaml"), "name: Misc Helper\n");
    mkdirSync(path.join(root, "not-a-profile"));

    const profiles = discoverHermesProfilesFromRoots([root]);
    assert.deepEqual(profiles.map((p) => p.id), ["default", "alpha-helper", "misc-helper", "zeta-helper"]);
    assert.equal(profiles[0]?.label, "Default profile");
    assert.equal(profiles[0]?.default, true);
    assert.equal(profiles[1]?.label, "Alpha Profile");
    assert.equal(profiles[2]?.label, "Misc Helper");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Hermes profile home resolves named profiles without changing global defaults", () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-hermes-home-"));
  try {
    mkdirSync(path.join(root, ".hermes", "profiles", "alpha-helper"), { recursive: true });
    assert.equal(hermesProfileHome("alpha-helper", root), path.join(root, ".hermes", "profiles", "alpha-helper"));
    assert.equal(hermesProfileHome("missing", root), null);
    assert.equal(hermesProfileHome("default", root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Hermes runtime default profile clears inherited profile env", () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-hermes-env-"));
  try {
    const inheritedHome = path.join(root, "old-home");
    const { env, profile } = hermesRuntimeEnv({ HERMES_HOME: inheritedHome, HERMES_PROFILE: "old-profile" }, root, "default", root);
    assert.equal(profile, "default");
    assert.equal(env.HERMES_HOME, undefined);
    assert.equal(env.HERMES_PROFILE, undefined);
    assert.equal(env.PWD, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Hermes runtime resolves profiles from HERMES_PROFILE_DIR as well as ~/.hermes/profiles", () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-hermes-profile-dir-"));
  try {
    const customProfiles = path.join(root, "custom-profiles");
    mkdirSync(path.join(customProfiles, "custom-helper"), { recursive: true });
    const { env, profile } = hermesRuntimeEnv({ HERMES_PROFILE_DIR: customProfiles }, root, "custom-helper", root);
    assert.equal(profile, "custom-helper");
    assert.equal(env.HERMES_HOME, path.join(customProfiles, "custom-helper"));
    assert.equal(env.HERMES_PROFILE, "custom-helper");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Hermes final response bridge requires a checked reply trigger and filters unsafe stdout", () => {
  const checked = parseHermesTurnEvents(JSON.stringify({ type: "check", target: "dm:@User", count: 1, messageId: "1234abcd", grant: "primary" }));
  assert.deepEqual(checked, { sent: false, held: false, checked: true, checkCount: 1, engaged: true, target: "dm:@User", messageId: "1234abcd", grant: "primary" });
  assert.deepEqual(hermesBridgeDecision("⚠ scanner warning\n\nI handled that.", checked), {
    ok: true,
    target: "dm:@User",
    content: "I handled that.",
    replyTo: "1234abcd",
    hasGrant: true,
  });

  assert.deepEqual(hermesBridgeDecision("I handled that.", parseHermesTurnEvents("")), {
    ok: false,
    reason: "no-open-tag-read",
  });
  assert.deepEqual(hermesBridgeDecision("I handled that.", parseHermesTurnEvents(JSON.stringify({ type: "check", target: "dm:@User", count: 1 }))), {
    ok: false,
    reason: "no-reply-trigger",
  });
  assert.equal(hermesBridgeDecision("My assigned slice.", parseHermesTurnEvents(JSON.stringify({
    type: "check", target: "#all", count: 1, messageId: "5678abcd", grant: "directed",
  }))).ok, true);
  assert.equal(hermesBridgeDecision("Error: provider rejected the request", checked).ok, false);
  assert.equal(hermesBridgeDecision("┊ review diff\na/MEMORY.md → b/MEMORY.md\n@@ -1 +1", checked).ok, false);
});

test("Hermes treats a recorded empty inbox check as a successful no-op turn", () => {
  const empty = parseHermesTurnEvents(JSON.stringify({ type: "check", count: 0 }));
  assert.deepEqual(empty, { sent: false, held: false, checked: true, checkCount: 0, engaged: false, target: null });
  assert.deepEqual(hermesBridgeDecision("No new messages were waiting. Standing by.", empty), {
    ok: false,
    reason: "empty-inbox",
  });
});

test("Hermes final response bridge avoids double posting after explicit send or hold", () => {
  const sent = parseHermesTurnEvents([
    JSON.stringify({ type: "check", target: "dm:@User", count: 1 }),
    JSON.stringify({ type: "send", target: "dm:@User", seq: 12 }),
  ].join("\n"));
  assert.deepEqual(hermesBridgeDecision("Already sent.", sent), { ok: false, reason: "already-sent" });

  const held = parseHermesTurnEvents(JSON.stringify({ type: "held", target: "dm:@User" }));
  assert.deepEqual(hermesBridgeDecision("Freshness hold: showing latest 1 of 1 newer message.", held), { ok: false, reason: "already-held" });
});

test("Hermes bridge does not auto-submit a freshness-held draft", async () => {
  const calls: unknown[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push(body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ held: true, draft: true }),
    } as Response;
  };

  const result = await postHermesBridgeMessage(fetchImpl, "http://server", { authorization: "Bearer t", "x-agent-id": "a", "content-type": "application/json" }, "dm:@User", "Final answer");

  assert.deepEqual(result, { ok: false, held: true, sentDraft: false });
  assert.deepEqual(calls, [
    { target: "dm:@User", content: "Final answer" },
  ]);
});

test("Hermes rejects initial admission exactly once when its argv process cannot spawn", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-hermes-missing-"));
  const admissions: Array<Error | undefined> = [];
  let session: ReturnType<typeof hermesRuntime.start> | undefined;
  try {
    session = hermesRuntime.start({ cwd: root, stateDir: root, env: { [PATH_KEY]: root }, systemPrompt: "system", initialPrompt: "start" }, {
      onSession: () => {},
      onInitialTurnAdmission: (error) => admissions.push(error),
      onAcceptedTurnFailure: () => {},
      onActivity: () => {},
      onTrajectory: () => {},
      onExit: () => {},
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
    });
    const runningDelivery = assert.rejects(session.deliver("queued after initial input"));
    const deadline = Date.now() + 1_000;
    while (admissions.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(admissions.length, 1);
    assert.ok(admissions[0] instanceof Error);
    await runningDelivery;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(admissions.length, 1);
  } finally {
    session?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Hermes completes an empty-inbox turn so a queued delivery can run", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-hermes-empty-inbox-"));
  const binDir = path.join(root, "bin");
  mkdirSync(binDir);
  if (process.platform === "win32") {
    writeFileSync(path.join(binDir, "hermes.cmd"), [
      "@echo off",
      "echo {\"type\":\"check\",\"count\":0}>>\"%OPEN_TAG_TURN_FILE%\"",
      "echo No new open-tag messages were waiting. Standing by.",
      "exit /b 0",
    ].join("\r\n"), "utf8");
  } else {
    writeFileSync(path.join(binDir, "hermes"), [
      "#!/bin/sh",
      "printf '%s\\n' '{\"type\":\"check\",\"count\":0}' >> \"$OPEN_TAG_TURN_FILE\"",
      "printf '%s\\n' 'No new open-tag messages were waiting. Standing by.'",
      "exit 0",
    ].join("\n"), { mode: 0o755 });
  }
  const activities: string[] = [];
  let session: ReturnType<typeof hermesRuntime.start> | undefined;
  try {
    session = hermesRuntime.start({
      cwd: root,
      stateDir: root,
      env: { [PATH_KEY]: binDir, HOME: root },
      systemPrompt: "system",
      initialPrompt: "start",
    }, {
      onSession: () => {},
      onInitialTurnAdmission: () => {},
      onAcceptedTurnFailure: () => {},
      onActivity: (activity) => activities.push(activity),
      onTrajectory: () => {},
      onExit: () => {},
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
    });
    await session.deliver("queued delivery");
    const deadline = Date.now() + 1_000;
    while (activities.filter((activity) => activity === "online").length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(activities.filter((activity) => activity === "working").length, 2);
    assert.equal(activities.filter((activity) => activity === "online").length, 2);
    assert.equal(activities.includes("error"), false);
  } finally {
    session?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Hermes stop during its async response bridge emits only the exit terminal", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-hermes-stop-bridge-"));
  const binDir = path.join(root, "bin");
  mkdirSync(binDir);
  if (process.platform === "win32") {
    writeFileSync(path.join(binDir, "hermes.cmd"), [
      "@echo off",
      "echo {\"type\":\"check\",\"target\":\"dm:@User\",\"count\":1,\"messageId\":\"1234abcd\",\"grant\":\"primary\"}>>\"%OPEN_TAG_TURN_FILE%\"",
      "echo Final answer.",
      "exit /b 0",
    ].join("\r\n"), "utf8");
  } else {
    const executable = path.join(binDir, "hermes");
    writeFileSync(executable, [
      "#!/bin/sh",
      "printf '%s\\n' '{\"type\":\"check\",\"target\":\"dm:@User\",\"count\":1,\"messageId\":\"1234abcd\",\"grant\":\"primary\"}' >> \"$OPEN_TAG_TURN_FILE\"",
      "printf '%s\\n' 'Final answer.'",
      "exit 0",
    ].join("\n"), "utf8");
    chmodSync(executable, 0o755);
  }

  const originalFetch = globalThis.fetch;
  let markFetchStarted!: () => void;
  const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
  let releaseFetch!: () => void;
  globalThis.fetch = (() => {
    markFetchStarted();
    return new Promise<Response>((resolve) => {
      releaseFetch = () => resolve({ ok: false, status: 500, json: async () => ({ error: "bridge failed" }) } as Response);
    });
  }) as typeof fetch;
  const activities: string[] = [];
  const failures: number[] = [];
  const exits: Array<number | null> = [];
  let session: ReturnType<typeof hermesRuntime.start> | undefined;
  try {
    session = hermesRuntime.start({
      cwd: root,
      stateDir: root,
      env: { [PATH_KEY]: binDir, HOME: root, OPEN_TAG_SERVER_URL: "http://server", OPEN_TAG_AGENT_ID: "a", OPEN_TAG_AGENT_TOKEN: "t" },
      systemPrompt: "system",
      initialPrompt: "start",
    }, {
      onSession: () => {},
      onInitialTurnAdmission: () => {},
      onAcceptedTurnFailure: () => failures.push(failures.length + 1),
      onActivity: (activity) => activities.push(activity),
      onTrajectory: () => {},
      onExit: (code) => exits.push(code),
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
    });
    await fetchStarted;
    const activityCountAtStop = activities.length;
    session.stop();
    releaseFetch();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(exits, [0]);
    assert.deepEqual(failures, [], "a stopped session cannot also report a reusable Turn failure");
    assert.equal(activities.length, activityCountAtStop, "the completed bridge cannot emit Activity after stop");
  } finally {
    globalThis.fetch = originalFetch;
    session?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

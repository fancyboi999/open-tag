import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentManager, type AgentConfig } from "./agentManager.js";
import { ResourceBudget } from "./resourceBudget.js";
import type { Runtime, RuntimeCallbacks, StartOpts } from "./runtime.js";

const noPressureBudget = new ResourceBudget({ availableMemMB: () => 999999 });

const baseConfig = (agentId: string): AgentConfig => ({
  agentId,
  name: "agent",
  displayName: "Agent",
  description: "test agent",
  runtime: "fake",
  model: "default",
  serverUrl: "http://localhost:7777",
  serverId: "server-1",
  agentToken: "test-token",
});

test("agent control operations are serialized per agent and recover after a failure", async () => {
  const mgr = new AgentManager(() => {}, { budget: noPressureBudget, runtimeResolver: () => null });
  let releaseReset!: () => void;
  let markResetStarted!: () => void;
  const resetBlocked = new Promise<void>((resolve) => { releaseReset = resolve; });
  const resetStarted = new Promise<void>((resolve) => { markResetStarted = resolve; });
  const events: string[] = [];

  const reset = mgr.runControl("agent-control", async () => {
    events.push("reset:start");
    markResetStarted();
    await resetBlocked;
    events.push("reset:done");
  });
  const start = mgr.runControl("agent-control", async () => { events.push("start"); });

  await resetStarted;
  assert.deepEqual(events, ["reset:start"], "start must not overlap an unfinished reset");
  releaseReset();
  await Promise.all([reset, start]);
  assert.deepEqual(events, ["reset:start", "reset:done", "start"]);

  await assert.rejects(
    mgr.runControl("agent-control", async () => { throw new Error("reset failed"); }),
    /reset failed/,
  );
  await mgr.runControl("agent-control", async () => { events.push("after-failure"); });
  assert.equal(events.at(-1), "after-failure", "one failed control must not poison later controls");
});

test("stop resolves only after the stopped runtime reports exit", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-stop-settle-"));
  let callbacks!: RuntimeCallbacks;
  const fakeRuntime: Runtime = {
    name: "fake",
    start(_opts, cb) {
      callbacks = cb;
      cb.onInitialTurnAdmission();
      return { deliver: async () => {}, stop: () => {} };
    },
  };
  try {
    const mgr = new AgentManager(() => {}, { dataDir: root, binDir: root, budget: noPressureBudget, runtimeResolver: () => fakeRuntime });
    await mgr.start("agent-stop-settle", baseConfig("agent-stop-settle"));
    let stopped = false;
    const stopping = Promise.resolve(mgr.stop("agent-stop-settle")).then(() => { stopped = true; });
    await Promise.resolve();
    assert.equal(stopped, false, "stop ACK must wait for the old process exit");
    callbacks.onExit(0);
    await stopping;
    assert.equal(stopped, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reset does not wipe the workspace until the old runtime reports exit", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-reset-settle-"));
  let callbacks!: RuntimeCallbacks;
  const fakeRuntime: Runtime = {
    name: "fake",
    start(_opts, cb) {
      callbacks = cb;
      cb.onInitialTurnAdmission();
      return { deliver: async () => {}, stop: () => {} };
    },
  };
  try {
    const mgr = new AgentManager(() => {}, { dataDir: root, binDir: root, budget: noPressureBudget, runtimeResolver: () => fakeRuntime });
    const agentId = "agent-reset-settle";
    await mgr.start(agentId, baseConfig(agentId));
    const marker = path.join(root, agentId, "marker.txt");
    writeFileSync(marker, "old runtime workspace");
    const resetting = mgr.reset(agentId, true, false);
    await Promise.resolve();
    assert.equal(existsSync(marker), true, "workspace cleanup must wait for old process exit");
    callbacks.onExit(0);
    await resetting;
    assert.equal(existsSync(path.join(root, agentId)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("start rejects when the runtime exits before initial turn admission", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-start-admission-"));
  const fakeRuntime: Runtime = {
    name: "fake",
    start(_opts, cb) {
      queueMicrotask(() => cb.onExit(1));
      return { deliver: async () => {}, stop: () => {} };
    },
  };
  try {
    const mgr = new AgentManager(() => {}, { dataDir: root, binDir: root, budget: noPressureBudget, runtimeResolver: () => fakeRuntime });
    await assert.rejects(mgr.start("agent-start-admission", baseConfig("agent-start-admission")), /exited before initial turn admission/);
    assert.deepEqual(mgr.running(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a late exit callback from an old runtime cannot delete a replacement instance", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-exit-owner-"));
  const callbacks: RuntimeCallbacks[] = [];
  const fakeRuntime: Runtime = {
    name: "fake",
    start(_opts, cb) {
      callbacks.push(cb);
      cb.onInitialTurnAdmission();
      return { deliver: async () => {}, stop: () => {} };
    },
  };
  try {
    const mgr = new AgentManager(() => {}, { dataDir: root, binDir: root, budget: noPressureBudget, runtimeResolver: () => fakeRuntime });
    await mgr.start("agent-exit-owner", baseConfig("agent-exit-owner"));
    void mgr.stop("agent-exit-owner");
    await mgr.start("agent-exit-owner", baseConfig("agent-exit-owner"));
    assert.deepEqual(mgr.running(), ["agent-exit-owner"]);
    callbacks[0]!.onExit(0);
    assert.deepEqual(mgr.running(), ["agent-exit-owner"], "old onExit must not remove the replacement");
    callbacks[1]!.onExit(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deliver received during async start is consumed by the wake nudge, not re-delivered as a notice", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-"));
  const delivered: string[] = [];
  const sent: any[] = [];
  let initialPrompt: string | undefined;
  const fakeRuntime: Runtime = {
    name: "fake",
    start(opts: StartOpts, cb: RuntimeCallbacks) {
      initialPrompt = opts.initialPrompt;
      cb.onSession("fake-session");
      cb.onInitialTurnAdmission();
      cb.onActivity("online");
      return { deliver: async (text) => { delivered.push(text); }, stop: () => {} };
    },
  };

  try {
    const mgr = new AgentManager((msg) => sent.push(msg), {
      dataDir: root,
      binDir: root,
      deliverDebounceMs: 0,
      budget: noPressureBudget,
      runtimeResolver: () => fakeRuntime,
    });
    const start = mgr.start("agent-1", baseConfig("agent-1"));
    const delivery = mgr.deliver("agent-1", "User", "dm:agent-1", true, {
      targetName: "dm:Agent", msgShort: "m1", turnId: "turn-startup", deliveryId: "turn-startup:agent-1",
    });
    await start;
    await delivery;
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The startup nudge itself drives the "check inbox" turn — the queued deliver
    // must not produce a second in-session notice (that caused double replies).
    assert.equal(delivered.length, 0);
    assert.match(initialPrompt ?? "", /open-tag message check/);
    // The reply preview still starts so the UI shows "agent is replying…".
    const previewStart = sent.find((m) => m?.type === "agent:reply" && m?.op === "start");
    assert.ok(previewStart, "expected an agent:reply start preview");
    assert.equal(previewStart.channelId, "dm:agent-1");
    mgr.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deliver while the agent is running still produces a batched inbox notice", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-"));
  const delivered: string[] = [];
  const fakeRuntime: Runtime = {
    name: "fake",
    start(_opts: StartOpts, cb: RuntimeCallbacks) {
      cb.onSession("fake-session");
      cb.onInitialTurnAdmission();
      cb.onActivity("online");
      return { deliver: async (text) => { delivered.push(text); }, stop: () => {} };
    },
  };

  try {
    const mgr = new AgentManager(() => {}, {
      dataDir: root,
      binDir: root,
      deliverDebounceMs: 0,
      budget: noPressureBudget,
      runtimeResolver: () => fakeRuntime,
    });
    await mgr.start("agent-1", baseConfig("agent-1"));
    mgr.deliver("agent-1", "User", "dm:agent-1", true, { targetName: "dm:Agent", msgShort: "m1" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(delivered.length, 1);
    assert.match(delivered[0]!, /inbox notice/);
    assert.match(delivered[0]!, /dm:Agent/);
    mgr.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("server-authored conversation turns stay isolated, skip legacy debounce, and execute serially", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-"));
  const delivered: string[] = [];
  let callbacks: RuntimeCallbacks | undefined;
  const fakeRuntime: Runtime = {
    name: "fake",
    start(_opts: StartOpts, cb: RuntimeCallbacks) {
      callbacks = cb;
      cb.onSession("fake-session");
      cb.onInitialTurnAdmission();
      cb.onActivity("online");
      return { deliver: async (text) => { delivered.push(text); }, stop: () => {} };
    },
  };

  try {
    const mgr = new AgentManager(() => {}, {
      dataDir: root,
      binDir: root,
      deliverDebounceMs: 3_000,
      budget: noPressureBudget,
      runtimeResolver: () => fakeRuntime,
    });
    await mgr.start("agent-turns", baseConfig("agent-turns"));
    const alice = mgr.deliver("agent-turns", "Alice", "channel-1", false, { targetName: "#all", msgShort: "a1", turnId: "turn-alice", turnMessageCount: 2, attention: "assigned" });
    const bob = mgr.deliver("agent-turns", "Bob", "channel-1", false, { targetName: "#all", msgShort: "b1", turnId: "turn-bob", turnMessageCount: 1, attention: "assigned" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(delivered.length, 1, "a second server Turn cannot interrupt the active runtime Turn");
    assert.match(delivered[0]!, /latest @Alice/);
    assert.match(delivered[0]!, /pending: 2 items/);
    assert.match(delivered[0]!, /attention=assigned/);
    await alice;

    callbacks!.onActivity("online");
    await bob;
    assert.equal(delivered.length, 2, "different sender-scoped Turns remain distinct after FIFO admission");
    assert.match(delivered[1]!, /latest @Bob/);
    assert.match(delivered[1]!, /pending: 1 item/);
    assert.match(delivered[1]!, /attention=assigned/);
    callbacks!.onActivity("online");
    mgr.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a delivery arriving during the startup nudge waits for that runtime turn to finish", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-"));
  const delivered: string[] = [];
  let callbacks: RuntimeCallbacks | undefined;
  const fakeRuntime: Runtime = {
    name: "fake",
    start(_opts: StartOpts, cb: RuntimeCallbacks) {
      callbacks = cb;
      cb.onSession("fake-session");
      cb.onInitialTurnAdmission();
      return { deliver: async (text) => { delivered.push(text); }, stop: () => {} };
    },
  };

  try {
    const mgr = new AgentManager(() => {}, { dataDir: root, binDir: root, deliverDebounceMs: 0, budget: noPressureBudget, runtimeResolver: () => fakeRuntime });
    await mgr.start("agent-startup-turn", baseConfig("agent-startup-turn"));
    const admission = mgr.deliver("agent-startup-turn", "Alice", "channel-1", false, { turnId: "turn-after-start", deliveryId: "turn-after-start:agent-startup-turn" });
    let admitted = false;
    void admission.then(() => { admitted = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(delivered.length, 0, "the startup nudge still owns the runtime turn");
    assert.equal(admitted, false, "server admission remains pending while startup work runs");

    callbacks!.onActivity("online");
    await admission;
    assert.equal(delivered.length, 1, "the queued Turn starts after startup reaches online");
    mgr.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an admitted terminal failure advances FIFO without treating every runtime error as terminal", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-"));
  const delivered: string[] = [];
  let callbacks: RuntimeCallbacks | undefined;
  const fakeRuntime: Runtime = {
    name: "fake",
    start(_opts: StartOpts, cb: RuntimeCallbacks) {
      callbacks = cb;
      cb.onSession("fake-session");
      cb.onInitialTurnAdmission();
      cb.onActivity("online");
      return { deliver: async (text) => { delivered.push(text); }, stop: () => {} };
    },
  };

  try {
    const mgr = new AgentManager(() => {}, { dataDir: root, binDir: root, deliverDebounceMs: 0, budget: noPressureBudget, runtimeResolver: () => fakeRuntime });
    await mgr.start("agent-error-fifo", baseConfig("agent-error-fifo"));
    const first = mgr.deliver("agent-error-fifo", "Alice", "channel-1", false, { turnId: "turn-error-a" });
    const second = mgr.deliver("agent-error-fifo", "Bob", "channel-1", false, { turnId: "turn-error-b" });
    await first;
    assert.equal(delivered.length, 1);

    callbacks!.onActivity("error", "turn failed");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(delivered.length, 1, "non-terminal runtime error must not start the next Turn early");
    callbacks!.onAcceptedTurnFailure();
    await second;
    assert.equal(delivered.length, 2, "the dedicated failure terminal advances queued work once");
    mgr.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable delivery waits for the server commit barrier before touching a hot runtime", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-commit-"));
  const delivered: string[] = [];
  let releaseCommit!: () => void;
  const committed = new Promise<void>((resolve) => { releaseCommit = resolve; });
  const ready: Array<{ agentId: string; deliveryId?: string; seq?: number }> = [];
  const sent: any[] = [];
  const fakeRuntime: Runtime = {
    name: "fake",
    start(_opts: StartOpts, cb: RuntimeCallbacks) {
      cb.onInitialTurnAdmission();
      cb.onActivity("online");
      return { deliver: async (text) => { delivered.push(text); }, stop: () => {} };
    },
  };
  try {
    const mgr = new AgentManager((message) => sent.push(message), {
      dataDir: root, binDir: root, budget: noPressureBudget, runtimeResolver: () => fakeRuntime,
      beforeRuntimeDelivery: async (agentId, meta) => { ready.push({ agentId, deliveryId: meta.deliveryId, seq: meta.seq }); await committed; },
    });
    await mgr.start("agent-commit", baseConfig("agent-commit"));
    const admission = mgr.deliver("agent-commit", "Alice", "channel-1", false, {
      turnId: "turn-commit", deliveryId: "turn-commit:agent-commit", seq: 42,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(ready, [{ agentId: "agent-commit", deliveryId: "turn-commit:agent-commit", seq: 42 }]);
    assert.equal(delivered.length, 0, "runtime notice must remain behind the durable server commit");
    assert.equal(sent.some((message) => message.type === "agent:reply"), false, "Activity preview must remain behind the durable server commit");
    releaseCommit();
    await admission;
    assert.equal(delivered.length, 1);
    assert.equal(sent.filter((message) => message.type === "agent:reply" && message.op === "start").length, 1);
    mgr.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rejected server commit creates no runtime work or Activity preview", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-commit-reject-"));
  const sent: any[] = [];
  let deliveries = 0;
  const fakeRuntime: Runtime = {
    name: "fake",
    start(_opts: StartOpts, cb: RuntimeCallbacks) {
      cb.onInitialTurnAdmission();
      cb.onActivity("online");
      return { deliver: async () => { deliveries++; }, stop: () => {} };
    },
  };
  try {
    const mgr = new AgentManager((message) => sent.push(message), {
      dataDir: root, binDir: root, budget: noPressureBudget, runtimeResolver: () => fakeRuntime,
      beforeRuntimeDelivery: async () => { throw new Error("server rejected admission"); },
    });
    await mgr.start("agent-commit-reject", baseConfig("agent-commit-reject"));
    await assert.rejects(
      mgr.deliver("agent-commit-reject", "Alice", "channel-1", false, {
        turnId: "turn-commit-reject", deliveryId: "turn-commit-reject:agent-commit-reject", seq: 43,
      }),
      /server rejected admission/,
    );
    assert.equal(deliveries, 0);
    assert.equal(sent.some((message) => message.type === "agent:reply"), false);
    mgr.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable preparations preserve arrival order even when storage lookup could reorder", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-order-"));
  const lookups: string[] = [];
  let releaseFirst!: () => void;
  const firstLookup = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const fakeRuntime: Runtime = {
    name: "fake",
    start(_opts: StartOpts, cb: RuntimeCallbacks) {
      cb.onInitialTurnAdmission();
      cb.onActivity("online");
      return { deliver: async () => {}, stop: () => {} };
    },
  };
  try {
    const mgr = new AgentManager(() => {}, { dataDir: root, binDir: root, budget: noPressureBudget, runtimeResolver: () => fakeRuntime });
    const store = (mgr as any).deliveryAdmissionStore;
    store.has = async (deliveryId: string) => {
      lookups.push(deliveryId);
      if (deliveryId.startsWith("turn-first:")) await firstLookup;
      return false;
    };
    store.remember = async () => {};
    const first = mgr.deliver("agent-order", "Alice", "channel-1", false, { turnId: "turn-first", deliveryId: "turn-first:agent-order" });
    const second = mgr.deliver("agent-order", "Bob", "channel-1", false, { turnId: "turn-second", deliveryId: "turn-second:agent-order" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(lookups, ["turn-first:agent-order"], "second preparation cannot overtake a blocked first lookup");
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(lookups, ["turn-first:agent-order", "turn-second:agent-order"]);
    await mgr.start("agent-order", baseConfig("agent-order"));
    await Promise.all([first, second]);
    mgr.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a second turn queues its Activity preview until the first runtime turn finishes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-"));
  const sent: any[] = [];
  const delivered: string[] = [];
  let callbacks: RuntimeCallbacks | undefined;
  const fakeRuntime: Runtime = {
    name: "fake",
    start(_opts: StartOpts, cb: RuntimeCallbacks) {
      callbacks = cb;
      cb.onSession("fake-session");
      cb.onInitialTurnAdmission();
      cb.onActivity("online");
      return { deliver: async (text) => { delivered.push(text); }, stop: () => {} };
    },
  };

  try {
    const mgr = new AgentManager((message) => sent.push(message), {
      dataDir: root,
      binDir: root,
      deliverDebounceMs: 0,
      budget: noPressureBudget,
      runtimeResolver: () => fakeRuntime,
    });
    await mgr.start("agent-preview", baseConfig("agent-preview"));
    const first = mgr.deliver("agent-preview", "Alice", "channel-1", false, { turnId: "turn-a", streamId: "stream-a" });
    const second = mgr.deliver("agent-preview", "Bob", "channel-1", false, { turnId: "turn-b", streamId: "stream-b" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const beforeSettlement = sent.filter((message) => message.type === "agent:reply");
    assert.deepEqual(beforeSettlement.map((message) => [message.streamId, message.op]), [["stream-a", "start"]]);
    assert.equal(delivered.length, 1, "the busy runtime must not receive the second Turn before the first result");
    await first;
    let secondAdmitted = false;
    void second.then(() => { secondAdmitted = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(secondAdmitted, false, "queued Turn admission must remain pending until runtime protocol acceptance");

    callbacks!.onTrajectory([{ kind: "text", text: "alice work" }]);
    callbacks!.onActivity("online");
    await second;
    assert.equal(delivered.length, 2, "the second Turn starts only after the first runtime result");
    callbacks!.onTrajectory([{ kind: "text", text: "bob work" }]);
    const replies = sent.filter((message) => message.type === "agent:reply");
    assert.deepEqual(replies.map((message) => [message.streamId, message.op]), [
      ["stream-a", "start"], ["stream-a", "done"], ["stream-b", "start"],
    ]);
    const trajectories = sent.filter((message) => message.type === "agent:trajectory");
    assert.deepEqual(trajectories.map((message) => [message.streamId, message.entries[0].text]), [
      ["stream-a", "alice work"], ["stream-b", "bob work"],
    ]);
    mgr.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("duplicate durable delivery ids do not enqueue the same work twice", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-"));
  const delivered: string[] = [];
  const fakeRuntime: Runtime = {
    name: "fake",
    start(_opts: StartOpts, cb: RuntimeCallbacks) {
      cb.onSession("fake-session");
      cb.onInitialTurnAdmission();
      cb.onActivity("online");
      return { deliver: async (text) => { delivered.push(text); }, stop: () => {} };
    },
  };
  try {
    const mgr = new AgentManager(() => {}, { dataDir: root, binDir: root, deliverDebounceMs: 0, budget: noPressureBudget, runtimeResolver: () => fakeRuntime });
    await mgr.start("agent-dedupe", baseConfig("agent-dedupe"));
    const meta = { turnId: "turn-a", streamId: "stream-a", deliveryId: "turn-a:agent-dedupe" };
    const first = mgr.deliver("agent-dedupe", "Alice", "channel-1", false, meta);
    const concurrentRetry = mgr.deliver("agent-dedupe", "Alice", "channel-1", false, meta);
    await Promise.all([first, concurrentRetry]);
    assert.equal(delivered.length, 1);

    const ackLossRetry = mgr.deliver("agent-dedupe", "Alice", "channel-1", false, meta);
    await ackLossRetry;
    assert.equal(delivered.length, 1, "an ACK-loss retry must not execute admitted work again");
    mgr.stopAll();

    const restarted = new AgentManager(() => {}, { dataDir: root, binDir: root, deliverDebounceMs: 0, budget: noPressureBudget, runtimeResolver: () => fakeRuntime });
    await restarted.start("agent-dedupe", baseConfig("agent-dedupe"));
    await restarted.deliver("agent-dedupe", "Alice", "channel-1", false, meta);
    assert.equal(delivered.length, 1, "a daemon process replacement must restore the successful delivery fence from disk");
    restarted.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("running delivery resolves only after the runtime accepts the inbox notice", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-"));
  const delivered: string[] = [];
  const fakeRuntime: Runtime = {
    name: "fake",
    start(_opts: StartOpts, cb: RuntimeCallbacks) {
      cb.onSession("fake-session");
      cb.onInitialTurnAdmission();
      cb.onActivity("online");
      return { deliver: async (text) => { delivered.push(text); }, stop: () => {} };
    },
  };
  try {
    const mgr = new AgentManager(() => {}, { dataDir: root, binDir: root, deliverDebounceMs: 25, budget: noPressureBudget, runtimeResolver: () => fakeRuntime });
    await mgr.start("agent-admit", baseConfig("agent-admit"));

    let settled = false;
    const admission = mgr.deliver("agent-admit", "Alice", "channel-1", false, { turnId: "turn-admit", deliveryId: "turn-admit:agent-admit" });
    void admission.finally(() => { settled = true; });
    assert.equal(settled, false);
    assert.equal(delivered.length, 0);

    await admission;
    assert.equal(settled, true);
    assert.equal(delivered.length, 1);
    mgr.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed runtime delivery rejects admission, clears the fence, and permits retry", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-"));
  let attempts = 0;
  const fakeRuntime: Runtime = {
    name: "fake",
    start(_opts: StartOpts, cb: RuntimeCallbacks) {
      cb.onSession("fake-session");
      cb.onInitialTurnAdmission();
      cb.onActivity("online");
      return {
        deliver: async () => {
          attempts++;
          if (attempts === 1) throw new Error("runtime rejected notice");
        },
        stop: () => {},
      };
    },
  };
  try {
    const mgr = new AgentManager(() => {}, { dataDir: root, binDir: root, deliverDebounceMs: 0, budget: noPressureBudget, runtimeResolver: () => fakeRuntime });
    await mgr.start("agent-retry", baseConfig("agent-retry"));
    const meta = { turnId: "turn-retry", deliveryId: "turn-retry:agent-retry" };

    const failed = mgr.deliver("agent-retry", "Alice", "channel-1", false, meta);
    await assert.rejects(failed, /runtime rejected notice/);

    const retry = mgr.deliver("agent-retry", "Alice", "channel-1", false, meta);
    assert.notEqual(retry, failed, "a failed delivery must release its durable-id fence");
    await retry;
    assert.equal(attempts, 2);
    mgr.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cold-start delivery resolves only after the startup nudge is accepted", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-"));
  let runtimeStarted = false;
  let callbacks: RuntimeCallbacks | undefined;
  const fakeRuntime: Runtime = {
    name: "fake",
    start(_opts: StartOpts, cb: RuntimeCallbacks) {
      runtimeStarted = true;
      callbacks = cb;
      cb.onSession("fake-session");
      return { deliver: async () => {}, stop: () => {} };
    },
  };
  try {
    const mgr = new AgentManager(() => {}, { dataDir: root, binDir: root, deliverDebounceMs: 0, budget: noPressureBudget, runtimeResolver: () => fakeRuntime });
    const starting = mgr.start("agent-cold", baseConfig("agent-cold"));
    const admission = mgr.deliver("agent-cold", "Alice", "channel-1", false, { turnId: "turn-cold", deliveryId: "turn-cold:agent-cold" });
    let admitted = false;
    void admission.then(() => { admitted = true; });
    assert.equal(runtimeStarted, false);
    assert.equal(admitted, false);

    let startSettled = false;
    void starting.then(() => { startSettled = true; }, () => { startSettled = true; });
    while (!callbacks) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(startSettled, false, "start ACK must wait for startup admission too");
    let duplicateStartSettled = false;
    const duplicateStart = mgr.start("agent-cold", baseConfig("agent-cold")).then(() => { duplicateStartSettled = true; });
    await Promise.resolve();
    assert.equal(duplicateStartSettled, false, "duplicate start must share the in-flight admission result");
    assert.equal(admitted, false, "runtime.start returning is not enough; the startup turn must accept the nudge");
    callbacks!.onActivity("working", "turn");
    callbacks!.onTrajectory([{ kind: "status", text: "runtime activity is not admission" }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(admitted, false, "ordinary Activity and trajectory events must not admit cold-start work");
    callbacks!.onInitialTurnAdmission();
    await Promise.all([starting, duplicateStart, admission]);
    assert.equal(runtimeStarted, true);
    assert.equal(admitted, true);
    mgr.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cold-start failure rejects delivery admission and permits the same id to retry", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-"));
  let starts = 0;
  const fakeRuntime: Runtime = {
    name: "fake",
    start(_opts: StartOpts, cb: RuntimeCallbacks) {
      starts++;
      if (starts === 1) throw new Error("startup nudge rejected");
      cb.onSession("fake-session");
      cb.onInitialTurnAdmission();
      return { deliver: async () => {}, stop: () => {} };
    },
  };
  try {
    const mgr = new AgentManager(() => {}, { dataDir: root, binDir: root, deliverDebounceMs: 0, budget: noPressureBudget, runtimeResolver: () => fakeRuntime });
    const config = baseConfig("agent-cold-retry");
    const firstStart = mgr.start("agent-cold-retry", config);
    const firstDelivery = mgr.deliver("agent-cold-retry", "Alice", "channel-1", false, { turnId: "turn-cold-retry", deliveryId: "turn-cold-retry:agent-cold-retry" });
    await assert.rejects(firstStart, /startup nudge rejected/);
    await assert.rejects(firstDelivery, /startup nudge rejected/);

    const secondStart = mgr.start("agent-cold-retry", config);
    const secondDelivery = mgr.deliver("agent-cold-retry", "Alice", "channel-1", false, { turnId: "turn-cold-retry", deliveryId: "turn-cold-retry:agent-cold-retry" });
    await Promise.all([secondStart, secondDelivery]);
    assert.equal(starts, 2);
    mgr.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stopping before startup admission rejects the delivery and releases its fence", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-"));
  let starts = 0;
  const fakeRuntime: Runtime = {
    name: "fake",
    start(_opts: StartOpts, cb: RuntimeCallbacks) {
      starts++;
      cb.onSession("fake-session");
      if (starts > 1) cb.onInitialTurnAdmission();
      return { deliver: async () => {}, stop: () => cb.onExit(0) };
    },
  };
  try {
    const mgr = new AgentManager(() => {}, { dataDir: root, binDir: root, pendingDeliverTtlMs: 5_000, budget: noPressureBudget, runtimeResolver: () => fakeRuntime });
    const config = baseConfig("agent-stop-retry");
    const meta = { turnId: "turn-stop-retry", deliveryId: "turn-stop-retry:agent-stop-retry" };
    const firstStart = mgr.start("agent-stop-retry", config);
    const firstDelivery = mgr.deliver("agent-stop-retry", "Alice", "channel-1", false, meta);
    while (starts === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    mgr.stopAll();
    await assert.rejects(firstStart, /exited before initial turn admission/);
    await assert.rejects(
      Promise.race([
        firstDelivery,
        new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error("admission remained pending after stop")), 50)),
      ]),
      /stopped before delivery admission/,
    );

    const secondStart = mgr.start("agent-stop-retry", config);
    const secondDelivery = mgr.deliver("agent-stop-retry", "Alice", "channel-1", false, meta);
    assert.notEqual(secondDelivery, firstDelivery);
    await Promise.all([secondStart, secondDelivery]);
    assert.equal(starts, 2);
    mgr.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stopping a running agent rejects buffered delivery admission and permits retry", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-"));
  let delivered = 0;
  const fakeRuntime: Runtime = {
    name: "fake",
    start(_opts: StartOpts, cb: RuntimeCallbacks) {
      cb.onSession("fake-session");
      cb.onInitialTurnAdmission();
      cb.onActivity("online");
      return { deliver: async () => { delivered++; }, stop: () => {} };
    },
  };
  try {
    const mgr = new AgentManager(() => {}, { dataDir: root, binDir: root, deliverDebounceMs: 0, budget: noPressureBudget, runtimeResolver: () => fakeRuntime });
    const config = baseConfig("agent-buffer-stop");
    const meta = { turnId: "turn-buffer-stop", deliveryId: "turn-buffer-stop:agent-buffer-stop" };
    await mgr.start("agent-buffer-stop", config);
    const firstDelivery = mgr.deliver("agent-buffer-stop", "Alice", "channel-1", false, meta);
    mgr.stopAll();
    await assert.rejects(
      Promise.race([
        firstDelivery,
        new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error("buffered admission remained pending after stop")), 50)),
      ]),
      /stopped before delivery admission/,
    );

    await mgr.start("agent-buffer-stop", config);
    const retry = mgr.deliver("agent-buffer-stop", "Alice", "channel-1", false, meta);
    assert.notEqual(retry, firstDelivery);
    await retry;
    assert.equal(delivered, 1);
    mgr.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime exit rejects buffered delivery admission instead of executing it after exit", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-"));
  let callbacks: RuntimeCallbacks | undefined;
  let delivered = 0;
  const fakeRuntime: Runtime = {
    name: "fake",
    start(_opts: StartOpts, cb: RuntimeCallbacks) {
      callbacks = cb;
      cb.onSession("fake-session");
      cb.onInitialTurnAdmission();
      cb.onActivity("online");
      return { deliver: async () => { delivered++; }, stop: () => {} };
    },
  };
  try {
    const mgr = new AgentManager(() => {}, { dataDir: root, binDir: root, deliverDebounceMs: 0, budget: noPressureBudget, runtimeResolver: () => fakeRuntime });
    const config = baseConfig("agent-exit-retry");
    const meta = { turnId: "turn-exit-retry", deliveryId: "turn-exit-retry:agent-exit-retry" };
    await mgr.start("agent-exit-retry", config);
    const firstDelivery = mgr.deliver("agent-exit-retry", "Alice", "channel-1", false, meta);
    callbacks!.onExit(1);
    await assert.rejects(firstDelivery, /runtime exited before delivery admission/);
    assert.equal(delivered, 0);

    await mgr.start("agent-exit-retry", config);
    await mgr.deliver("agent-exit-retry", "Alice", "channel-1", false, meta);
    assert.equal(delivered, 1);
    mgr.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resource-pressure queue waits for runtime admission and dequeue clears its fence", { timeout: 2_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-"));
  let availableMemMB = 0;
  const pressureBudget = new ResourceBudget({ availableMemMB: () => availableMemMB });
  let starts = 0;
  const fakeRuntime: Runtime = {
    name: "fake",
    start(_opts: StartOpts, cb: RuntimeCallbacks) {
      starts++;
      cb.onSession("fake-session");
      cb.onInitialTurnAdmission();
      return { deliver: async () => {}, stop: () => {} };
    },
  };
  try {
    const mgr = new AgentManager(() => {}, { dataDir: root, binDir: root, pendingDeliverTtlMs: 100, budget: pressureBudget, runtimeResolver: () => fakeRuntime });
    await mgr.start("agent-queued", baseConfig("agent-queued"));
    assert.deepEqual(mgr.queuedAgents().map((queued) => queued.agentId), ["agent-queued"]);

    const deliveries = Array.from({ length: 11 }, (_, index) => {
      const meta = { turnId: `turn-queued-${index}`, deliveryId: `turn-queued-${index}:agent-queued` };
      return { meta, admission: mgr.deliver("agent-queued", "Alice", "channel-1", false, meta) };
    });
    const duplicateQueuedSettlement = mgr.deliver("agent-queued", "Alice", "channel-1", false, deliveries[0]!.meta)
      .then(() => "fulfilled", (error) => String(error));
    const saturatedSettlements = Promise.allSettled(deliveries.map(({ admission }) => admission));
    const firstSettlement = await Promise.race(deliveries.map(async ({ admission }) => {
      try {
        await admission;
        return { status: "fulfilled" as const };
      } catch (reason) {
        return { status: "rejected" as const, reason };
      }
    }));
    assert.equal(firstSettlement.status, "rejected");
    assert.match(String(firstSettlement.reason), /pending delivery queue full/);
    assert.equal(starts, 0, "resource queue ownership alone must not start or ACK work");
    mgr.dequeue("agent-queued");
    const settlements = await saturatedSettlements;
    assert.match(await duplicateQueuedSettlement, /dequeued before delivery admission|pending delivery queue full/);
    assert.equal(settlements.filter((result) => result.status === "rejected" && /pending delivery queue full/.test(String(result.reason))).length, 1);
    assert.equal(settlements.filter((result) => result.status === "rejected" && /dequeued before delivery admission/.test(String(result.reason))).length, 10);

    const retryIndex = settlements.findIndex((result) => result.status === "rejected" && /dequeued before delivery admission/.test(String(result.reason)));
    assert.notEqual(retryIndex, -1);
    const retryDelivery = deliveries[retryIndex]!;
    availableMemMB = 999999;
    const restart = mgr.start("agent-queued", baseConfig("agent-queued"));
    const retry = mgr.deliver("agent-queued", "Alice", "channel-1", false, retryDelivery.meta);
    assert.notEqual(retry, retryDelivery.admission, "dequeue must clear the durable fence for a later same-id retry");
    await Promise.all([restart, retry]);
    assert.equal(starts, 1);
    mgr.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one-shot runtime start with pending delivery uses wake nudge without a second notice", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-"));
  const delivered: string[] = [];
  let initialPrompt: string | undefined;
  const fakeRuntime: Runtime = {
    name: "one-shot-test",
    oneShotWake: true,
    start(opts: StartOpts, cb: RuntimeCallbacks) {
      initialPrompt = opts.initialPrompt;
      cb.onSession("one-shot-session");
      cb.onInitialTurnAdmission();
      return { deliver: async (text) => { delivered.push(text); }, stop: () => {} };
    },
  };

  try {
    const mgr = new AgentManager(() => {}, {
      dataDir: root,
      binDir: root,
      deliverDebounceMs: 3000,
      oneShotDeliverDebounceMs: 0,
      budget: noPressureBudget,
      runtimeResolver: () => fakeRuntime,
    });
    const config = { ...baseConfig("agent-2"), runtime: "one-shot-test", sessionId: "existing-session" };
    const start = mgr.start("agent-2", config);
    mgr.deliver("agent-2", "User", "dm:agent-2", true, { targetName: "dm:Agent", msgShort: "m2" });
    await start;
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.match(initialPrompt ?? "", /open-tag message check/);
    assert.match(initialPrompt ?? "", /open-tag message send/);
    assert.equal(delivered.length, 0);
    mgr.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent starts for the same agent are idempotent", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-"));
  let startCount = 0;
  const fakeRuntime: Runtime = {
    name: "fake",
    start(_opts: StartOpts, cb: RuntimeCallbacks) {
      startCount++;
      cb.onSession("fake-session");
      cb.onInitialTurnAdmission();
      return { deliver: async () => {}, stop: () => {} };
    },
  };

  try {
    const mgr = new AgentManager(() => {}, {
      dataDir: root,
      binDir: root,
      budget: noPressureBudget,
      runtimeResolver: () => fakeRuntime,
    });
    await Promise.all([
      mgr.start("agent-2", baseConfig("agent-2")),
      mgr.start("agent-2", baseConfig("agent-2")),
    ]);

    assert.equal(startCount, 1);
    mgr.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stop during workspace preparation cancels start and rejects the pending delivery", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-"));
  let runtimeStarts = 0;
  const fakeRuntime: Runtime = {
    name: "fake",
    start(_opts: StartOpts, cb: RuntimeCallbacks) {
      runtimeStarts++;
      cb.onSession("fake-session");
      cb.onInitialTurnAdmission();
      return { deliver: async () => {}, stop: () => {} };
    },
  };
  try {
    const mgr = new AgentManager(() => {}, { dataDir: root, binDir: root, budget: noPressureBudget, runtimeResolver: () => fakeRuntime });
    const config = baseConfig("agent-cancel-start");
    const meta = { turnId: "turn-cancel-start", deliveryId: "turn-cancel-start:agent-cancel-start" };
    const starting = mgr.start("agent-cancel-start", config);
    const delivery = mgr.deliver("agent-cancel-start", "Alice", "channel-1", false, meta);
    mgr.stop("agent-cancel-start");

    await assert.rejects(starting, /start cancelled/);
    await assert.rejects(delivery, /stopped before delivery admission/);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(runtimeStarts, 0, "cancelled workspace preparation must never reach runtime.start");
    assert.deepEqual(mgr.running(), []);

    const retryStart = mgr.start("agent-cancel-start", config);
    const retryDelivery = mgr.deliver("agent-cancel-start", "Alice", "channel-1", false, meta);
    assert.notEqual(retryDelivery, delivery, "cancellation must clear the durable delivery fence");
    await Promise.all([retryStart, retryDelivery]);
    assert.equal(runtimeStarts, 1);
    mgr.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dequeued start is registered before preparation so a concurrent start cannot double-spawn", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-"));
  let availableMemMB = 999999;
  const budget = new ResourceBudget({ availableMemMB: () => availableMemMB });
  const starts: string[] = [];
  const fakeRuntime: Runtime = {
    name: "fake",
    start(opts: StartOpts, cb: RuntimeCallbacks) {
      starts.push(path.basename(opts.cwd));
      cb.onSession("fake-session");
      cb.onInitialTurnAdmission();
      return { deliver: async () => {}, stop: () => {} };
    },
  };
  try {
    const mgr = new AgentManager(() => {}, { dataDir: root, binDir: root, budget, runtimeResolver: () => fakeRuntime });
    await mgr.start("trigger-agent", baseConfig("trigger-agent"));
    availableMemMB = 0;
    await mgr.start("queued-double-start", baseConfig("queued-double-start"));
    assert.deepEqual(mgr.queuedAgents().map((queued) => queued.agentId), ["queued-double-start"]);

    availableMemMB = 999999;
    mgr.stop("trigger-agent"); // teardown calls tryDequeue(), which begins async workspace preparation
    await mgr.start("queued-double-start", baseConfig("queued-double-start"));
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(starts.filter((agentId) => agentId === "queued-double-start").length, 1);
    mgr.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a cancelled start releases its budget and immediately dequeues the next agent", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-"));
  let availableMemMB = 999999;
  const budget = new ResourceBudget({ availableMemMB: () => availableMemMB });
  const starts: string[] = [];
  const fakeRuntime: Runtime = {
    name: "fake",
    start(opts: StartOpts, cb: RuntimeCallbacks) {
      starts.push(path.basename(opts.cwd));
      cb.onSession("fake-session");
      cb.onInitialTurnAdmission();
      return { deliver: async () => {}, stop: () => {} };
    },
  };
  try {
    const mgr = new AgentManager(() => {}, { dataDir: root, binDir: root, budget, runtimeResolver: () => fakeRuntime });
    const cancelled = mgr.start("cancel-budget", baseConfig("cancel-budget"));
    availableMemMB = 0;
    await mgr.start("next-budget", baseConfig("next-budget"));
    assert.deepEqual(mgr.queuedAgents().map((queued) => queued.agentId), ["next-budget"]);

    availableMemMB = 999999;
    mgr.stop("cancel-budget");
    await assert.rejects(cancelled, /start cancelled/);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(starts, ["next-budget"]);
    assert.deepEqual(mgr.queuedAgents(), []);
    mgr.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reset waits for cancelled startup workspace I/O before wiping the workspace", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-reset-wipe-"));
  let runtimeStarts = 0;
  const fakeRuntime: Runtime = {
    name: "fake",
    start() {
      runtimeStarts++;
      return { deliver: async () => {}, stop: () => {} };
    },
  };
  try {
    const mgr = new AgentManager(() => {}, { dataDir: root, binDir: root, budget: noPressureBudget, runtimeResolver: () => fakeRuntime });
    const agentId = "reset-during-start-wipe";
    const starting = mgr.start(agentId, baseConfig(agentId));
    await Promise.resolve(); // startNow has entered its first async workspace mkdir
    const resetting = mgr.reset(agentId, true, false);
    await assert.rejects(starting, /start cancelled/);
    await resetting;

    assert.equal(runtimeStarts, 0);
    assert.equal(existsSync(path.join(root, agentId)), false, "startup I/O must not recreate a wiped workspace after reset resolves");
    mgr.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reset waits for cancelled startup workspace I/O before writing the final cleared memory", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-reset-memory-"));
  const fakeRuntime: Runtime = {
    name: "fake",
    start() { return { deliver: async () => {}, stop: () => {} }; },
  };
  try {
    const mgr = new AgentManager(() => {}, { dataDir: root, binDir: root, budget: noPressureBudget, runtimeResolver: () => fakeRuntime });
    const agentId = "reset-during-start-memory";
    const starting = mgr.start(agentId, baseConfig(agentId));
    await Promise.resolve(); // overlap reset with workspace preparation, not just the launch microtask
    const resetting = mgr.reset(agentId, false, true);
    await assert.rejects(starting, /start cancelled/);
    await resetting;

    assert.equal(readFileSync(path.join(root, agentId, "MEMORY.md"), "utf8"), "# Memory\n\n(reset)\n");
    mgr.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reset rejects when workspace cleanup fails instead of acknowledging a false success", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-reset-error-"));
  const blockedDataDir = path.join(root, "not-a-directory");
  writeFileSync(blockedDataDir, "file");
  try {
    const mgr = new AgentManager(() => {}, { dataDir: blockedDataDir, binDir: root, budget: noPressureBudget, runtimeResolver: () => null });
    await assert.rejects(mgr.reset("reset-error", false, true), /memory reset failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clearMemory atomically replaces a MEMORY.md symlink without touching its target", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-reset-memory-link-"));
  const agentId = "reset-memory-link";
  const dir = path.join(root, agentId);
  const outside = path.join(root, "outside-memory.md");
  mkdirSync(dir);
  writeFileSync(outside, "outside memory\n");
  symlinkSync(outside, path.join(dir, "MEMORY.md"));
  try {
    const mgr = new AgentManager(() => {}, { dataDir: root, binDir: root, budget: noPressureBudget, runtimeResolver: () => null });
    await mgr.reset(agentId, false, true);

    assert.equal(readFileSync(outside, "utf8"), "outside memory\n");
    assert.equal(lstatSync(path.join(dir, "MEMORY.md")).isSymbolicLink(), false);
    assert.equal(readFileSync(path.join(dir, "MEMORY.md"), "utf8"), "# Memory\n\n(reset)\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncProfile never reads or writes through a MEMORY.md symlink", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-profile-memory-link-"));
  const agentId = "profile-memory-link";
  const dir = path.join(root, agentId);
  const outside = path.join(root, "outside-memory.md");
  mkdirSync(dir);
  writeFileSync(outside, "# Outside\n\n## Role\nsecret\n");
  symlinkSync(outside, path.join(dir, "MEMORY.md"));
  try {
    const mgr = new AgentManager(() => {}, { dataDir: root, binDir: root, budget: noPressureBudget, runtimeResolver: () => null });
    await mgr.syncProfile(agentId, "Changed", "changed role");

    assert.equal(readFileSync(outside, "utf8"), "# Outside\n\n## Role\nsecret\n");
    assert.equal(lstatSync(path.join(dir, "MEMORY.md")).isSymbolicLink(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("start rejects a symlinked agent state directory before writing or spawning", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-state-link-"));
  const outside = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-state-link-outside-"));
  const agentId = "linked-state";
  let starts = 0;
  symlinkSync(outside, path.join(root, agentId), "dir");
  const fakeRuntime: Runtime = {
    name: "fake",
    start() { starts++; return { deliver: async () => {}, stop: () => {} }; },
  };
  try {
    const mgr = new AgentManager(() => {}, { dataDir: root, binDir: root, budget: noPressureBudget, runtimeResolver: () => fakeRuntime });
    await assert.rejects(mgr.start(agentId, baseConfig(agentId)), /symbolic link/);
    assert.equal(starts, 0);
    assert.equal(existsSync(path.join(outside, "notes")), false);
    assert.equal(existsSync(path.join(outside, "MEMORY.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a bound project is runtime cwd while state and full reset remain isolated", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-project-"));
  const projectDir = path.join(root, "existing-project");
  const dataDir = path.join(root, "state");
  const sentinel = path.join(projectDir, "AGENTS.md");
  let startOpts: StartOpts | undefined;
  let callbacks: RuntimeCallbacks | undefined;
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(sentinel, "existing project instructions\n");
  const previousRoots = process.env.OPEN_TAG_PROJECT_ROOTS;
  process.env.OPEN_TAG_PROJECT_ROOTS = JSON.stringify([root]);
  const fakeRuntime: Runtime = {
    name: "fake",
    start(opts, cb) {
      startOpts = opts;
      callbacks = cb;
      cb.onInitialTurnAdmission();
      return { deliver: async () => {}, stop: () => cb.onExit(0) };
    },
  };
  try {
    const agentId = "bound-project";
    const mgr = new AgentManager(() => {}, { dataDir, binDir: root, budget: noPressureBudget, runtimeResolver: () => fakeRuntime });
    await mgr.start(agentId, { ...baseConfig(agentId), projectPath: projectDir });
    assert.equal(startOpts?.cwd, await realpath(projectDir));
    assert.equal(startOpts?.stateDir, path.join(dataDir, agentId));
    assert.equal(readFileSync(sentinel, "utf8"), "existing project instructions\n");
    assert.equal(existsSync(path.join(dataDir, agentId, "MEMORY.md")), true);
    await mgr.reset(agentId, true, false);
    assert.equal(callbacks !== undefined, true);
    assert.equal(existsSync(path.join(dataDir, agentId)), false);
    assert.equal(readFileSync(sentinel, "utf8"), "existing project instructions\n");
  } finally {
    if (previousRoots === undefined) delete process.env.OPEN_TAG_PROJECT_ROOTS;
    else process.env.OPEN_TAG_PROJECT_ROOTS = previousRoots;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing bound project fails before spawning the runtime", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-missing-project-"));
  const previousRoots = process.env.OPEN_TAG_PROJECT_ROOTS;
  process.env.OPEN_TAG_PROJECT_ROOTS = JSON.stringify([root]);
  let starts = 0;
  const fakeRuntime: Runtime = {
    name: "fake",
    start() { starts++; return { deliver: async () => {}, stop: () => {} }; },
  };
  try {
    const mgr = new AgentManager(() => {}, { dataDir: path.join(root, "state"), binDir: root, budget: noPressureBudget, runtimeResolver: () => fakeRuntime });
    await assert.rejects(mgr.start("missing-project", { ...baseConfig("missing-project"), projectPath: path.join(root, "missing") }), /does not exist/);
    assert.equal(starts, 0);
  } finally {
    if (previousRoots === undefined) delete process.env.OPEN_TAG_PROJECT_ROOTS;
    else process.env.OPEN_TAG_PROJECT_ROOTS = previousRoots;
    rmSync(root, { recursive: true, force: true });
  }
});

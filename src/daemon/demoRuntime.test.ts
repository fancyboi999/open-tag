// Unit tests for the demo runtime adapter. Run: `npx tsx --test src/daemon/demoRuntime.test.ts`
//
// Key invariants verified:
//   • buildReply() is deterministic (turn-index rotation, no Math.random).
//   • Each turn calls transport.check() then transport.send() for each unique target.
//   • Response contains the demo notice and echoes the user's message body.
//   • onSession, working, trajectory, online fire in the right order.
//   • No subprocess is spawned (no child_process usage in the adapter).
//   • stop() prevents further output.
//   • Missing server credentials are handled gracefully (catch; agent stays online).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReply, startWithTransport } from "./demoRuntime.js";
import type { DemoTransport } from "./demoRuntime.js";
import type { RuntimeCallbacks, StartOpts } from "./runtime.js";

const DEMO_NOTICE_FRAGMENT = "no-op runtime";

// ── Helpers ───────────────────────────────────────────────────────────────────────────────────

function makeOpts(overrides?: Partial<StartOpts>): StartOpts {
  return {
    cwd: "/tmp/demo-test",
    systemPrompt: "You are a demo agent.",
    env: { ...process.env },
    initialPrompt: "Start.",
    ...overrides,
  };
}

function makeCollector() {
  const events: { type: string; payload: unknown }[] = [];
  const cb: RuntimeCallbacks = {
    onSession: (id) => events.push({ type: "session", payload: id }),
    onActivity: (a, d) => events.push({ type: "activity", payload: { a, d } }),
    onTrajectory: (entries) => events.push({ type: "trajectory", payload: entries }),
    onExit: (code) => events.push({ type: "exit", payload: code }),
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
  };
  return { events, cb };
}

// Mock transport: simulates server returning one message in #all.
function mockTransport(msgText = "[target=#all msg=abc12345 time=2026-01-01T00:00:00.000Z type=human] @you: @demoagent can you help?"): DemoTransport {
  const sent: { target: string; content: string }[] = [];
  return {
    async check() { return [{ text: msgText }]; },
    async send(target: string, content: string) { sent.push({ target, content }); },
    get sent() { return sent; },
  } as any;
}

// Transport that simulates an empty inbox (startup with no messages yet).
function emptyTransport(): DemoTransport {
  return { async check() { return []; }, async send() {} };
}

// Drain the micro/macro task queue so setImmediate + async turn completes.
async function drain(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve(); // flush any microtasks queued by the async executeTurn
  await new Promise<void>((resolve) => setImmediate(resolve));
}

// ── buildReply pure-function tests ───────────────────────────────────────────────────────────

test("buildReply: contains the demo notice fragment", () => {
  const reply = buildReply("help me write code", 0);
  assert.ok(reply.includes(DEMO_NOTICE_FRAGMENT), `reply must include "${DEMO_NOTICE_FRAGMENT}"`);
});

test("buildReply: echoes the user body up to 120 chars", () => {
  const body = "can you help me write some Python code?";
  const reply = buildReply(body, 0);
  assert.ok(reply.includes(body), "reply must echo the user body");
});

test("buildReply: truncates body > 120 chars with ellipsis", () => {
  const body = "x".repeat(200);
  const reply = buildReply(body, 0);
  assert.ok(reply.includes("…"), "reply must include ellipsis for long body");
  assert.ok(!reply.includes(body), "reply must not include the full 200-char body");
});

test("buildReply: greeting rotates deterministically by turnIndex", () => {
  const prefixes = Array.from({ length: 6 }, (_, i) => buildReply("hi", i).split(" ")[0]!);
  // Cycle of 5, so index 0 and 5 share the same greeting prefix
  assert.equal(prefixes[0], prefixes[5], "greeting at index 0 and 5 must match (cycle of 5)");
  // And at least two distinct greetings across 5 turns
  assert.ok(new Set(prefixes.slice(0, 5)).size > 1, "must have multiple distinct greetings across 5 turns");
});

// ── Runtime lifecycle tests (with injected mock transport) ────────────────────────────────────

test("start() calls onSession synchronously before any turn fires", async () => {
  const { events, cb } = makeCollector();
  const session = startWithTransport(makeOpts(), cb, emptyTransport());
  assert.ok(events.some((e) => e.type === "session"), "onSession must fire synchronously on start()");
  await drain();
  session.stop();
});

test("turn with messages: working → trajectory → send → online (in order)", async () => {
  const transport = mockTransport();
  const { events, cb } = makeCollector();
  const session = startWithTransport(makeOpts(), cb, transport);
  await drain();

  const types = events.map((e) => e.type);
  const wIdx = types.indexOf("activity");  // first activity = working
  const tIdx = types.indexOf("trajectory");
  const oIdx = types.lastIndexOf("activity"); // last activity = online

  assert.ok(wIdx >= 0, "must emit 'working' activity");
  assert.ok(tIdx >= 0, "must emit a trajectory entry");
  assert.ok(oIdx > tIdx, "'online' activity must come after trajectory");

  const workingEvt = events[wIdx]!.payload as any;
  assert.equal(workingEvt.a, "working");

  const onlineEvt = events[oIdx]!.payload as any;
  assert.equal(onlineEvt.a, "online");

  // transport.send must have been called for the #all target
  assert.equal((transport as any).sent.length, 1);
  assert.equal((transport as any).sent[0].target, "#all");
  assert.ok((transport as any).sent[0].content.includes(DEMO_NOTICE_FRAGMENT));

  session.stop();
});

test("turn with messages: reply echoes user message body", async () => {
  const transport = mockTransport(
    "[target=#all msg=abc12345 time=2026-01-01T00:00:00.000Z type=human] @you: @demoagent can you write Python?"
  );
  const { events, cb } = makeCollector();
  const session = startWithTransport(makeOpts(), cb, transport);
  await drain();

  const sent = (transport as any).sent as { target: string; content: string }[];
  assert.ok(sent.length > 0, "must send a message");
  assert.ok(sent[0]!.content.includes("can you write Python?"), "reply must echo user message body");

  session.stop();
});

test("empty inbox: onActivity(online) without calling transport.send", async () => {
  const sent: string[] = [];
  const transport: DemoTransport = {
    async check() { return []; },
    async send(t, c) { sent.push(c); },
  };
  const { events, cb } = makeCollector();
  const session = startWithTransport(makeOpts(), cb, transport);
  await drain();

  assert.equal(sent.length, 0, "must not call send with empty inbox");
  const onlineEvts = events.filter((e) => e.type === "activity" && (e.payload as any).a === "online");
  assert.ok(onlineEvts.length > 0, "must still emit online activity on empty inbox");

  session.stop();
});

test("multiple targets: one send per unique target", async () => {
  const sent: { target: string }[] = [];
  const transport: DemoTransport = {
    async check() {
      return [
        { text: "[target=#all msg=a time=t type=human] @u: hi" },
        { text: "[target=dm:@you msg=b time=t type=human] @u: hey" },
      ];
    },
    async send(target) { sent.push({ target }); },
  };
  const { cb } = makeCollector();
  const session = startWithTransport(makeOpts(), cb, transport);
  await drain();

  assert.equal(sent.length, 2, "must send one reply per unique target");
  assert.ok(sent.some((s) => s.target === "#all"));
  assert.ok(sent.some((s) => s.target === "dm:@you"));

  session.stop();
});

test("stop() prevents further output", async () => {
  const { events, cb } = makeCollector();
  const session = startWithTransport(makeOpts(), cb, emptyTransport());
  session.stop();
  await drain();

  const before = events.length;
  session.deliver("another turn");
  await drain();
  assert.equal(events.length, before, "deliver() after stop() must not emit new events");
});

test("session id is honoured from opts.sessionId (resume path)", async () => {
  const fixedId = "fixed-session-id-for-test";
  const { events, cb } = makeCollector();
  const session = startWithTransport(makeOpts({ sessionId: fixedId }), cb, emptyTransport());
  await drain();

  const sessEvent = events.find((e) => e.type === "session");
  assert.ok(sessEvent, "onSession must be called");
  assert.equal(sessEvent!.payload, fixedId, "must emit the provided sessionId");

  session.stop();
});

test("transport.check() failure is handled gracefully (agent stays online)", async () => {
  const broken: DemoTransport = {
    async check() { throw new Error("network error"); },
    async send() {},
  };
  const { events, cb } = makeCollector();
  const session = startWithTransport(makeOpts(), cb, broken);
  await drain();

  // Must not call onExit or emit an error activity
  const exits = events.filter((e) => e.type === "exit");
  const errorActs = events.filter((e) => e.type === "activity" && (e.payload as any).a === "error");
  assert.equal(exits.length, 0, "must not call onExit on transport failure");
  assert.equal(errorActs.length, 0, "must not emit error activity on transport failure");
  // Must still emit online so the agent stays alive
  const onlineActs = events.filter((e) => e.type === "activity" && (e.payload as any).a === "online");
  assert.ok(onlineActs.length > 0, "must emit online activity even after transport failure");

  session.stop();
});

test("no child_process spawn: session is not exposed as a proc handle", async () => {
  const { cb } = makeCollector();
  const session = startWithTransport(makeOpts(), cb, emptyTransport());
  await drain();
  assert.ok(!("proc" in session), "RuntimeSession must not expose a proc handle");
  session.stop();
});

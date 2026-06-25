// Reconnect/backoff state-machine tests for the daemon's control-plane WS client.
// Run: `npx tsx --test --test-force-exit src/daemon/connection.test.ts`.
// Drives a fake socket through the injected factory so no real network/server is needed; node:test
// mock timers let us assert *when* the next reconnect fires (i.e. the exact backoff value) without waiting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Connection, type WsLike } from "./connection.js";
import { MACHINE_REJECTED_CODE } from "../daemonProtocol.js";

// Minimal stand-in for the `ws` WebSocket: Connection only uses .on/.send/.close/.readyState.
class FakeWs extends EventEmitter {
  readyState = 1; // WebSocket.OPEN
  sent: string[] = [];
  closed = false;
  send(d: string): void { this.sent.push(d); }
  close(): void { this.closed = true; }
}

// Build a Connection whose sockets we control; `created` grows by one each time it (re)connects,
// so its length is an exact count of connection attempts.
function harness() {
  const created: FakeWs[] = [];
  const conn = new Connection("http://x", "k", () => {}, () => {}, () => {
    const w = new FakeWs();
    created.push(w);
    return w as unknown as WsLike;
  });
  return { created, conn };
}

test("backoff does not reset on a raw open — message-less attempts grow exponentially", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { created, conn } = harness();
  conn.connect();
  assert.equal(created.length, 1, "connect() opens attempt #1");

  // A rejected key still briefly opens the socket before the server closes it. If open reset the
  // backoff, every failure would retry in 1s forever (the bug). It must NOT reset here.
  created[0]!.emit("open");
  created[0]!.emit("close", 1006, Buffer.from(""));
  t.mock.timers.tick(1000);
  assert.equal(created.length, 2, "attempt #2 fires at 1000ms");

  created[1]!.emit("open");
  created[1]!.emit("close", 1006, Buffer.from(""));
  t.mock.timers.tick(1999);
  assert.equal(created.length, 2, "backoff must have grown to 2000ms — no reconnect yet at 1999ms");
  t.mock.timers.tick(1);
  assert.equal(created.length, 3, "attempt #3 fires only at 2000ms");
});

test("a fatal machine-rejected close backs off to the 30s cap instead of a 1s tight loop", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { created, conn } = harness();
  conn.connect();
  created[0]!.emit("open");
  created[0]!.emit("close", MACHINE_REJECTED_CODE, Buffer.from("unknown or removed machine key"));

  t.mock.timers.tick(29999);
  assert.equal(created.length, 1, "fatal rejection must not retry within 30s");
  t.mock.timers.tick(1);
  assert.equal(created.length, 2, "fatal rejection retries at the 30s cap");
});

test("backoff resets to 1s once the server proves it accepted us (sent a message)", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { created, conn } = harness();
  conn.connect();
  created[0]!.emit("open");
  // Grow the backoff first via a message-less failure...
  created[0]!.emit("close", 1006, Buffer.from(""));
  t.mock.timers.tick(1000);
  assert.equal(created.length, 2);

  // ...then a healthy connection that receives a server frame must reset the backoff to 1s.
  created[1]!.emit("open");
  created[1]!.emit("message", Buffer.from(JSON.stringify({ type: "ready:ack" })));
  created[1]!.emit("close", 1006, Buffer.from(""));
  t.mock.timers.tick(1000);
  assert.equal(created.length, 3, "after an accepted connection the next reconnect is quick again (1s)");
});

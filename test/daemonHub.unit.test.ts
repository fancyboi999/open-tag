// Unit test for daemonHub's machine-connection dedup invariant: one machine == at most one daemon ws in
// the broadcast map. Without this, a reconnect/orphan/accidental 2nd daemon on the same machine makes
// broadcastToDaemons deliver agent:start/agent:deliver to BOTH ws → each daemon spawns its own agent
// instance → double replies + double token spend (root-caused against the cctest incident, 2026-07-02).
// Run: npx tsx --test test/daemonHub.unit.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerDaemon, unregisterDaemon, registerMachineConn, unregisterMachineConn, broadcastToDaemons, isMachineConnected, sendToMachine } from "../src/server/daemonHub.js";

// Minimal fake ws: readyState=OPEN(1), counts sends + close.
function fakeWs(): any {
  return { readyState: 1, sends: 0, sent: [] as string[], closed: false, send(data: string) { this.sends++; this.sent.push(data); }, close() { this.closed = true; } };
}

test("same machine: 2nd ws evicts 1st from broadcast + closes it (no double delivery)", () => {
  const sid = "s-dedup-" + Math.random().toString(36).slice(2);
  const ws1 = fakeWs(), ws2 = fakeWs();
  registerDaemon(ws1, sid);
  registerDaemon(ws2, sid);            // both in the daemons map now
  registerMachineConn("m1", ws1);
  registerMachineConn("m1", ws2);      // ws2 takes over → ws1 must be evicted + closed
  broadcastToDaemons(sid, { type: "agent:deliver" });
  assert.equal(ws2.sends, 1, "new ws receives the broadcast exactly once");
  assert.equal(ws1.sends, 0, "evicted ws receives nothing");
  assert.equal(ws1.closed, true, "evicted ws is closed so its daemon tears down");
  unregisterDaemon(ws2); unregisterMachineConn(ws2);
});

test("single ws: broadcast delivered once (regression guard)", () => {
  const sid = "s-single-" + Math.random().toString(36).slice(2);
  const ws = fakeWs();
  registerDaemon(ws, sid);
  registerMachineConn("m1", ws);
  broadcastToDaemons(sid, { type: "agent:deliver" });
  assert.equal(ws.sends, 1);
  unregisterDaemon(ws); unregisterMachineConn(ws);
});

test("multi-tenant: broadcast does not cross servers", () => {
  const a = "s-A-" + Math.random().toString(36).slice(2), b = "s-B-" + Math.random().toString(36).slice(2);
  const wsA = fakeWs(), wsB = fakeWs();
  registerDaemon(wsA, a); registerDaemon(wsB, b);
  registerMachineConn("mA", wsA); registerMachineConn("mB", wsB);
  broadcastToDaemons(a, { type: "x" });
  assert.equal(wsA.sends, 1);
  assert.equal(wsB.sends, 0, "server B's daemon must not receive server A's broadcast");
  unregisterDaemon(wsA); unregisterMachineConn(wsA);
  unregisterDaemon(wsB); unregisterMachineConn(wsB);
});

test("machine-targeted send only reaches the selected connected machine", () => {
  const sid = "s-target-" + Math.random().toString(36).slice(2);
  const wsA = fakeWs(), wsB = fakeWs();
  registerDaemon(wsA, sid); registerDaemon(wsB, sid);
  registerMachineConn("m-target-a", wsA); registerMachineConn("m-target-b", wsB);

  assert.equal(isMachineConnected("m-target-a"), true);
  assert.equal(sendToMachine("m-target-a", { type: "agent:start", agentId: "a1" }), true);
  assert.equal(wsA.sends, 1);
  assert.equal(wsB.sends, 0, "non-target machine must not receive targeted start");
  assert.match(wsA.sent[0]!, /"agentId":"a1"/);

  unregisterMachineConn(wsA);
  assert.equal(isMachineConnected("m-target-a"), false);
  assert.equal(sendToMachine("m-target-a", { type: "agent:start", agentId: "a1" }), false);

  unregisterDaemon(wsA);
  unregisterDaemon(wsB); unregisterMachineConn(wsB);
});

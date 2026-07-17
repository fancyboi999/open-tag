import { test } from "node:test";
import assert from "node:assert/strict";
import { isCurrentMachineConn, registerMachineConn, sendToMachine, unregisterMachineConn } from "./daemonHub.js";
import type { WebSocket } from "ws";

const fakeWs = (sent: string[] = []): WebSocket => ({ readyState: 1, send: (data: string) => { sent.push(data); } }) as unknown as WebSocket;

test("machine connection ownership survives stale unregisters from old sockets", () => {
  const machineId = `machine-${Date.now()}-${Math.random()}`;
  const first = fakeWs();
  const second = fakeWs();

  registerMachineConn(machineId, first);
  assert.equal(isCurrentMachineConn(machineId, first), true);

  registerMachineConn(machineId, second);
  assert.equal(isCurrentMachineConn(machineId, first), false);
  assert.equal(isCurrentMachineConn(machineId, second), true);

  unregisterMachineConn(first);
  assert.equal(isCurrentMachineConn(machineId, second), true, "stale close must not unregister the newer connection");

  unregisterMachineConn(second);
  assert.equal(isCurrentMachineConn(machineId, second), false);
});

test("sendToMachine targets the selected machine connection", () => {
  const machineId = `machine-${Date.now()}-${Math.random()}`;
  const otherMachineId = `machine-${Date.now()}-${Math.random()}`;
  const sent: string[] = [];
  const otherSent: string[] = [];
  const ws = fakeWs(sent);
  const otherWs = fakeWs(otherSent);

  registerMachineConn(machineId, ws);
  registerMachineConn(otherMachineId, otherWs);

  assert.equal(sendToMachine(machineId, { type: "agent:start", agentId: "a1" }), true);
  assert.deepEqual(JSON.parse(sent[0]!), { type: "agent:start", agentId: "a1" });
  assert.deepEqual(otherSent, []);

  unregisterMachineConn(ws);
  unregisterMachineConn(otherWs);
  assert.equal(sendToMachine(machineId, { type: "agent:start" }), false);
});

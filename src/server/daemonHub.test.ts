import { test } from "node:test";
import assert from "node:assert/strict";
import { isCurrentMachineConn, registerMachineConn, unregisterMachineConn } from "./daemonHub.js";
import type { WebSocket } from "ws";

const fakeWs = (): WebSocket => ({ readyState: 1, send: () => {} }) as unknown as WebSocket;

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

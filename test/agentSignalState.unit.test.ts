import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const wsSrc = fs.readFileSync(new URL("../src/server/ws.ts", import.meta.url), "utf8");
const socketSrc = fs.readFileSync(new URL("../src/server/socketio.ts", import.meta.url), "utf8");
const coreSrc = fs.readFileSync(new URL("../src/server/core.ts", import.meta.url), "utf8");

test("agent activity detail is forwarded to the UI activity signal", () => {
  assert.match(
    wsSrc,
    /publish\(serverId!?, \{ type: "agent", id: a\.id, name: a\.name, status: a\.status, activity: a\.activity, detail: msg\.detail \?\? "" \}\)/,
    "daemon activity detail should be included in the server-level agent event",
  );
  assert.match(
    socketSrc,
    /room\.emit\("agent:activity", \{ agentId: event\.id, name: event\.name, status: event\.status, activity: event\.activity, detail: event\.detail \?\? "" \}\)/,
    "Socket.IO mapping should preserve detail for Store.activityDetail",
  );
});

test("agent wake delivery handles machine send failure after preview start", () => {
  assert.match(
    coreSrc,
    /const startSent = sendAgentStart\(opts\.serverId, target, mem\.id\);/,
    "message wake should check whether agent:start was actually sent",
  );
  assert.match(
    coreSrc,
    /const deliverSent = startSent && sendAgentDeliver\(opts\.serverId, target, \{ agentId: mem\.id,/,
    "message wake should only deliver after a successful start send",
  );
  assert.match(
    coreSrc,
    /if \(!deliverSent\) \{[\s\S]*?op: "error", text: "machine offline"[\s\S]*?await markAgentUnavailable\(opts\.serverId, mem\.id, "machine offline"\);[\s\S]*?continue;/,
    "send failure should mark the agent unavailable and close the preview instead of leaving a stuck thinking card",
  );
});

test("agent lifecycle control targets bound machines and preserves unbound broadcast fallback", () => {
  assert.match(
    coreSrc,
    /async function agentControlTarget\(serverId: string, agentId: string\)/,
    "stop/reset/profile sync should resolve the agent's bound machine separately from start config",
  );
  assert.match(
    coreSrc,
    /function sendAgentControl\(serverId: string, target: AgentControlTarget, msg: Record<string, unknown>\): boolean \{[\s\S]*?if \(target\.machineId\) return sendToMachine\(target\.machineId, msg\);[\s\S]*?broadcastToDaemons\(serverId, msg\);[\s\S]*?return true;/,
    "lifecycle controls should use one helper that targets bound agents and broadcasts legacy unbound agents",
  );
  assert.match(
    coreSrc,
    /if \(!a\.machineId\) \{[\s\S]*?if \(daemonCount\(serverId\) === 0\) return \{ ok: false, reason: "no daemon online" \};[\s\S]*?return \{ ok: true, machineId: null \};[\s\S]*?\}/,
    "legacy unbound agents should remain controllable through the broadcast daemon fallback",
  );
  assert.match(
    coreSrc,
    /sendAgentControl\(serverId, target, \{ type: "agent:stop", agentId \}\)/,
    "stop should target the bound machine daemon",
  );
  assert.match(
    coreSrc,
    /sendAgentControl\(serverId, target, \{ type: "agent:reset", agentId, wipeWorkspace, clearMemory \}\)/,
    "reset should target the bound machine daemon",
  );
  assert.match(
    coreSrc,
    /sendAgentControl\(serverId, target, \{ type: "agent:profile", agentId, displayName, description: description \?\? null \}\)/,
    "profile sync should target the bound machine daemon",
  );
});

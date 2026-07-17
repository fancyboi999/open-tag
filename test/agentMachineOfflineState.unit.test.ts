// Run: npx tsx --test --test-force-exit test/agentMachineOfflineState.unit.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const wsSrc = fs.readFileSync(new URL("../src/server/ws.ts", import.meta.url), "utf8");
const coreSrc = fs.readFileSync(new URL("../src/server/core.ts", import.meta.url), "utf8");
const livenessSrc = fs.readFileSync(new URL("../src/server/machineLiveness.ts", import.meta.url), "utf8");
const daemonHubSrc = fs.readFileSync(new URL("../src/server/daemonHub.ts", import.meta.url), "utf8");

test("daemon close immediately reconciles agents on that machine to offline", () => {
  assert.match(wsSrc, /import \{ markMachineAgentsOffline \} from "\.\/machineLiveness\.js";/);
  assert.match(
    wsSrc,
    /await publish\(serverId!, \{ type: "machine", online: false, machineId \}\);[\s\S]*?await markMachineAgentsOffline\(machineId\)/,
    "clean daemon close should publish machine offline and then force its agents offline",
  );
  assert.match(
    livenessSrc,
    /export async function markMachineAgentsOffline\(machineId: string\): Promise<number>/,
    "machine-offline agent reconciliation should be a named reusable helper",
  );
  assert.match(
    livenessSrc,
    /where\(and\(eq\(schema\.agents\.machineId, machineId\), ne\(schema\.agents\.status, "inactive"\)\)\)/,
    "only live/non-inactive agents on the disconnected machine should be touched",
  );
  assert.match(
    livenessSrc,
    /set\(\{ status: "inactive", activity: "offline" \}\)/,
    "disconnected-machine agents should become inactive/offline",
  );
  assert.match(
    livenessSrc,
    /publish\(a\.serverId, \{ type: "agent", id: a\.id, name: a\.name, status: "inactive", activity: "offline" \}\)/,
    "frontend must receive an agent event so stale working dots clear immediately",
  );
});

test("startAgent refuses a disconnected target machine before marking the agent working", () => {
  assert.match(
    daemonHubSrc,
    /export function isMachineConnected\(machineId: string\): boolean/,
    "daemonHub should expose the current websocket connection state",
  );
  assert.match(coreSrc, /import \{ broadcastToDaemons, daemonCount, isMachineConnected, sendToMachine \} from "\.\/daemonHub\.js";/);
  assert.match(
    coreSrc,
    /a\.machineStatus !== "online" \|\| !isMachineConnected\(a\.machineId\)/,
    "startAgent should require both DB-online and a live machine websocket",
  );
  assert.match(
    coreSrc,
    /if \(!runtimes\.includes\(runtime\)\) return \{ ok: false, reason: `runtime unavailable: \$\{runtime\}` \};/,
    "startAgent should reject agents whose runtime is not advertised by their target machine",
  );
  assert.match(
    coreSrc,
    /const cfg = await agentConfig\(agentId\);/,
    "offline machines should be rejected before minting or sending an agent token",
  );
  assert.match(
    coreSrc,
    /if \(target\.machineId\) return sendToMachine\(target\.machineId, msg\);/,
    "explicit start should target the agent's machine rather than every daemon in the workspace",
  );
  assert.match(
    coreSrc,
    /if \(!a\.machineId\) \{[\s\S]*?if \(daemonCount\(serverId\) === 0\) return \{ ok: false, reason: "no daemon online" \};[\s\S]*?return \{ ok: true, machineId: null, cfg \};[\s\S]*?\}/,
    "legacy unbound agents should keep their broadcast fallback instead of being marked machine-offline",
  );
  assert.match(
    coreSrc,
    /broadcastToDaemons\(serverId, msg\);[\s\S]*?return true;/,
    "unbound agent start should still broadcast when a daemon is online",
  );
});

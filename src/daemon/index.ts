#!/usr/bin/env node
// open-tag local daemon: connects to the control-plane WS and spawns locally-installed CLI agents (claude/codex) on demand.
// Usage: open-tag-daemon --server-url http://localhost:7777 --api-key <machineKey>
import "../env.js"; // must be first: loads project root .env (does not override shell env vars like OPENAI_API_KEY)
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { Connection } from "./connection.js";
import { AgentManager } from "./agentManager.js";
import { listWorkspace, readWorkspaceFile, listSkills } from "./workspace.js";
import { detectRuntimes } from "./runtimes.js";
import { listModels } from "./listModels.js";
import { createLogger } from "../log.js";
import { machineIdFile } from "../paths.js";

const log = createLogger("daemon");
const args = process.argv.slice(2);
let serverUrl = "", apiKey = "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--server-url" && args[i + 1]) serverUrl = args[++i]!;
  if (args[i] === "--api-key" && args[i + 1]) apiKey = args[++i]!;
}
// Default: connect to the server port from .env (worktree/prod each have their own .env port; --server-url overrides).
if (!serverUrl) serverUrl = `http://localhost:${process.env.PORT ?? 7777}`;
if (!apiKey) {
  console.error("Usage: open-tag-daemon [--server-url <url>] --api-key <machineKey>");
  process.exit(1);
}

// Stable machine identity: on first connection the server assigns machine.id via ready:ack, persisted to ~/.open-tag/machine-id.
// Subsequent connections include it so the server can recognize the same machine across restarts,
// avoiding orphan machine rows from unstable hostnames.
const MID_FILE = machineIdFile();
const readMachineId = (): string | undefined => { try { return fs.readFileSync(MID_FILE, "utf8").trim() || undefined; } catch { return undefined; } };
const saveMachineId = (id: string): void => { try { fs.mkdirSync(path.dirname(MID_FILE), { recursive: true }); fs.writeFileSync(MID_FILE, id); } catch { /* */ } };

let conn: Connection;
const mgr = new AgentManager((m) => conn.send(m));

conn = new Connection(serverUrl, apiKey, (msg) => {
  if (msg.type !== "ping") log.debug("recv", { type: msg.type, agentId: msg.agentId });
  switch (msg.type) {
    case "ready:ack": if (typeof msg.machineId === "string" && msg.machineId) saveMachineId(msg.machineId); break;
    case "agent:start": void mgr.start(msg.agentId, { ...msg.config }); break;
    case "agent:deliver": mgr.deliver(msg.agentId, msg.from ?? "someone", msg.target ?? "", !!msg.mentioned, { targetName: msg.targetName, msgShort: msg.msgShort, isTask: msg.isTask }); conn.send({ type: "agent:deliver:ack", agentId: msg.agentId, seq: msg.seq }); break;
    case "agent:stop": mgr.stop(msg.agentId); break;
    case "agent:sleep": mgr.sleep(msg.agentId); break;
    case "agent:reset": void mgr.reset(msg.agentId, !!msg.wipeWorkspace, !!msg.clearMemory); break;
    case "agent:profile": void mgr.syncProfile(msg.agentId, msg.displayName ?? "", msg.description); break;
    case "agent:workspace:list": void listWorkspace(msg.agentId, msg.path ?? "").then((r) => conn.send({ type: "workspace:file_tree", requestId: msg.requestId, agentId: msg.agentId, ...r })); break;
    case "agent:workspace:read": void readWorkspaceFile(msg.agentId, msg.path ?? "").then((r) => conn.send({ type: "workspace:file_content", requestId: msg.requestId, agentId: msg.agentId, ...r })); break;
    case "agent:skills:list": void listSkills(msg.agentId).then((r) => conn.send({ type: "skills:list", requestId: msg.requestId, agentId: msg.agentId, ...r })); break;
    case "probe-models": void listModels(msg.runtime ?? "").then((models) => conn.send({ type: "models", requestId: msg.requestId, runtime: msg.runtime, models })).catch((e) => conn.send({ type: "models", requestId: msg.requestId, runtime: msg.runtime, models: null, error: String((e as any)?.message ?? e) })); break;
    case "ping": conn.send({ type: "pong" }); break;
  }
}, () => {
  const runtimes = detectRuntimes();
  log.info("ready", { runtimes, hostname: os.hostname() });
  conn.send({
    type: "ready", capabilities: ["agent:start", "agent:stop", "agent:sleep", "agent:reset", "agent:profile", "agent:deliver", "agent:workspace"],
    runtimes, runningAgents: mgr.running(), hostname: os.hostname(), os: `${os.platform()} ${os.arch()}`, daemonVersion: process.env.DAEMON_VERSION ?? "dev",
    machineId: readMachineId(), // Stable identity: empty on first connection; server sends it back via ready:ack for persistence.
  });
});

log.info("open-tag daemon starting", { serverUrl });
conn.connect();
const shutdown = () => { log.info("shutting down"); mgr.stopAll(); conn.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

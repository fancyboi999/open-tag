#!/usr/bin/env node
// open-tag local daemon: connects to the control-plane WS and spawns locally-installed CLI agents (claude/codex) on demand.
// Usage: open-tag-daemon --server-url http://localhost:7777 --api-key <machineKey>
import "../env.js"; // must be first: loads project root .env (does not override shell env vars like OPENAI_API_KEY)
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { Connection } from "./connection.js";
import { AgentManager } from "./agentManager.js";
import { listWorkspace, readWorkspaceFile, writeWorkspaceFile, deleteWorkspaceFile, listSkills } from "./workspace.js";
import { runSanitize } from "./sanitize.js";
import { detectRuntimes } from "./runtimes.js";
import { listModels } from "./listModels.js";
import { createLogger } from "../log.js";
import { machineIdFile } from "../paths.js";
import { AGENT_CONTROL_ACK_CAPABILITY, DELIVERY_ADMISSION_CAPABILITY, PROJECT_BROWSER_CAPABILITY, PROJECT_DIRECTORY_CAPABILITY } from "../daemonProtocol.js";
import { browseProjectDirectories, ProjectDirectoryError, resolveProjectDirectory } from "./projectDirectory.js";

const log = createLogger("daemon");
const DELIVERY_PENDING_HEARTBEAT_MS = Math.max(250, Number(process.env.OPEN_TAG_DELIVERY_PENDING_HEARTBEAT_MS ?? 750));
const DELIVERY_COMMIT_TIMEOUT_MS = Math.max(2_000, Number(process.env.OPEN_TAG_DELIVERY_COMMIT_TIMEOUT_MS ?? 15_000));
const args = process.argv.slice(2);
let serverUrl = "", apiKey = "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--server-url" && args[i + 1]) serverUrl = args[++i]!;
  if (args[i] === "--api-key" && args[i + 1]) apiKey = args[++i]!;
}
// Default: connect to the server port from .env (worktree/prod each have their own .env port; --server-url overrides).
if (!serverUrl) serverUrl = `http://localhost:${process.env.PORT ?? 7777}`;
// Machine daemon connection key fallback. This is the same sk_machine_* value accepted by
// --api-key; it is not an agent token, user token, or provider credential.
if (!apiKey) apiKey = process.env.OPEN_TAG_DAEMON_API_KEY ?? "";
if (!apiKey) {
  console.error("Usage: open-tag-daemon [--server-url <url>] --api-key <machineKey>");
  console.error("   or: OPEN_TAG_DAEMON_API_KEY=<machineKey> open-tag-daemon [--server-url <url>]");
  process.exit(1);
}

// Stable machine identity: on first connection the server assigns machine.id via ready:ack, persisted to ~/.open-tag/machine-id.
// Subsequent connections include it so the server can recognize the same machine across restarts,
// avoiding orphan machine rows from unstable hostnames.
const MID_FILE = machineIdFile();
const readMachineId = (): string | undefined => { try { return fs.readFileSync(MID_FILE, "utf8").trim() || undefined; } catch { return undefined; } };
const saveMachineId = (id: string): void => { try { fs.mkdirSync(path.dirname(MID_FILE), { recursive: true }); fs.writeFileSync(MID_FILE, id); } catch { /* */ } };

let conn: Connection;
interface DeliveryCommitWaiter { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void; retry: ReturnType<typeof setInterval>; timeout: ReturnType<typeof setTimeout>; }
const deliveryCommitWaiters = new Map<string, DeliveryCommitWaiter>();

function requestDeliveryCommit(agentId: string, meta: { deliveryId?: string; seq?: number }): Promise<void> {
  if (!meta.deliveryId) return Promise.resolve();
  const existing = deliveryCommitWaiters.get(meta.deliveryId);
  if (existing) return existing.promise;
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const sendReady = () => conn.send({ type: "agent:deliver:ready", agentId, seq: meta.seq, deliveryId: meta.deliveryId });
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  const retry = setInterval(sendReady, DELIVERY_PENDING_HEARTBEAT_MS);
  retry.unref?.();
  const timeout = setTimeout(() => reject(new Error(`server did not commit delivery admission: ${meta.deliveryId}`)), DELIVERY_COMMIT_TIMEOUT_MS);
  timeout.unref?.();
  const waiter: DeliveryCommitWaiter = { promise, resolve, reject, retry, timeout };
  deliveryCommitWaiters.set(meta.deliveryId, waiter);
  void promise.finally(() => {
    clearInterval(retry);
    clearTimeout(timeout);
    if (deliveryCommitWaiters.get(meta.deliveryId!) === waiter) deliveryCommitWaiters.delete(meta.deliveryId!);
  }).catch(() => {});
  sendReady();
  return promise;
}

function settleDeliveryCommit(deliveryId: unknown, error?: unknown): void {
  if (typeof deliveryId !== "string") return;
  const waiter = deliveryCommitWaiters.get(deliveryId);
  if (!waiter) return;
  if (error) waiter.reject(new Error(String(error)));
  else waiter.resolve();
}

const mgr = new AgentManager((m) => conn.send(m), { beforeRuntimeDelivery: requestDeliveryCommit });

function runAgentControl(msg: any, operation: () => void | Promise<void>): void {
  void mgr.runControl(msg.agentId, operation).then(
    () => {
      if (typeof msg.requestId === "string" && msg.requestId) conn.send({ type: "rpc:ack", requestId: msg.requestId });
    },
    (cause) => {
      const error = String(cause instanceof Error ? cause.message : cause);
      log.error("agent control failed", { type: msg.type, agentId: msg.agentId, detail: error });
      if (typeof msg.requestId === "string" && msg.requestId) conn.send({ type: "rpc:nack", requestId: msg.requestId, error });
    },
  );
}

conn = new Connection(serverUrl, apiKey, (msg) => {
  if (msg.type !== "ping") log.debug("recv", { type: msg.type, agentId: msg.agentId });
  switch (msg.type) {
    case "ready:ack": if (typeof msg.machineId === "string" && msg.machineId) saveMachineId(msg.machineId); break;
    case "agent:deliver:admitted": settleDeliveryCommit(msg.deliveryId); break;
    case "agent:deliver:rejected": settleDeliveryCommit(msg.deliveryId, msg.error ?? "server rejected delivery admission"); break;
    // Agent dials the same server URL this daemon connected with (proven reachable), overriding the
    // server-reported config.serverUrl (SELF_URL = localhost:PORT on the server box — wrong whenever the
    // daemon runs on a different host than the server, e.g. local daemon ↔ getopentag.com).
    case "agent:start": runAgentControl(msg, () => mgr.start(msg.agentId, { ...msg.config, serverUrl })); break;
    case "agent:deliver": {
      const admission = mgr.deliver(msg.agentId, msg.from ?? "someone", msg.target ?? "", !!msg.mentioned, { targetName: msg.targetName, msgShort: msg.msgShort, isTask: msg.isTask, streamId: msg.streamId, turnId: msg.turnId, turnMessageCount: msg.turnMessageCount, attention: msg.attention, deliveryId: msg.deliveryId, seq: msg.seq });
      const sendPending = () => conn.send({ type: "agent:deliver:pending", agentId: msg.agentId, seq: msg.seq, deliveryId: msg.deliveryId });
      sendPending();
      const pendingHeartbeat = setInterval(sendPending, DELIVERY_PENDING_HEARTBEAT_MS);
      pendingHeartbeat.unref?.();
      void admission.then(
        () => { clearInterval(pendingHeartbeat); conn.send({ type: "agent:deliver:ack", agentId: msg.agentId, seq: msg.seq, deliveryId: msg.deliveryId }); },
        (error) => { clearInterval(pendingHeartbeat); conn.send({ type: "agent:deliver:nack", agentId: msg.agentId, seq: msg.seq, deliveryId: msg.deliveryId, error: String(error instanceof Error ? error.message : error) }); },
      );
      break;
    }
    case "agent:stop": runAgentControl(msg, () => mgr.stop(msg.agentId)); break;
    case "agent:sleep": runAgentControl(msg, () => mgr.sleep(msg.agentId)); break;
    case "agent:reset": runAgentControl(msg, () => mgr.reset(msg.agentId, !!msg.wipeWorkspace, !!msg.clearMemory)); break;
    case "agent:profile": void mgr.syncProfile(msg.agentId, msg.displayName ?? "", msg.description); break;
    case "agent:workspace:list": void listWorkspace(msg.agentId, msg.path ?? "").then((r) => conn.send({ type: "workspace:file_tree", requestId: msg.requestId, agentId: msg.agentId, ...r })); break;
    case "agent:workspace:read": void readWorkspaceFile(msg.agentId, msg.path ?? "").then((r) => conn.send({ type: "workspace:file_content", requestId: msg.requestId, agentId: msg.agentId, ...r })); break;
    case "agent:workspace:write": void writeWorkspaceFile(msg.agentId, msg.path ?? "", msg.content ?? "").then((r) => conn.send({ type: "workspace:file_write", requestId: msg.requestId, agentId: msg.agentId, ...r })); break;
    case "agent:workspace:delete": void deleteWorkspaceFile(msg.agentId, msg.path ?? "").then((r) => conn.send({ type: "workspace:file_delete", requestId: msg.requestId, agentId: msg.agentId, ...r })); break;
    case "agent:skills:list": void listSkills(msg.agentId, msg.runtime, msg.projectPath).then((r) => conn.send({ type: "skills:list", requestId: msg.requestId, agentId: msg.agentId, ...r })); break;
    case "sanitize": void runSanitize(String(msg.text ?? "")).then(
      (text) => conn.send({ type: "sanitize:result", requestId: msg.requestId, text }),
      (cause) => conn.send({ type: "sanitize:result", requestId: msg.requestId, error: String(cause instanceof Error ? cause.message : cause) }),
    ); break;
    case "project:resolve": void resolveProjectDirectory(msg.path).then(
      (projectPath) => conn.send({ type: "project:resolved", requestId: msg.requestId, projectPath }),
      (cause) => conn.send({ type: "project:resolved", requestId: msg.requestId, error: String(cause instanceof Error ? cause.message : cause), code: cause instanceof ProjectDirectoryError ? cause.code : "invalid_project_path" }),
    ); break;
    case "project:browse": void browseProjectDirectories({ path: msg.path, discover: msg.discover === true, cursor: msg.cursor, limit: msg.limit }).then(
      (result) => conn.send({ type: "project:directories", requestId: msg.requestId, ...result }),
      (cause) => conn.send({ type: "project:directories", requestId: msg.requestId, error: String(cause instanceof Error ? cause.message : cause), code: cause instanceof ProjectDirectoryError ? cause.code : "invalid_project_path" }),
    ); break;
    case "probe-models": void listModels(msg.runtime ?? "").then((models) => conn.send({ type: "models", requestId: msg.requestId, runtime: msg.runtime, models })).catch((e) => conn.send({ type: "models", requestId: msg.requestId, runtime: msg.runtime, models: null, error: String((e as any)?.message ?? e) })); break;
    case "agent:resource-budget": conn.send({ type: "agent:resource-budget", requestId: msg.requestId, ...mgr.budgetStatus() }); break;
    case "agent:dequeue": mgr.dequeue(msg.agentId); break;
    case "ping": conn.send({ type: "pong" }); break;
    default:
      // Fail loud on version skew: a daemon that predates an RPC type must NACK instead of silently dropping
      // it, so the server surfaces "daemon too old" instead of a generic timeout (tech-debt I88). Only RPCs
      // carry a requestId; unknown fire-and-forget messages stay ignored.
      if (typeof msg.requestId === "string" && msg.requestId) conn.send({ type: "rpc:nack", requestId: msg.requestId, error: `daemon ${process.env.DAEMON_VERSION ?? "dev"} does not support "${msg.type}" — restart it with: npx @fancyboi999/open-tag-daemon@latest` });
  }
}, () => {
  const runtimes = detectRuntimes();
  log.info("ready", { runtimes, hostname: os.hostname() });
  conn.send({
    type: "ready", capabilities: ["agent:start", "agent:stop", "agent:sleep", "agent:reset", "agent:profile", "agent:deliver", "agent:workspace", "resource:limits", DELIVERY_ADMISSION_CAPABILITY, AGENT_CONTROL_ACK_CAPABILITY, PROJECT_DIRECTORY_CAPABILITY, PROJECT_BROWSER_CAPABILITY],
    runtimes, runningAgents: mgr.running(), hostname: os.hostname(), os: `${os.platform()} ${os.arch()}`, daemonVersion: process.env.DAEMON_VERSION ?? "dev",
    machineId: readMachineId(), // Stable identity: empty on first connection; server sends it back via ready:ack for persistence.
  });
});

log.info("open-tag daemon starting", { serverUrl });
conn.connect();
const shutdown = () => { log.info("shutting down"); mgr.stopAll(); conn.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGBREAK", shutdown); // Windows Ctrl+Break (SIGTERM is not available on Windows)

// Codex runtime: `codex app-server --listen stdio://` + JSON-RPC 2.0 (NDJSON).
// System prompt is passed via developerInstructions; each delivery = one turn/start (serial, waits for turn/completed).
// Automatically approves exec/patch/elicitation requests in daemon mode.
import { type ChildProcess } from "node:child_process";
import { spawnSafe } from "./spawnSafe.js";
import { killTree } from "./killTree.js";
import type { Runtime, StartOpts, RuntimeCallbacks, RuntimeSession } from "./runtime.js";

const MAX = 2000;
const clip = (s: unknown) => String(s ?? "").slice(0, MAX);
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
function extractThreadId(r: any): string {
  return (r && (r.threadId || r.thread?.id || r.thread_id || r.id)) || "";
}
function reasoningEffort(runtimeConfig: Record<string, unknown> | null | undefined): string | null {
  const effort = runtimeConfig?.reasoningEffort;
  return typeof effort === "string" && EFFORTS.has(effort) ? effort : null;
}
function codexConfig(opts: StartOpts): Record<string, unknown> | null {
  const effort = reasoningEffort(opts.runtimeConfig);
  return effort ? { model_reasoning_effort: effort } : null;
}
function turnParams(opts: StartOpts, threadId: string, text: string): Record<string, unknown> {
  const effort = reasoningEffort(opts.runtimeConfig);
  return { threadId, input: [{ type: "text", text }], ...(effort ? { effort } : {}) };
}

class CodexClient {
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private buf = "";
  private proto: "unknown" | "legacy" | "raw" = "unknown";
  threadId = "";
  onTurnDone: ((aborted: boolean) => void) | null = null;

  constructor(private proc: ChildProcess, private cb: RuntimeCallbacks) {
    proc.stdout?.on("data", (c: Buffer) => {
      this.buf += c.toString(); const lines = this.buf.split("\n"); this.buf = lines.pop() ?? "";
      for (const ln of lines) { const t = ln.trim(); if (t) this.handleLine(t); }
    });
  }

  request(method: string, params: unknown): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }
  notify(method: string, params?: unknown): void { this.write({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }); }
  private respond(id: number, result: unknown): void { this.write({ jsonrpc: "2.0", id, result }); }
  private write(o: unknown): void { try { this.proc.stdin?.write(JSON.stringify(o) + "\n"); } catch { /* */ } }
  closeAllPending(err: Error): void { for (const [id, p] of this.pending) { p.reject(err); this.pending.delete(id); } }

  private handleLine(line: string): void {
    let raw: any; try { raw = JSON.parse(line); } catch { return; }
    if (raw.id !== undefined && (raw.result !== undefined || raw.error !== undefined)) {
      const p = this.pending.get(raw.id); if (!p) return; this.pending.delete(raw.id);
      raw.error ? p.reject(new Error(raw.error.message || "rpc error")) : p.resolve(raw.result);
      return;
    }
    if (raw.id !== undefined && raw.method) { this.handleServerRequest(raw.id, raw.method); return; }
    if (raw.method) this.handleNotification(raw.method, raw.params || {});
  }

  private handleServerRequest(id: number, method: string): void {
    // Daemon mode: automatically approve exec/patch/elicitation
    if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval"
      || method === "item/fileChange/requestApproval" || method === "applyPatchApproval"
      || method === "item/permissions/requestApproval") {
      this.respond(id, { decision: "accept" });
    } else if (method === "mcpServer/elicitation/request") {
      this.respond(id, { action: "accept", content: null, _meta: null });
    } else {
      this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: "unhandled: " + method } });
    }
  }

  private handleNotification(method: string, params: any): void {
    if (method === "codex/event" || method.startsWith("codex/event/")) {
      this.proto = "legacy"; if (params.msg) this.handleLegacy(params.msg); return;
    }
    if (this.proto !== "legacy") {
      if (this.proto === "unknown" && (method === "turn/started" || method === "turn/completed" || method === "thread/started" || method.startsWith("item/"))) this.proto = "raw";
      if (this.proto === "raw") this.handleRaw(method, params);
    }
  }

  private handleRaw(method: string, params: any): void {
    if (this.threadId && params.threadId && params.threadId !== this.threadId) return; // ignore events from other threads
    if (method === "turn/started") { this.cb.onActivity("working", "turn"); }
    else if (method === "turn/completed") {
      const status = params?.turn?.status;
      const aborted = ["cancelled", "canceled", "aborted", "interrupted"].includes(status);
      if (status === "failed") this.cb.onTrajectory([{ kind: "text", text: "[codex turn failed] " + (params?.turn?.error?.message || "") }]);
      this.cb.onActivity("online", ""); this.onTurnDone?.(aborted);
    } else if (method === "item/agentMessage/delta" || method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      // The current UI stores each trajectory entry as a separate row, so token deltas would spam
      // the timeline. Emit the completed item text below instead.
    } else if (method === "item/commandExecution/outputDelta" || method === "command/exec/outputDelta" || method === "process/outputDelta") {
      // stdout/stderr chunks are often large and noisy; surface the command item itself instead.
    } else if (method === "item/started" || method === "item/completed") {
      const item = params?.item;
      if (!item) return;
      if ((item.type === "agentMessage" || item.type === "plan") && item.text) this.cb.onTrajectory([{ kind: "text", text: clip(item.text) }]);
      else if (item.type === "reasoning") {
        const text = [...(item.summary ?? []), ...(item.content ?? [])].join("\n");
        if (text) this.cb.onTrajectory([{ kind: "thinking", text: clip(text) }]);
      } else if (method === "item/started" && item.type && item.type !== "userMessage") {
        const toolInput = item.command || item.path || item.name || item.reason || "";
        this.cb.onTrajectory([{ kind: "tool", toolName: item.type, toolInput: clip(toolInput).slice(0, 160) }]);
      }
    } else if (method === "error") {
      if (!params.willRetry) { this.cb.onTrajectory([{ kind: "text", text: "[codex error] " + (params?.error?.message || params?.message || "") }]); this.onTurnDone?.(false); }
    }
  }

  private handleLegacy(msg: any): void {
    switch (msg.type) {
      case "task_started": this.cb.onActivity("working", "running"); break;
      case "agent_message": if (msg.message) this.cb.onTrajectory([{ kind: "text", text: clip(msg.message) }]); break;
      case "exec_command_begin": this.cb.onActivity("working", "Running command…"); this.cb.onTrajectory([{ kind: "tool", toolName: "exec_command", toolInput: clip(msg.command).slice(0, 120) }]); break;
      case "patch_apply_begin": this.cb.onTrajectory([{ kind: "tool", toolName: "patch_apply" }]); break;
      case "task_complete": this.cb.onActivity("online", ""); this.onTurnDone?.(false); break;
      case "turn_aborted": this.onTurnDone?.(true); break;
    }
  }
}

export const codexRuntime: Runtime = {
  name: "codex",
  experimental: true,
  start(opts: StartOpts, cb: RuntimeCallbacks): RuntimeSession {
    // Do not override CODEX_HOME: use the user's default ~/.codex (which contains subscription auth state).
    // Per-agent CODEX_HOME isolation + auth/MCP injection is a future improvement.
    const proc = spawnSafe("codex", ["app-server", "--listen", "stdio://"], { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], env: opts.env });
    const client = new CodexClient(proc, cb);
    let ready = false;
    let spawnFailed = false;
    let reportedExit = false;
    const queue: string[] = [];
    let turnBusy = false;

    function reportExit(code: number | null): void {
      if (reportedExit) return;
      reportedExit = true;
      cb.onExit(code);
    }

    client.onTurnDone = () => { turnBusy = false; pump(); };
    function pump(): void {
      if (!ready || turnBusy || queue.length === 0) return;
      const text = queue.shift()!;
      turnBusy = true;
      cb.onActivity("working", "turn");
      client.request("turn/start", turnParams(opts, client.threadId, text))
        .catch((e) => { if (spawnFailed) return; cb.log.warn("codex turn/start failed", { detail: String(e?.message ?? e) }); turnBusy = false; pump(); });
    }

    (async () => {
      try {
        await client.request("initialize", { clientInfo: { name: "open-tag", title: "open-tag", version: "0.1.0" }, capabilities: { experimentalApi: true } });
        client.notify("initialized");
        let threadId = "";
        const cfg = codexConfig(opts);
        if (opts.sessionId) {
          try {
            const r = await client.request("thread/resume", { threadId: opts.sessionId, cwd: opts.cwd, model: opts.model || null, developerInstructions: opts.systemPrompt || null, ...(cfg ? { config: cfg } : {}) });
            threadId = extractThreadId(r);
          } catch (e) { cb.log.warn("codex resume failed; starting fresh", { detail: String(e) }); }
        }
        if (!threadId) {
          const r = await client.request("thread/start", { model: opts.model || null, cwd: opts.cwd, developerInstructions: opts.systemPrompt || null, persistExtendedHistory: true, experimentalRawEvents: false, ...(cfg ? { config: cfg } : {}) });
          threadId = extractThreadId(r);
        }
        if (!threadId) { cb.log.error("codex thread/start returned no threadId"); cb.onActivity("offline", "codex no thread"); return; }
        client.threadId = threadId; cb.onSession(threadId); cb.log.info("codex thread ready", { threadId });
        ready = true;
        queue.push(opts.initialPrompt); pump();
      } catch (e) {
        if (spawnFailed) return;
        cb.log.error("codex init failed", { detail: String((e as any)?.message ?? e) });
        cb.onActivity("offline", "codex init failed");
      }
    })();

    proc.stderr?.on("data", (c: Buffer) => { const t = c.toString().trim(); if (t) cb.log.debug("codex stderr", { t: t.slice(0, 300) }); });
    proc.on("error", (e: NodeJS.ErrnoException) => {
      spawnFailed = true;
      const detail = e.code === "ENOENT" ? "codex not found" : "codex spawn failed";
      client.closeAllPending(new Error(detail));
      cb.log.error("codex spawn failed", { detail: String(e?.message ?? e), code: e.code ?? "" });
      cb.onActivity("offline", detail);
      reportExit(1);
    });
    proc.on("exit", (code) => { client.closeAllPending(new Error("codex exited")); reportExit(code); });

    return { deliver: (text) => { queue.push(text); pump(); }, stop: () => { killTree(proc); } };
  },
};

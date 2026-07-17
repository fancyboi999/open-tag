// Copilot runtime: one-shot `copilot -p <prompt> --output-format json` per turn, chained by a
// self-assigned `--session-id <uuid>` (idempotent create-or-resume). Unlike claude (persistent
// stdin stream-json) and codex (persistent app-server), Copilot's pipe mode runs one turn and
// exits — so each deliver() spawns a fresh process that resumes the same session id. The standing
// system prompt is injected via {cwd}/AGENTS.md, which Copilot reads natively.
// Protocol verified against GitHub Copilot CLI 1.0.61 (see src/daemon/__fixtures__/copilot-*.jsonl).
import { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSafe } from "./spawnSafe.js";
import { killTree } from "./killTree.js";
import type { Runtime, StartOpts, RuntimeCallbacks, RuntimeSession, TrajectoryEntry } from "./runtime.js";

const MAX = 2000;
const clip = (s: unknown) => String(s ?? "").slice(0, MAX);
const EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

function reasoningEffort(rc: Record<string, unknown> | null | undefined): string | null {
  const e = rc?.reasoningEffort;
  return typeof e === "string" && EFFORTS.has(e) ? e : null;
}

function summarizeToolArgs(tr: any): string {
  let args = tr?.arguments;
  if (typeof args === "string") { try { args = JSON.parse(args); } catch { return clip(args).slice(0, 160); } }
  if (!args || typeof args !== "object") return "";
  const v = args.command ?? args.path ?? args.file_path ?? args.filePath ?? args.query ?? args.pattern ?? args.url ?? "";
  return clip(typeof v === "string" ? v : JSON.stringify(v)).slice(0, 160);
}

// ── pure event mapping (unit-tested against real fixtures) ──
export interface CopilotEmit {
  trajectory: TrajectoryEntry[];
  activity?: { activity: string; detail: string };
  sessionId?: string;
  exitCode?: number;
  error?: string;
}

// handleCopilotEvent maps one parsed Copilot JSONL event to open-tag callbacks. The event set is
// verified against GitHub Copilot CLI 1.0.61: note there is NO `session.start` (sessionId arrives
// only on the final `result`), and model/launch errors are NOT JSON events — they go to stderr +
// a non-zero exit (handled in CopilotRun, not here).
export function handleCopilotEvent(evt: any): CopilotEmit {
  const out: CopilotEmit = { trajectory: [] };
  const data = evt?.data ?? {};
  switch (evt?.type) {
    case "assistant.turn_start":
      out.activity = { activity: "working", detail: "turn" };
      break;
    case "assistant.message": {
      if (data.content) out.trajectory.push({ kind: "text", text: clip(data.content) });
      if (Array.isArray(data.toolRequests))
        for (const tr of data.toolRequests)
          out.trajectory.push({ kind: "tool", toolName: String(tr?.name ?? "tool"), toolInput: summarizeToolArgs(tr) });
      break;
    }
    case "assistant.reasoning":
      // content is often empty (the reasoning is encrypted in reasoningOpaque) — skip empties.
      if (data.content) out.trajectory.push({ kind: "thinking", text: clip(data.content) });
      break;
    case "result":
      if (typeof evt.sessionId === "string" && evt.sessionId) out.sessionId = evt.sessionId;
      if (typeof evt.exitCode === "number") out.exitCode = evt.exitCode;
      break;
    case "session.error":
      out.error = clip(data.message ?? data.error ?? "copilot session error");
      break;
    // Intentionally ignored: assistant.message_start; assistant.message_delta (token stream — the UI
    // stores each entry as a row, so deltas would spam the timeline; we emit the completed message);
    // assistant.turn_end (process exit is the authoritative turn-done); tool.execution_complete (the
    // tool *use* is already shown from assistant.message.toolRequests, matching claude/codex which
    // surface tool calls but not results); session.mcp_servers_loaded / skills_loaded / tools_updated
    // / mcp_server_status_changed; user.message (echo of our own prompt).
  }
  return out;
}

function buildArgs(prompt: string, sessionId: string, model: string | undefined, effort: string | null): string[] {
  const args = ["-p", prompt, "--output-format", "json", "--allow-all", "--no-ask-user", "--session-id", sessionId];
  const m = model && model !== "default" ? model : ""; // "" → let copilot pick; "auto" passes through
  if (m) args.push("--model", m);
  if (effort) args.push("--effort", effort);
  return args;
}

// CopilotRun owns the serial turn queue for one agent session. Mirrors codexRuntime's
// queue/turnBusy/pump pattern, but each turn is a fresh one-shot process rather than a message to a
// persistent one.
class CopilotRun {
  private queue: string[] = [];
  private turnBusy = false;
  private stopped = false;
  private proc: ChildProcess | null = null;
  private readonly sessionId: string;
  private everSucceeded = false;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly opts: StartOpts, private readonly cb: RuntimeCallbacks) {
    // Self-assign the session id (idempotent create-or-resume via --session-id, verified). Announce
    // it up front so the server's resume pointer survives a crash/timeout before any `result` line.
    this.sessionId = opts.sessionId || randomUUID();
    this.env = { ...opts.env };
    delete this.env.NODE_OPTIONS; // copilot's bundled node rejects proxy flags (e.g. --use-env-proxy)
    try { writeFileSync(path.join(opts.cwd, "AGENTS.md"), opts.systemPrompt); }
    catch (e) { cb.log.warn("copilot: AGENTS.md write failed", { detail: String(e) }); }
    cb.onSession(this.sessionId);
    this.enqueue(opts.initialPrompt);
  }

  enqueue(text: string): void { if (this.stopped) return; this.queue.push(text); this.pump(); }

  private pump(): void {
    if (this.stopped || this.turnBusy || this.queue.length === 0) return;
    this.runTurn(this.queue.shift()!);
  }

  private runTurn(prompt: string): void {
    this.turnBusy = true;
    this.cb.onActivity("working", "turn");
    const args = buildArgs(prompt, this.sessionId, this.opts.model, reasoningEffort(this.opts.runtimeConfig));
    const proc = spawnSafe("copilot", args, { cwd: this.opts.cwd, stdio: ["ignore", "pipe", "pipe"], env: this.env });
    this.proc = proc;
    let buf = "";
    let resultSeen = false;
    const errTail: string[] = [];
    let errLen = 0;
    const processLine = (ln: string) => {
      const t = ln.trim(); if (!t) return;
      let evt: any; try { evt = JSON.parse(t); } catch { return; }
      const emit = handleCopilotEvent(evt);
      if (emit.exitCode !== undefined) resultSeen = true; // gate on result event, not sessionId
      if (emit.error) { this.cb.onTrajectory([{ kind: "text", text: "[copilot error] " + emit.error.slice(0, 500) }]); this.cb.onActivity("error", emit.error.slice(0, 200)); }
      if (emit.activity) this.cb.onActivity(emit.activity.activity, emit.activity.detail);
      if (emit.trajectory.length) this.cb.onTrajectory(emit.trajectory);
    };
    proc.stdout?.on("data", (c: Buffer) => {
      if (this.stopped) return;
      buf += c.toString(); const lines = buf.split("\n"); buf = lines.pop() ?? "";
      for (const ln of lines) processLine(ln);
    });
    proc.stderr?.on("data", (c: Buffer) => {
      const t = c.toString(); errTail.push(t); errLen += t.length;
      while (errLen > 4096 && errTail.length > 1) errLen -= errTail.shift()!.length;
    });
    proc.on("error", (e) => {
      this.proc = null; this.turnBusy = false; if (this.stopped) return;
      this.cb.log.error("copilot spawn failed", { detail: String((e as any)?.message ?? e) });
      this.cb.onActivity("offline", "copilot not found");
      if (!this.everSucceeded) this.cb.onExit(1); else this.pump();
    });
    proc.on("exit", (code) => {
      if (buf.trim()) processLine(buf); buf = "";
      this.proc = null; this.turnBusy = false; if (this.stopped) return;
      if (code === 0 || resultSeen) {
        this.everSucceeded = true; this.cb.onActivity("online", ""); this.pump(); return;
      }
      // Non-zero exit with no result: the error lives on stderr (e.g. an unavailable --model exits 1
      // with no JSON event). Surface it loudly rather than failing silently.
      const tail = errTail.join("").trim();
      const last = tail.split("\n").filter(Boolean).pop() || `copilot exited ${code ?? "signal"}`;
      this.cb.onTrajectory([{ kind: "text", text: "[copilot error] " + clip(tail).slice(0, 500) }]);
      this.cb.onActivity("error", last.slice(0, 200));
      if (!this.everSucceeded) { this.cb.onExit(code ?? 1); return; } // first-turn hard failure → crashed
      this.pump(); // a later turn failed; keep the session alive so the next message can retry
    });
  }

  stop(): void {
    this.stopped = true;
    const p = this.proc; this.proc = null;
    if (p) { killTree(p); }
  }
}

export const copilotRuntime: Runtime = {
  name: "copilot",
  experimental: true,
  start(opts: StartOpts, cb: RuntimeCallbacks): RuntimeSession {
    const run = new CopilotRun(opts, cb);
    return { deliver: (text) => run.enqueue(text), stop: () => run.stop() };
  },
};

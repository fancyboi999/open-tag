// Cursor runtime: one-shot `cursor-agent -p --output-format stream-json` per turn (like
// copilot/opencode/kimi/pi — not a persistent process), chained by the session id Cursor emits in its
// `system` event and passed back via `--resume`. Cursor's stream-json mirrors Claude Code's envelope
// (system / user / assistant / result) plus separate top-level `tool_call` events.
//
// Two load-bearing gotchas, verified against cursor-agent 2025.09.17:
//  1. NODE_OPTIONS is stripped from the child env — cursor-agent's bundled node refuses to start when
//     NODE_OPTIONS carries flags it doesn't allow (e.g. `--use-env-proxy`).
//  2. stdin is `ignore` (the prompt is an argv value); `-f` force-allows tools for headless runs.
// System prompt is injected via {cwd}/AGENTS.md (Cursor reads it natively; there is no prompt flag).
import { type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSafe } from "./spawnSafe.js";
import { killTree } from "./killTree.js";
import type { Runtime, StartOpts, RuntimeCallbacks, RuntimeSession, TrajectoryEntry } from "./runtime.js";

const MAX = 2000;
const clip = (s: unknown) => String(s ?? "").slice(0, MAX);

function summarizeToolArgs(args: any): string {
  if (!args || typeof args !== "object") return clip(args).slice(0, 160);
  const v = args.command ?? args.filePath ?? args.file_path ?? args.path ?? args.pattern ?? args.query ?? args.url ?? "";
  return clip(typeof v === "string" ? v : JSON.stringify(v)).slice(0, 160);
}

// ── pure event mapping (unit-tested against real fixtures) ──
export interface CursorEmit {
  trajectory: TrajectoryEntry[];
  sessionId?: string;
  error?: string;
  resultSeen?: boolean; // true when a `result` event was processed (helps exit handler avoid double-report)
}

// handleCursorEvent maps one parsed cursor-agent stream-json event. Verified vs 2025.09.17:
// every event carries `session_id`; tools arrive as separate `tool_call` events whose `tool_call`
// object has a single `<kind>ToolCall` key holding `.args`; the terminal `result` event carries the
// final assistant text + `is_error`. We surface tool_call (started, once) + the result text — the
// streamed `assistant` text chunks ("P","ONG"…) are skipped to avoid one trajectory row per token.
export function handleCursorEvent(evt: any): CursorEmit {
  const out: CursorEmit = { trajectory: [] };
  if (typeof evt?.session_id === "string" && evt.session_id) out.sessionId = evt.session_id;
  if (evt?.type === "tool_call" && evt.subtype === "started") {
    const tc = evt.tool_call;
    if (tc && typeof tc === "object") {
      const key = Object.keys(tc).find(k => k.endsWith("ToolCall")) ?? Object.keys(tc)[0] ?? "tool";
      const name = key.replace(/ToolCall$/, "") || "tool";
      out.trajectory.push({ kind: "tool", toolName: name, toolInput: summarizeToolArgs(tc[key]?.args) });
    }
  } else if (evt?.type === "result") {
    out.resultSeen = true;
    if (evt.is_error) out.error = clip(evt.result) || "cursor reported an error";
    else if (evt.result != null) out.trajectory.push({ kind: "text", text: clip(evt.result) });
  } else if (evt?.type === "system" && evt?.subtype === "error") {
    out.error = clip(evt.error ?? evt.message ?? "cursor system error");
  }
  return out;
}

function buildArgs(prompt: string, model: string | undefined, sessionId: string | null): string[] {
  const args = ["-p", prompt, "--output-format", "stream-json", "-f"];
  const m = model && model !== "default" ? model : "";
  if (m) args.push("--model", m);
  if (sessionId) args.push("--resume", sessionId);
  return args;
}

// CursorRun owns the serial turn queue for one agent (mirrors the other one-shot runtimes): each turn
// is a fresh `cursor-agent -p` process resumed by the captured session id.
class CursorRun {
  private queue: string[] = [];
  private turnBusy = false;
  private stopped = false;
  private proc: ChildProcess | null = null;
  private sessionId: string | null;
  private everSucceeded = false;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly opts: StartOpts, private readonly cb: RuntimeCallbacks) {
    this.sessionId = opts.sessionId ?? null;
    this.env = { ...opts.env };
    delete this.env.NODE_OPTIONS; // cursor-agent's bundled node rejects proxy flags in NODE_OPTIONS
    try { writeFileSync(path.join(opts.cwd, "AGENTS.md"), opts.systemPrompt); }
    catch (e) { cb.log.warn("cursor: AGENTS.md write failed", { detail: String(e) }); }
    if (this.sessionId) cb.onSession(this.sessionId);
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
    const args = buildArgs(prompt, this.opts.model, this.sessionId);
    const proc = spawnSafe("cursor-agent", args, { cwd: this.opts.cwd, stdio: ["ignore", "pipe", "pipe"], env: this.env });
    this.proc = proc;
    let buf = "";
    let resultSeen = false;
    let resultError = false; // any in-JSON error (result.is_error or system:error) — prevents double-report on exit
    const errTail: string[] = [];
    let errLen = 0;
    const processLine = (ln: string) => {
      const t = ln.trim(); if (!t) return;
      let evt: any; try { evt = JSON.parse(t); } catch { return; }
      const emit = handleCursorEvent(evt);
      if (emit.sessionId && emit.sessionId !== this.sessionId) { this.sessionId = emit.sessionId; this.cb.onSession(emit.sessionId); }
      if (emit.resultSeen) resultSeen = true;
      if (emit.error) { resultError = true; this.cb.onTrajectory([{ kind: "text", text: "[cursor error] " + clip(emit.error).slice(0, 500) }]); this.cb.onActivity("error", emit.error.slice(0, 200)); }
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
      this.cb.log.error("cursor spawn failed", { detail: String((e as any)?.message ?? e) });
      this.cb.onActivity("offline", "cursor-agent not found");
      if (!this.everSucceeded) this.cb.onExit(1); else this.pump();
    });
    proc.on("exit", (code) => {
      if (buf.trim()) processLine(buf); buf = "";
      this.proc = null; this.turnBusy = false; if (this.stopped) return;
      if (code === 0) {
        // cursor-agent exits 0 even on model errors (result.is_error / system:error already surfaced).
        // Only mark online + pump on genuine success; on error, respect the error status already set.
        if (!resultError) { this.everSucceeded = true; this.cb.onActivity("online", ""); }
        else if (!this.everSucceeded) { this.cb.onExit(1); return; }
        this.pump(); return;
      }
      // Non-zero exit: hard failure. Don't double-report if in-JSON error was already surfaced.
      if (!resultError) {
        const tail = errTail.join("").trim();
        const last = tail.split("\n").filter(Boolean).pop() || `cursor-agent exited ${code ?? "signal"}`;
        this.cb.onTrajectory([{ kind: "text", text: "[cursor error] " + clip(tail).slice(0, 500) }]);
        this.cb.onActivity("error", last.slice(0, 200));
      }
      if (!this.everSucceeded) { this.cb.onExit(code ?? 1); return; }
      this.pump();
    });
  }

  stop(): void {
    this.stopped = true;
    const p = this.proc; this.proc = null;
    if (p) { killTree(p); }
  }
}

export const cursorRuntime: Runtime = {
  name: "cursor",
  experimental: true,
  start(opts: StartOpts, cb: RuntimeCallbacks): RuntimeSession {
    const run = new CursorRun(opts, cb);
    return { deliver: (text) => run.enqueue(text), stop: () => run.stop() };
  },
};

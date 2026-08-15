// Cursor runtime: one-shot `cursor-agent -p --output-format stream-json` per turn (like
// copilot/opencode/kimi/pi — not a persistent process), chained by the session id Cursor emits in its
// `system` event and passed back via `--resume`. Cursor's stream-json mirrors Claude Code's envelope
// (system / user / assistant / result) plus separate top-level `tool_call` events.
//
// Two load-bearing gotchas, verified against cursor-agent 2025.09.17:
//  1. NODE_OPTIONS is stripped from the child env — cursor-agent's bundled node refuses to start when
//     NODE_OPTIONS carries flags it doesn't allow (e.g. `--use-env-proxy`).
//  2. stdin is `ignore` (the prompt is an argv value); `-f` force-allows tools for headless runs.
// Open-tag instructions are a managed always-on Cursor plugin rule passed with --plugin-dir. Cursor
// still reads the project's own AGENTS.md/CLAUDE.md/.cursor/rules alongside it; no project file is written.
import { type ChildProcess } from "node:child_process";
import path from "node:path";
import { spawnSafe } from "./spawnSafe.js";
import { killTree } from "./killTree.js";
import { initialTurnAdmission, protocolAdmission, type ProtocolAdmission, type Runtime, type StartOpts, type RuntimeCallbacks, type RuntimeSession, type TrajectoryEntry } from "./runtime.js";
import { writeRuntimeArtifact } from "./runtimeArtifacts.js";

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

export function buildCursorArgs(prompt: string, model: string | undefined, sessionId: string | null, pluginDir: string): string[] {
  const args = ["-p", prompt, "--output-format", "stream-json", "-f", "--plugin-dir", pluginDir];
  const m = model && model !== "default" ? model : "";
  if (m) args.push("--model", m);
  if (sessionId) args.push("--resume", sessionId);
  return args;
}

export function prepareCursorPlugin(stateDir: string, systemPrompt: string): string {
  const suffix = path.basename(stateDir).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  const manifest = JSON.stringify({ name: `open-tag-${suffix}`, version: "0.0.0", description: "open-tag managed runtime instructions" }, null, 2) + "\n";
  const rule = `---\ndescription: open-tag collaboration runtime\nglobs:\nalwaysApply: true\n---\n\n${systemPrompt}\n`;
  const manifestFile = writeRuntimeArtifact(stateDir, "cursor", "plugin/.cursor-plugin/plugin.json", manifest);
  writeRuntimeArtifact(stateDir, "cursor", "plugin/rules/open-tag.mdc", rule);
  return path.dirname(path.dirname(manifestFile));
}

// CursorRun owns the serial turn queue for one agent (mirrors the other one-shot runtimes): each turn
// is a fresh `cursor-agent -p` process resumed by the captured session id.
interface CursorInput { text: string; initial: boolean; admission: ProtocolAdmission }

class CursorRun {
  private queue: CursorInput[] = [];
  private turnBusy = false;
  private stopped = false;
  proc: ChildProcess | null = null;
  private sessionId: string | null;
  private everSucceeded = false;
  private readonly env: NodeJS.ProcessEnv;
  private readonly pluginDir: string;
  private readonly admission: ReturnType<typeof initialTurnAdmission>;
  private currentInput: CursorInput | null = null;
  private exitReported = false;

  private reportExit(code: number | null): void {
    if (this.exitReported) return;
    this.exitReported = true;
    this.cb.onExit(code);
  }

  constructor(private readonly opts: StartOpts, private readonly cb: RuntimeCallbacks) {
    this.admission = initialTurnAdmission(cb);
    this.sessionId = opts.sessionId ?? null;
    this.env = { ...opts.env };
    delete this.env.NODE_OPTIONS; // cursor-agent's bundled node rejects proxy flags in NODE_OPTIONS
    this.pluginDir = prepareCursorPlugin(opts.stateDir, opts.systemPrompt);
    if (this.sessionId) cb.onSession(this.sessionId);
    void this.enqueue(opts.initialPrompt, true).catch(() => {});
  }

  enqueue(text: string, initial = false): Promise<void> {
    const input: CursorInput = { text, initial, admission: protocolAdmission() };
    if (this.stopped) input.admission.reject(new Error("cursor stopped before input admission"));
    else { this.queue.push(input); this.pump(); }
    return input.admission.promise;
  }

  private pump(): void {
    if (this.stopped || this.turnBusy || this.queue.length === 0) return;
    this.runTurn(this.queue.shift()!);
  }

  private rejectQueue(error: Error): void {
    for (const input of this.queue.splice(0)) input.admission.reject(error);
  }

  private runTurn(input: CursorInput): void {
    this.currentInput = input;
    const prompt = input.text;
    this.turnBusy = true;
    this.cb.onActivity("working", "turn");
    const args = buildCursorArgs(prompt, this.opts.model, this.sessionId, this.pluginDir);
    const proc = spawnSafe("cursor-agent", args, { cwd: this.opts.cwd, stdio: ["ignore", "pipe", "pipe"], env: this.env });
    this.proc = proc;
    proc.once("spawn", () => { input.admission.accept(); if (input.initial) this.admission.accept(); });
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
      input.admission.reject(e);
      if (input.initial) this.admission.reject(e);
      if (this.currentInput === input) this.currentInput = null;
      this.proc = null; this.turnBusy = false; if (this.stopped) return;
      this.cb.log.error("cursor spawn failed", { detail: String((e as any)?.message ?? e) });
      this.cb.onActivity("offline", "cursor-agent not found");
      if (!this.everSucceeded) { this.rejectQueue(e instanceof Error ? e : new Error(String(e))); this.reportExit(1); } else this.pump();
    });
    proc.on("exit", (code) => {
      if (buf.trim()) processLine(buf); buf = "";
      this.proc = null; this.turnBusy = false; if (this.stopped) { this.reportExit(code); return; }
      if (this.currentInput === input) this.currentInput = null;
      if (code === 0) {
        // cursor-agent exits 0 even on model errors (result.is_error / system:error already surfaced).
        // Only mark online + pump on genuine success; on error, respect the error status already set.
        if (!resultError) { this.everSucceeded = true; this.cb.onActivity("online", ""); }
        else if (!this.everSucceeded) { this.rejectQueue(new Error("cursor initial turn failed")); this.reportExit(1); return; }
        else this.cb.onAcceptedTurnFailure();
        this.pump(); return;
      }
      // Non-zero exit: hard failure. Don't double-report if in-JSON error was already surfaced.
      if (!resultError) {
        const tail = errTail.join("").trim();
        const last = tail.split("\n").filter(Boolean).pop() || `cursor-agent exited ${code ?? "signal"}`;
        this.cb.onTrajectory([{ kind: "text", text: "[cursor error] " + clip(tail).slice(0, 500) }]);
        this.cb.onActivity("error", last.slice(0, 200));
      }
      if (!this.everSucceeded) { this.rejectQueue(new Error(`cursor-agent exited ${code ?? "signal"}`)); this.reportExit(code ?? 1); return; }
      this.cb.onAcceptedTurnFailure();
      this.pump();
    });
  }

  stop(): void {
    this.stopped = true;
    const error = new Error("cursor stopped before input admission");
    this.currentInput?.admission.reject(error); this.currentInput = null;
    this.rejectQueue(error);
    const p = this.proc; this.proc = null;
    if (p) killTree(p);
    else this.reportExit(0);
  }
}

export const cursorRuntime: Runtime = {
  name: "cursor",
  experimental: true,
  start(opts: StartOpts, cb: RuntimeCallbacks): RuntimeSession {
    const run = new CursorRun(opts, cb);
    return { get pid() { return run.proc?.pid ?? 0; }, deliver: (text) => run.enqueue(text), stop: () => run.stop() };
  },
};

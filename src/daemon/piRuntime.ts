// Pi runtime: one-shot `pi -p --mode json` per turn (like copilot/opencode/kimi — not a persistent
// process), chained by the session id Pi emits in its `session` event and passed back via `--session`.
// Pi (earendil-works/pi, the "Pi Coding Agent") has a native `--append-system-prompt` flag, so the
// standing prompt is written to a file and passed there (no AGENTS.md). Verified against pi 0.73.1.
//
// Provider/auth is Pi's own: it reads provider API keys from env and custom providers from its config
// (`pi --list-models`). The agent's model is a "provider/id" pattern (e.g. a gateway provider the host
// configured) — the host must have that provider set up, the same "CLI configured on the machine"
// contract as the other runtimes. stdin is closed (the prompt is an argv value).
import { type ChildProcess } from "node:child_process";
import { spawnSafe } from "./spawnSafe.js";
import { killTree } from "./killTree.js";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Runtime, StartOpts, RuntimeCallbacks, RuntimeSession, TrajectoryEntry } from "./runtime.js";

const MAX = 2000;
const clip = (s: unknown) => String(s ?? "").slice(0, MAX);

function summarizeToolArgs(args: any): string {
  if (!args || typeof args !== "object") return clip(args).slice(0, 160);
  const v = args.command ?? args.filePath ?? args.file_path ?? args.path ?? args.pattern ?? args.query ?? args.url ?? "";
  return clip(typeof v === "string" ? v : JSON.stringify(v)).slice(0, 160);
}

// ── pure event mapping (unit-tested against real fixtures) ──
export interface PiEmit {
  trajectory: TrajectoryEntry[];
  sessionId?: string;
  error?: string; // a model/turn error Pi reports IN the message (it still exits 0) — must be surfaced loudly
}

// handlePiEvent maps one parsed `pi -p --mode json` event to open-tag callbacks. Verified vs pi 0.73.1:
// a `session` event carries `.id`; `message_end` carries `.message` (role + content[] blocks of
// {type:"text",text} and {type:"toolCall",name,arguments}, plus stopReason/errorMessage). We read
// message_end only — `agent_end` repeats the final assistant message, so parsing both would double-count.
export function handlePiEvent(evt: any): PiEmit {
  const out: PiEmit = { trajectory: [] };
  if (evt?.type === "session" && typeof evt.id === "string") { out.sessionId = evt.id; return out; }
  if (evt?.type === "message_end" && evt.message?.role === "assistant") {
    const m = evt.message;
    if (Array.isArray(m.content))
      for (const b of m.content) {
        if (b?.type === "text" && b.text) out.trajectory.push({ kind: "text", text: clip(b.text) });
        else if (b?.type === "toolCall") out.trajectory.push({ kind: "tool", toolName: String(b.name ?? "tool"), toolInput: summarizeToolArgs(b.arguments) });
      }
    // Pi exits 0 even when the model call fails — the failure is in stopReason/errorMessage, not the exit
    // code. Surface it so a bad model/key/provider doesn't silently no-op (e.g. a litellm 400 from the gateway).
    if (m.stopReason === "error") out.error = String(m.errorMessage ?? "pi model error (no message)");
  }
  return out;
}

function buildArgs(prompt: string, model: string | undefined, sessionId: string | null, cwd: string, promptFile: string): string[] {
  const args = ["-p", prompt, "--mode", "json", "--append-system-prompt", promptFile, "--session-dir", cwd];
  const m = model && model !== "default" ? model : ""; // a Pi "provider/id" model pattern; "" → Pi's default provider
  if (m) args.push("--model", m);
  if (sessionId) args.push("--session", sessionId);
  return args;
}

// PiRun owns the serial turn queue for one agent (mirrors opencode/kimi's queue/pump): each turn is a
// fresh one-shot `pi -p` process resumed by the captured session id.
class PiRun {
  private queue: string[] = [];
  private turnBusy = false;
  private stopped = false;
  private proc: ChildProcess | null = null;
  private sessionId: string | null;
  private everSucceeded = false;
  private readonly promptFile: string;
  private readonly env: NodeJS.ProcessEnv;
  private promptWriteFailed = false;

  constructor(private readonly opts: StartOpts, private readonly cb: RuntimeCallbacks) {
    this.sessionId = opts.sessionId ?? null;
    this.promptFile = path.join(opts.cwd, ".pi-system-prompt.md");
    this.env = { ...opts.env };
    delete this.env.NODE_OPTIONS; // pi's bundled node rejects proxy flags (e.g. --use-env-proxy)
    try { writeFileSync(this.promptFile, opts.systemPrompt); }
    catch (e) { this.promptWriteFailed = true; cb.log.warn("pi: system-prompt write failed", { detail: String(e) }); }
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
    if (this.promptWriteFailed) {
      // System prompt couldn't be written at startup — fail loudly rather than running without it.
      this.cb.onTrajectory([{ kind: "text", text: "[pi error] system-prompt write failed — check cwd permissions" }]);
      this.cb.onActivity("error", "pi: system-prompt write failed");
      this.turnBusy = false; if (!this.everSucceeded) { this.cb.onExit(1); return; }
      return;
    }
    this.cb.onActivity("working", "turn");
    const args = buildArgs(prompt, this.opts.model, this.sessionId, this.opts.cwd, this.promptFile);
    const proc = spawnSafe("pi", args, { cwd: this.opts.cwd, stdio: ["ignore", "pipe", "pipe"], env: this.env });
    this.proc = proc;
    let buf = "";
    const errTail: string[] = [];
    let errLen = 0;
    const processLine = (ln: string) => {
      const t = ln.trim(); if (!t) return;
      let evt: any; try { evt = JSON.parse(t); } catch { return; }
      const emit = handlePiEvent(evt);
      if (emit.sessionId && emit.sessionId !== this.sessionId) { this.sessionId = emit.sessionId; this.cb.onSession(emit.sessionId); }
      if (emit.trajectory.length) this.cb.onTrajectory(emit.trajectory);
      if (emit.error) { // model/turn error reported in-message (pi still exits 0) — surface it, don't silently no-op
        this.cb.onTrajectory([{ kind: "text", text: "[pi error] " + clip(emit.error).slice(0, 500) }]);
        this.cb.onActivity("error", emit.error.slice(0, 200));
      }
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
      this.cb.log.error("pi spawn failed", { detail: String((e as any)?.message ?? e) });
      this.cb.onActivity("offline", "pi not found");
      if (!this.everSucceeded) this.cb.onExit(1); else this.pump();
    });
    proc.on("exit", (code) => {
      if (buf.trim()) processLine(buf); buf = "";
      this.proc = null; this.turnBusy = false; if (this.stopped) return;
      if (code === 0) { this.everSucceeded = true; this.cb.onActivity("online", ""); this.pump(); return; }
      const tail = errTail.join("").trim();
      const last = tail.split("\n").filter(Boolean).pop() || `pi exited ${code ?? "signal"}`;
      this.cb.onTrajectory([{ kind: "text", text: "[pi error] " + clip(tail).slice(0, 500) }]);
      this.cb.onActivity("error", last.slice(0, 200));
      if (!this.everSucceeded) { this.cb.onExit(code ?? 1); return; } // first-turn hard failure (bad provider/key) → crashed
      this.pump();
    });
  }

  stop(): void {
    this.stopped = true;
    const p = this.proc; this.proc = null;
    if (p) { killTree(p); }
  }
}

export const piRuntime: Runtime = {
  name: "pi",
  experimental: true,
  start(opts: StartOpts, cb: RuntimeCallbacks): RuntimeSession {
    const run = new PiRun(opts, cb);
    return { deliver: (text) => run.enqueue(text), stop: () => run.stop() };
  },
};

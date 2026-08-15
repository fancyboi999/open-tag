// Kimi Code runtime: one-shot `kimi -p --output-format stream-json` per turn (like copilot/opencode —
// not a persistent process), chained by the `session_...` id Kimi prints in its `session.resume_hint`
// event and passed back via `-r <id>`. Kimi <0.29 has no independent append-system-prompt flag;
// open-tag therefore repeats a compatibility instruction envelope on every one-shot turn. Project
// AGENTS.md and .kimi-code/AGENTS.md remain untouched and are still merged by Kimi itself.
//
// Auth is NOT via env: Kimi Code (kimi-code, the maintained successor to the deprecated kimi-cli)
// reads provider credentials only from ~/.kimi-code/config.toml. The host must have a provider +
// default_model configured there (e.g. an OpenAI-compatible gateway with a kimi-k2 model) — the same
// "the CLI must be set up on the machine" contract as claude (logged in) / codex (~/.codex).
// Verified against kimi-code 0.19.2. stdin is closed (stdio "ignore"): the prompt is an argv value.
import { type ChildProcess } from "node:child_process";
import { spawnSafe } from "./spawnSafe.js";
import { killTree } from "./killTree.js";
import { initialTurnAdmission, protocolAdmission, runtimeInstructionEnvelope, type ProtocolAdmission, type Runtime, type StartOpts, type RuntimeCallbacks, type RuntimeSession, type TrajectoryEntry } from "./runtime.js";

const MAX = 2000;
const clip = (s: unknown) => String(s ?? "").slice(0, MAX);

function summarizeToolArgs(argsJson: unknown): string {
  let a: any = argsJson;
  if (typeof a === "string") { try { a = JSON.parse(a); } catch { return clip(a).slice(0, 160); } }
  if (!a || typeof a !== "object") return "";
  const v = a.command ?? a.filePath ?? a.file_path ?? a.path ?? a.pattern ?? a.query ?? a.url ?? "";
  return clip(typeof v === "string" ? v : JSON.stringify(v)).slice(0, 160);
}

// ── pure event mapping (unit-tested against real fixtures) ──
export interface KimiEmit {
  trajectory: TrajectoryEntry[];
  activity?: { activity: string; detail: string };
  sessionId?: string;
}

// handleKimiEvent maps one parsed `kimi -p --output-format stream-json` line to open-tag callbacks.
// Kimi emits OpenAI-chat-message envelopes (verified vs 0.19.2): {role:"assistant", content},
// {role:"assistant", tool_calls:[{function:{name,arguments}}]}, {role:"tool", ...}, and a final
// {role:"meta", type:"session.resume_hint", session_id} carrying the id for `-r` resume.
export function handleKimiEvent(evt: any): KimiEmit {
  const out: KimiEmit = { trajectory: [] };
  if (evt?.role === "meta" && evt.type === "session.resume_hint" && typeof evt.session_id === "string") {
    out.sessionId = evt.session_id;
    return out;
  }
  if (evt?.role === "assistant") {
    if (typeof evt.content === "string" && evt.content) out.trajectory.push({ kind: "text", text: clip(evt.content) });
    if (Array.isArray(evt.tool_calls))
      for (const tc of evt.tool_calls) {
        const fn = tc?.function ?? {};
        out.trajectory.push({ kind: "tool", toolName: String(fn.name ?? "tool"), toolInput: summarizeToolArgs(fn.arguments) });
      }
  }
  // role:"tool" (results) and role:"user" (echo) are intentionally not surfaced — the tool *call* is
  // already shown from the assistant message, matching claude/codex/copilot/opencode trajectory frugality.
  return out;
}

function buildArgs(prompt: string, model: string | undefined, sessionId: string | null): string[] {
  const args = ["-p", prompt, "--output-format", "stream-json"];
  const m = model && model !== "default" ? model : ""; // a config.toml model alias; "" → use default_model
  if (m) args.push("-m", m);
  if (sessionId) args.push("-r", sessionId);
  return args;
}

export function isMissingKimiSession(stderr: string, sessionId: string): boolean {
  const text = stderr.toLowerCase();
  const id = sessionId.toLowerCase();
  return [`session "${id}" not found`, `session '${id}' not found`, `session ${id} not found`]
    .some((message) => text.includes(message));
}

export function buildKimiPrompt(systemPrompt: string, input: string): string {
  return runtimeInstructionEnvelope(systemPrompt, input);
}

// KimiRun owns the serial turn queue for one agent (mirrors opencode/copilot's queue/pump): each turn
// is a fresh one-shot `kimi -p` process resumed by the captured session id.
interface KimiInput { text: string; initial: boolean; admission: ProtocolAdmission }

class KimiRun {
  private queue: KimiInput[] = [];
  private turnBusy = false;
  private stopped = false;
  proc: ChildProcess | null = null;
  private sessionId: string | null;
  private everSucceeded = false;
  private readonly env: NodeJS.ProcessEnv;
  private readonly admission: ReturnType<typeof initialTurnAdmission>;
  private currentInput: KimiInput | null = null;
  private exitReported = false;

  private reportExit(code: number | null): void {
    if (this.exitReported) return;
    this.exitReported = true;
    this.cb.onExit(code);
  }

  constructor(private readonly opts: StartOpts, private readonly cb: RuntimeCallbacks) {
    this.admission = initialTurnAdmission(cb);
    this.sessionId = opts.sessionId ?? null;
    this.env = { ...opts.env, PWD: opts.cwd };
    delete this.env.NODE_OPTIONS; // kimi's bundled node rejects proxy flags (e.g. --use-env-proxy)
    if (this.sessionId) cb.onSession(this.sessionId);
    void this.enqueue(opts.initialPrompt, true).catch(() => {});
  }

  enqueue(text: string, initial = false): Promise<void> {
    const input: KimiInput = { text, initial, admission: protocolAdmission() };
    if (this.stopped) input.admission.reject(new Error("kimi stopped before input admission"));
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

  private runTurn(input: KimiInput): void {
    this.currentInput = input;
    const prompt = buildKimiPrompt(this.opts.systemPrompt, input.text);
    this.turnBusy = true;
    this.cb.onActivity("working", "turn");
    const resumeSessionId = this.sessionId;
    const args = buildArgs(prompt, this.opts.model, resumeSessionId);
    // stdin "ignore": kimi -p takes the prompt as argv; a live stdin is unnecessary (and risks blocking).
    const proc = spawnSafe("kimi", args, { cwd: this.opts.cwd, stdio: ["ignore", "pipe", "pipe"], env: this.env });
    this.proc = proc;
    proc.once("spawn", () => { input.admission.accept(); if (input.initial) this.admission.accept(); });
    let buf = "";
    const errTail: string[] = [];
    let errLen = 0;
    const processLine = (ln: string) => {
      const t = ln.trim(); if (!t) return;
      let evt: any; try { evt = JSON.parse(t); } catch { return; }
      const emit = handleKimiEvent(evt);
      if (emit.sessionId && emit.sessionId !== this.sessionId) { this.sessionId = emit.sessionId; this.cb.onSession(emit.sessionId); }
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
      input.admission.reject(e);
      if (input.initial) this.admission.reject(e);
      if (this.currentInput === input) this.currentInput = null;
      this.proc = null; this.turnBusy = false; if (this.stopped) return;
      this.cb.log.error("kimi spawn failed", { detail: String((e as any)?.message ?? e) });
      this.cb.onActivity("offline", "kimi not found");
      if (!this.everSucceeded) { this.rejectQueue(e instanceof Error ? e : new Error(String(e))); this.reportExit(1); } else this.pump();
    });
    proc.on("exit", (code) => {
      if (buf.trim()) processLine(buf); buf = "";
      this.proc = null; this.turnBusy = false; if (this.stopped) { this.reportExit(code); return; }
      if (this.currentInput === input) this.currentInput = null;
      if (code === 0) { this.everSucceeded = true; this.cb.onActivity("online", ""); this.pump(); return; }
      const tail = errTail.join("").trim();
      if (resumeSessionId && this.sessionId === resumeSessionId && isMissingKimiSession(tail, resumeSessionId)) {
        this.cb.log.warn("kimi resume session missing; retrying fresh", { sessionId: resumeSessionId });
        this.sessionId = null;
        this.queue.unshift(input);
        this.cb.onSession(null);
        this.pump();
        return;
      }
      const last = tail.split("\n").filter(Boolean).pop() || `kimi exited ${code ?? "signal"}`;
      this.cb.onTrajectory([{ kind: "text", text: "[kimi error] " + clip(tail).slice(0, 500) }]);
      this.cb.onActivity("error", last.slice(0, 200));
      if (!this.everSucceeded) { this.rejectQueue(new Error(last)); this.reportExit(code ?? 1); return; } // first-turn hard failure (bad config/auth) → crashed
      this.pump();
    });
  }

  stop(): void {
    this.stopped = true;
    const error = new Error("kimi stopped before input admission");
    this.currentInput?.admission.reject(error); this.currentInput = null;
    this.rejectQueue(error);
    const p = this.proc; this.proc = null;
    if (p) killTree(p);
    else this.reportExit(0);
  }
}

export const kimiRuntime: Runtime = {
  name: "kimi",
  experimental: true,
  start(opts: StartOpts, cb: RuntimeCallbacks): RuntimeSession {
    const run = new KimiRun(opts, cb);
    return { get pid() { return run.proc?.pid ?? 0; }, deliver: (text) => run.enqueue(text), stop: () => run.stop() };
  },
};

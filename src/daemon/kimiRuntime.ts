// Kimi Code runtime: one-shot `kimi -p --output-format stream-json` per turn (like copilot/opencode —
// not a persistent process), chained by the `session_...` id Kimi prints in its `session.resume_hint`
// event and passed back via `-r <id>`. System prompt is injected via {cwd}/AGENTS.md.
//
// Auth is NOT via env: Kimi Code (kimi-code, the maintained successor to the deprecated kimi-cli)
// reads provider credentials only from ~/.kimi-code/config.toml. The host must have a provider +
// default_model configured there (e.g. an OpenAI-compatible gateway with a kimi-k2 model) — the same
// "the CLI must be set up on the machine" contract as claude (logged in) / codex (~/.codex).
// Verified against kimi-code 0.19.2. stdin is closed (stdio "ignore"): the prompt is an argv value.
import { type ChildProcess } from "node:child_process";
import { spawnSafe } from "./spawnSafe.js";
import { killTree } from "./killTree.js";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Runtime, StartOpts, RuntimeCallbacks, RuntimeSession, TrajectoryEntry } from "./runtime.js";

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

// KimiRun owns the serial turn queue for one agent (mirrors opencode/copilot's queue/pump): each turn
// is a fresh one-shot `kimi -p` process resumed by the captured session id.
class KimiRun {
  private queue: string[] = [];
  private turnBusy = false;
  private stopped = false;
  private proc: ChildProcess | null = null;
  private sessionId: string | null;
  private everSucceeded = false;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly opts: StartOpts, private readonly cb: RuntimeCallbacks) {
    this.sessionId = opts.sessionId ?? null;
    this.env = { ...opts.env, PWD: opts.cwd };
    delete this.env.NODE_OPTIONS; // kimi's bundled node rejects proxy flags (e.g. --use-env-proxy)
    try { writeFileSync(path.join(opts.cwd, "AGENTS.md"), opts.systemPrompt); }
    catch (e) { cb.log.warn("kimi: AGENTS.md write failed", { detail: String(e) }); }
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
    // stdin "ignore": kimi -p takes the prompt as argv; a live stdin is unnecessary (and risks blocking).
    const proc = spawnSafe("kimi", args, { cwd: this.opts.cwd, stdio: ["ignore", "pipe", "pipe"], env: this.env });
    this.proc = proc;
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
      this.proc = null; this.turnBusy = false; if (this.stopped) return;
      this.cb.log.error("kimi spawn failed", { detail: String((e as any)?.message ?? e) });
      this.cb.onActivity("offline", "kimi not found");
      if (!this.everSucceeded) this.cb.onExit(1); else this.pump();
    });
    proc.on("exit", (code) => {
      if (buf.trim()) processLine(buf); buf = "";
      this.proc = null; this.turnBusy = false; if (this.stopped) return;
      if (code === 0) { this.everSucceeded = true; this.cb.onActivity("online", ""); this.pump(); return; }
      const tail = errTail.join("").trim();
      // Stale session: if kimi can't find the session (server restarted, TTL expired), clear it so the
      // next turn starts fresh rather than looping on the same bad resume id.
      if (/not found|no session|session .* not/i.test(tail)) this.sessionId = null;
      const last = tail.split("\n").filter(Boolean).pop() || `kimi exited ${code ?? "signal"}`;
      this.cb.onTrajectory([{ kind: "text", text: "[kimi error] " + clip(tail).slice(0, 500) }]);
      this.cb.onActivity("error", last.slice(0, 200));
      if (!this.everSucceeded) { this.cb.onExit(code ?? 1); return; } // first-turn hard failure (bad config/auth) → crashed
      this.pump();
    });
  }

  stop(): void {
    this.stopped = true;
    const p = this.proc; this.proc = null;
    if (p) { killTree(p); }
  }
}

export const kimiRuntime: Runtime = {
  name: "kimi",
  experimental: true,
  start(opts: StartOpts, cb: RuntimeCallbacks): RuntimeSession {
    const run = new KimiRun(opts, cb);
    return { deliver: (text) => run.enqueue(text), stop: () => run.stop() };
  },
};

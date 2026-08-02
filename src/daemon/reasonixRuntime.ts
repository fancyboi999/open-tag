// Reasonix runtime: one-shot `reasonix run --output-format stream-json` per turn, chained by
// resuming the session file reasonix persisted (`--resume <path>`, NOT a session id). Like copilot
// and opencode it is one-shot-per-turn (not a persistent process), so each deliver() spawns a fresh
// process that resumes via --resume.
//
// Verified against reasonix v1.18.0 (fixtures in src/daemon/__fixtures__/reasonix-*.jsonl) and
// re-verified live on v1.19.1 — the stream shape, flags, and session semantics below are unchanged:
//  1. `reasonix run --output-format stream-json` emits one eventwire JSON object per line followed
//     by a final result object. Errors come in two shapes: a non-zero exit + stderr text (spawn/
//     resume/config failures) OR an exit-0 result object with `is_error: true` (execution failures
//     such as a bad model or an invalid --effort — the validation error is serialized into the
//     result, not a non-zero exit) — both must be surfaced.
//  2. Sessions live at `<REASONIX_HOME>/projects/<encoded-cwd>/sessions/<session_id>.jsonl`, where
//     `<encoded-cwd>` is the cwd reasonix itself keys on. On v1.19.1 that is the LOGICAL cwd (it
//     honors the PWD env var; symlinks are NOT resolved — a run in /tmp/x lands in projects/-tmp-x
//     even where getcwd() is /private/tmp/x). v1.18.0 instead used getcwd(), which resolves
//     symlinks on macOS (/tmp → /private/tmp) but not bind mounts on Linux (Synology /var/services/
//     homes stays as-is). runTurn pins PWD to opts.cwd and reasonixSessionFile encodes cwd as given,
//     which matches v1.19.1 exactly; findReasonixSessionFile covers any residual mismatch. Every `/`
//     and `.` is replaced by `-`, and `<session_id>` is exactly the id the result object reports.
//     Resuming returns the SAME session_id, so the chain is stable across turns. `REASONIX_HOME`
//     defaults to `~/.reasonix`.
//  3. The standing system prompt is injected through runtimeInstructionEnvelope (see runTurn):
//     reasonix has no per-run custom-instructions flag (it reads the project's REASONIX.md /
//     AGENTS.md, which we must not rewrite), so the open-tag instructions travel inside the turn
//     message. Without the envelope reasonix treats the wake nudge as an original coding task and
//     spirals into a tool-exploration loop instead of answering.
//  4. stdin MUST be "ignore" — the prompt is passed as argv; a piped stdin would be read as the
//     prompt instead.
//  5. `tool_dispatch` is emitted twice per call (a `partial` marker, then the full event with
//     args). The mapper dedupes by tool id and only surfaces the full dispatch.
//  6. `--max-steps 100` bounds each one-shot run. Without it reasonix loops planner/executor until it
//     deems the task "done" — on open-tag wake nudges that is often never, so the process never
//     exits and the daemon stalls on proc "exit" (seen live on the NAS: a completed turn that never
//     terminated). A tight bound starved replies: the collaboration loop needs `message check` →
//     `message decide` → work → `message send` (~4+ tool rounds), so `--max-steps 3` hit the limit
//     mid-turn, reasonix forbade further tool calls, and the synthesized summary never reached the
//     channel. The cap is deliberately WIDE (100) as an observation setting: a livelock always
//     churns `tool_dispatch`, so if the cap were load-bearing it would fire and log a warn; if no
//     turn ever hits it, reasonix self-terminates on real tasks and the cap can be removed. Each
//     turn is a fresh resumed run, so multi-step work spans turns, not steps.
//  7. v1.18.0 AND v1.19.1 emit NO `reasoning` events: reasoning-capable providers report
//     `reasoningTokens > 0` in `usage` while the stream carries only `text` slices, with or without
//     `--show-thinking` (probed on hy3 / kimi-k3 / deepseek-pro). So thinking never reaches the
//     trajectory today; the `reasoning` branch + accumulator below are kept as a forward-compatible
//     no-op, not a live path.
import { type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { spawnSafe } from "./spawnSafe.js";
import { killTree } from "./killTree.js";
import { initialTurnAdmission, protocolAdmission, runtimeInstructionEnvelope, type ProtocolAdmission, type Runtime, type StartOpts, type RuntimeCallbacks, type RuntimeSession, type TrajectoryEntry } from "./runtime.js";

const MAX = 2000;
const clip = (s: unknown) => String(s ?? "").slice(0, MAX);
// Observation value: wide enough that real tasks never hit it, still bounding a livelock churn. A
// warn logs whenever a turn reaches it (see handleReasonixEvent's max-steps detection), so if it
// never fires across a watch period the cap is redundant and can be removed; if it fires, reasonix
// still needs the bound.
const MAX_STEPS = 100;
// The exact sentence reasonix injects once the tool-call round limit is reached, so the daemon can
// tell "cap fired" apart from a normal message and log it for the observation above.
const MAX_STEPS_REACHED_MARKER = "tool-call round limit";
// Probed against reasonix v1.18.0 and v1.19.1: an openai-kind provider rejects anything outside
// low|medium|high with an exit-0 `is_error: true` result ("effort must be low, medium, or high");
// `max` is accepted. `none`/`xhigh`/`minimal` (the claude/codex effort vocabulary) fail that way,
// so they must never reach argv.
const EFFORTS = new Set(["low", "medium", "high", "max"]);

function reasoningEffort(rc: Record<string, unknown> | null | undefined): string | null {
  const e = rc?.reasoningEffort;
  return typeof e === "string" && EFFORTS.has(e) ? e : null;
}

function summarizeToolArgs(args: unknown): string {
  if (!args || typeof args !== "string") return "";
  let parsed: unknown = args;
  try { parsed = JSON.parse(args); } catch { return clip(args).slice(0, 160); }
  if (!parsed || typeof parsed !== "object") return clip(args).slice(0, 160);
  const v = (parsed as any).command ?? (parsed as any).path ?? (parsed as any).file_path ?? (parsed as any).filePath ?? (parsed as any).pattern ?? (parsed as any).query ?? (parsed as any).url ?? "";
  return clip(typeof v === "string" ? v : JSON.stringify(v)).slice(0, 160);
}

// ── pure event mapping (unit-tested against real fixtures) ──
export interface ReasonixEmit {
  trajectory: TrajectoryEntry[];
  activity?: { activity: string; detail: string };
  sessionId?: string;
  error?: string;
  maxStepsReached?: boolean;
}

// handleReasonixEvent maps one parsed `reasonix run --output-format stream-json` line to open-tag
// callbacks. Lines are eventwire events ({kind, text, reasoning, tool, ...}) or the final result
// object ({type:"result", is_error, session_id, ...}). `seenTools` dedupes the partial+full
// tool_dispatch pair reasonix emits per tool call (see file header).
//
// reasonix stream-json is incremental: `text` and `reasoning` events carry one token slice at a
// time (`"没有"` → `"配置"` → `" M"` → `"CP"` …), while `message` carries the final assembled
// sentence. Pushing every slice verbatim makes the activity panel render one glyph per line. So:
//   - `text` slices are dropped (the `message` event is the authoritative assembled reply);
//   - `reasoning` slices accumulate in `acc.thinking` and flush as ONE thinking entry on a newline
//     boundary (or when the turn ends via flushReasonixThinking), keeping the thinking stream
//     readable instead of one line per token.
export interface ReasonixAcc {
  thinking: string;
}
export function flushReasonixThinking(acc: ReasonixAcc): TrajectoryEntry[] {
  const text = acc.thinking.trim();
  acc.thinking = "";
  return text ? [{ kind: "thinking", text: clip(text) }] : [];
}
export function handleReasonixEvent(evt: any, seenTools?: Set<string>, acc?: ReasonixAcc): ReasonixEmit {
  const out: ReasonixEmit = { trajectory: [] };
  const seen = seenTools ?? new Set<string>();
  if (evt?.type === "result") {
    if (typeof evt.session_id === "string" && evt.session_id) out.sessionId = evt.session_id;
    if (evt.is_error) out.error = String(evt.subtype ?? evt.result ?? "reasonix execution error").slice(0, 300);
    return out;
  }
  switch (evt?.kind) {
    case "turn_started":
    case "phase":
      out.activity = { activity: "working", detail: "turn" };
      break;
    case "text":
      // incremental token slices; the assembled `message` event below is the authoritative output
      break;
    case "message":
      if (evt.text) {
        if (String(evt.text).includes(MAX_STEPS_REACHED_MARKER)) out.maxStepsReached = true;
        out.trajectory.push({ kind: "text", text: clip(evt.text) });
      }
      break;
    case "reasoning": { // NOT emitted by v1.18.0/v1.19.1 (see header note 7) — mapped defensively for future builds
      const slice = evt.text ?? "";
      if (!slice) break;
      if (acc) {
        acc.thinking += slice;
        if (/\n/.test(slice)) out.trajectory.push(...flushReasonixThinking(acc));
      } else {
        out.trajectory.push({ kind: "thinking", text: clip(slice) });
      }
      break;
    }
    case "tool_dispatch": {
      const t = evt?.tool ?? {};
      const id = String(t.id ?? "");
      if (id && seen.has(id)) break; // full dispatch already surfaced
      if (t.partial && !t.args) break; // the partial marker arrives before the full event with args
      const name = String(t.name ?? "tool");
      out.trajectory.push({ kind: "tool", toolName: name, toolInput: summarizeToolArgs(t.args) });
      if (id) seen.add(id);
      break;
    }
    // tool_result / usage / notice / approval_request / turn_done / …: the result object (type=result)
    // and process exit are the authoritative turn-done signals.
  }
  return out;
}

function reasonixRoot(home?: string): string {
  return home ?? process.env.REASONIX_HOME ?? path.join(homedir(), ".reasonix");
}

// The session file reasonix persists for a session id, under the resolved REASONIX home. `--resume`
// needs this exact path (a session id alone makes reasonix try to open it as a file and fail).
export function reasonixSessionFile(sessionId: string, cwd: string, home?: string): string {
  // reasonix keys session storage on the cwd it itself runs with. v1.19.1 honors the PWD env var
  // (the LOGICAL cwd — a run in /tmp/x writes projects/-tmp-x even though getcwd() is /private/tmp/x
  // on macOS), while v1.18.0 used getcwd() (resolving symlinks on macOS but not bind mounts on
  // Linux). runTurn pins PWD to opts.cwd on both, so encoding cwd as given matches v1.19.1 exactly;
  // v1.18.0 is covered by findReasonixSessionFile when the spelling differs.
  const encoded = cwd.replace(/[/.]/g, "-");
  return path.join(reasonixRoot(home), "projects", encoded, "sessions", sessionId + ".jsonl");
}

// Last-resort resume lookup. The computed path above matches whenever reasonix's project-dir encoding
// equals the cwd we launched with, but a host can reach the cwd through a mount the two sides spell
// differently (Synology: /var/services/homes ↔ /volumeX/homes), leaving the computed file missing and
// every turn restarting fresh. Searching each project dir by session id is independent of how the path
// was encoded, so it finds the file regardless.
export function findReasonixSessionFile(sessionId: string, home?: string): string | null {
  const projectsDir = path.join(reasonixRoot(home), "projects");
  let dirs: string[];
  try { dirs = readdirSync(projectsDir); } catch { return null; }
  for (const dir of dirs) {
    const file = path.join(projectsDir, dir, "sessions", sessionId + ".jsonl");
    if (existsSync(file)) return file;
  }
  return null;
}

export function buildArgs(message: string, opts: StartOpts, sessionFile: string | null): string[] {
  const args = ["run", "--output-format", "stream-json", "--permission-mode", "bypassPermissions"];
  const model = opts.model && opts.model !== "default" ? opts.model : "";
  if (model) args.push("--model", model);
  const effort = reasoningEffort(opts.runtimeConfig);
  if (effort) args.push("--effort", effort);
  // Bound tool-call rounds per one-shot turn. Without --max-steps reasonix loops its planner/executor
  // until it deems a task "done" (often never on open-tag wake nudges), so the process never exits
  // and the daemon stalls waiting on proc "exit". MAX_STEPS is an observation setting (see its
  // definition): wide enough that real collaboration turns (check → decide → work → send) never hit
  // it, still bounding a livelock; a warn logs when a turn actually reaches it.
  args.push("--max-steps", String(MAX_STEPS));
  if (sessionFile) args.push("--resume", sessionFile);
  args.push(message);
  return args;
}

// ReasonixRun owns the serial turn queue for one agent (mirrors codex/copilot/opencode's queue +
// pump), but each turn is a fresh one-shot `reasonix run` process resumed by the session file.
interface ReasonixInput { text: string; initial: boolean; admission: ProtocolAdmission }

class ReasonixRun {
  private queue: ReasonixInput[] = [];
  private turnBusy = false;
  private stopped = false;
  proc: ChildProcess | null = null;
  private sessionId: string | null;
  private everSucceeded = false;
  private readonly env: NodeJS.ProcessEnv;
  private readonly admission: ReturnType<typeof initialTurnAdmission>;
  private currentInput: ReasonixInput | null = null;
  private exitReported = false;

  private reportExit(code: number | null): void {
    if (this.exitReported) return;
    this.exitReported = true;
    this.cb.onExit(code);
  }

  constructor(private readonly opts: StartOpts, private readonly cb: RuntimeCallbacks) {
    this.admission = initialTurnAdmission(cb);
    this.sessionId = opts.sessionId ?? null; // resume an existing session, or null = fresh one
    // Pin PWD to the operator project root (spawn does not set it) — reasonix resolves config and
    // session storage from the project root, mirroring the opencode runtime's PWD pinning.
    this.env = { ...opts.env, PWD: opts.cwd };
    if (this.sessionId) cb.onSession(this.sessionId);
    void this.enqueue(opts.initialPrompt, true).catch(() => {});
  }

  enqueue(text: string, initial = false): Promise<void> {
    const input: ReasonixInput = { text, initial, admission: protocolAdmission() };
    if (this.stopped) input.admission.reject(new Error("reasonix stopped before input admission"));
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

  private runTurn(input: ReasonixInput): void {
    this.currentInput = input;
    this.turnBusy = true;
    this.cb.onActivity("working", "turn");
    // reasonix has no separate system/custom-instruction channel: the standing open-tag system
    // prompt must ride inside the turn message. Wrap it in the envelope so the nudge reads as
    // collaboration context, not as an original coding task (reasonix would otherwise treat
    // "run `open-tag message check`" as a task and spiral into a tool-exploration loop).
    const prompt = runtimeInstructionEnvelope(this.opts.systemPrompt, input.text);
    // Resolve the persisted session file (--resume takes a file path, not an id). If the file is
    // gone (state wiped / different home), fall back to a fresh session rather than failing the turn.
    let sessionFile: string | null = null;
    if (this.sessionId) {
      const computed = reasonixSessionFile(this.sessionId, this.opts.cwd);
      // The computed path assumes reasonix encodes the project dir from the cwd we launched with; on
      // hosts where it does not (mount spelled differently on either side), fall back to a by-id
      // search so --resume still finds the file.
      const file = existsSync(computed) ? computed : findReasonixSessionFile(this.sessionId);
      if (file) sessionFile = file;
      else this.cb.log.warn("reasonix session file missing; starting a fresh session", { sessionId: this.sessionId, computed });
    }
    const args = buildArgs(prompt, this.opts, sessionFile);
    // stdin "ignore" is mandatory: the prompt rides as argv, so a piped stdin would be read as input.
    const proc = spawnSafe("reasonix", args, { cwd: this.opts.cwd, stdio: ["ignore", "pipe", "pipe"], env: this.env });
    this.proc = proc;
    proc.once("spawn", () => { input.admission.accept(); if (input.initial) this.admission.accept(); });
    const seenTools = new Set<string>();
    const acc: ReasonixAcc = { thinking: "" };
    let buf = "";
    const errTail: string[] = [];
    let errLen = 0;
    const flushThinking = () => {
      const flushed = flushReasonixThinking(acc);
      if (flushed.length) this.cb.onTrajectory(flushed);
    };
    const processLine = (ln: string) => {
      const t = ln.trim(); if (!t) return;
      let evt: any; try { evt = JSON.parse(t); } catch { return; }
      const emit = handleReasonixEvent(evt, seenTools, acc);
      if (emit.sessionId && emit.sessionId !== this.sessionId) {
        this.sessionId = emit.sessionId; // capture the id reasonix assigned so the next turn --resume-s it
        this.cb.onSession(emit.sessionId);
      }
      if (emit.error) { flushThinking(); this.cb.onTrajectory([{ kind: "text", text: "[reasonix error] " + emit.error }]); this.cb.onActivity("error", emit.error.slice(0, 200)); }
      if (emit.maxStepsReached) this.cb.log.warn("reasonix reached --max-steps (cap may still be load-bearing)", { steps: MAX_STEPS });
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
      this.cb.log.error("reasonix spawn failed", { detail: String((e as any)?.message ?? e) });
      this.cb.onActivity("offline", "reasonix not found");
      if (!this.everSucceeded) { this.rejectQueue(e instanceof Error ? e : new Error(String(e))); this.reportExit(1); } else this.pump();
    });
    proc.on("exit", (code) => {
      if (buf.trim()) processLine(buf); buf = "";
      flushThinking(); // any reasoning trailing the last newline boundary still surfaces
      this.proc = null; this.turnBusy = false; if (this.stopped) { this.reportExit(code); return; }
      if (this.currentInput === input) this.currentInput = null;
      if (code === 0) { this.everSucceeded = true; this.cb.onActivity("online", ""); this.pump(); return; }
      const tail = errTail.join("").trim();
      const last = tail.split("\n").filter(Boolean).pop() || `reasonix exited ${code ?? "signal"}`;
      this.cb.onTrajectory([{ kind: "text", text: "[reasonix error] " + clip(tail).slice(0, 500) }]);
      this.cb.onActivity("error", last.slice(0, 200));
      if (!this.everSucceeded) { this.rejectQueue(new Error(last)); this.reportExit(code ?? 1); return; } // first-turn hard failure → crashed
      this.pump(); // later-turn failure → keep the session alive so the next message can retry
    });
  }

  stop(): void {
    this.stopped = true;
    const error = new Error("reasonix stopped before input admission");
    this.currentInput?.admission.reject(error); this.currentInput = null;
    this.rejectQueue(error);
    const p = this.proc; this.proc = null;
    if (p) killTree(p);
    else this.reportExit(0);
  }
}

export const reasonixRuntime: Runtime = {
  name: "reasonix",
  experimental: true,
  start(opts: StartOpts, cb: RuntimeCallbacks): RuntimeSession {
    const run = new ReasonixRun(opts, cb);
    return { get pid() { return run.proc?.pid ?? 0; }, deliver: (text) => run.enqueue(text), stop: () => run.stop() };
  },
};

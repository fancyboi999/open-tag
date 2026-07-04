// Hermes runtime: one-shot `hermes chat -q <prompt> -Q --source open-tag` per turn.
//
// Hermes owns provider credentials and profile configuration. OpenTag only selects a Hermes profile
// (temporarily stored in agent.model) and passes the OpenTag system prompt + message into an isolated
// agent workspace. This keeps secrets in Hermes config, not in the OpenTag database.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { Runtime, StartOpts, RuntimeCallbacks, RuntimeSession } from "./runtime.js";

const MAX = 4000;
const clip = (s: unknown) => String(s ?? "").slice(0, MAX);
const FINAL_RESPONSE_MAX = 2400;

export function hermesProfile(model: string | undefined, runtimeConfig: Record<string, unknown> | null | undefined): string {
  const configured = runtimeConfig?.profile;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  if (model && model !== "default") return model;
  return "default";
}

export function hermesProfileRoots(home = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  return [env.HERMES_PROFILE_DIR, path.join(home, ".hermes", "profiles")].filter((v): v is string => !!v);
}

export function buildHermesPrompt(message: string, opts: Pick<StartOpts, "cwd" | "systemPrompt">): string {
  return [
    "[OpenTag runtime context]",
    `You are running as an OpenTag agent in this isolated workspace: ${opts.cwd}`,
    "Follow this OpenTag system prompt for collaboration, @mentions, and reporting:",
    opts.systemPrompt,
    "",
    "[OpenTag message]",
    message,
  ].join("\n");
}

export function buildHermesArgs(prompt: string, sessionId?: string | null): string[] {
  const args = ["chat", "-q", prompt, "-Q", "--source", "open-tag"];
  if (sessionId) args.push("--resume", sessionId);
  return args;
}

interface TurnState { sent: boolean; held: boolean; engaged: boolean; target: string | null; }
type BridgeDecision = { ok: true; target: string; content: string } | { ok: false; reason: string };
interface BridgePostResult { ok: boolean; held?: boolean; sentDraft?: boolean; status?: number; text?: string }

export function parseHermesSessionId(stderr: string): string | null {
  const matches = [...stderr.matchAll(/^session_id:\s*(\S+)\s*$/gm)];
  return matches.length ? matches[matches.length - 1]![1]! : null;
}

function isMissingHermesSession(stderr: string): boolean {
  return /Session not found:/i.test(stderr);
}

export function parseHermesTurnEvents(jsonl: string): TurnState {
  const state: TurnState = { sent: false, held: false, engaged: false, target: null };
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let evt: any;
    try { evt = JSON.parse(line); } catch { continue; }
    if (evt.type === "send") state.sent = true;
    if (evt.type === "held") state.held = true;
    if ((evt.type === "check" || evt.type === "read") && typeof evt.target === "string" && evt.target.trim()) {
      state.engaged = true;
      state.target = evt.target.trim();
    }
  }
  return state;
}

function cleanHermesStdout(stdout: string): BridgeDecision {
  let lines = stdout.trim().split(/\r?\n/).map((line) => line.trimEnd());
  while (lines.length && !lines[0]!.trim()) lines.shift();
  while (lines.length && /^(⚠|Warning:)/.test(lines[0]!.trim())) lines.shift();
  while (lines.length && !lines[0]!.trim()) lines.shift();
  const content = lines.join("\n").trim();
  if (!content) return { ok: false, reason: "empty-stdout" };
  if (/^(No new messages\.|Sent to |Freshness hold:)/.test(content)) return { ok: false, reason: "cli-output" };
  if (/^(Error:|Code:|Exception:|Traceback\b|Unhandled\b)/i.test(content)) return { ok: false, reason: "error-output" };
  if (/^(┊|diff --git\b|@@\s+-|\+\+\+ |--- )/m.test(content) || /\na\/.+\s+→\s+b\/.+/.test(content)) {
    return { ok: false, reason: "diff-output" };
  }
  return { ok: true, target: "", content: content.slice(0, FINAL_RESPONSE_MAX) };
}

export function hermesBridgeDecision(stdout: string, state: TurnState): BridgeDecision {
  if (state.sent) return { ok: false, reason: "already-sent" };
  if (state.held) return { ok: false, reason: "already-held" };
  if (!state.engaged || !state.target) return { ok: false, reason: "no-open-tag-read" };
  if (!/^(#|dm:|thread:)/.test(state.target)) return { ok: false, reason: "invalid-target" };
  const cleaned = cleanHermesStdout(stdout);
  if (!cleaned.ok) return cleaned;
  return { ok: true, target: state.target, content: cleaned.content };
}

async function responseJson(res: Response): Promise<any> {
  try { return await res.json(); } catch { return {}; }
}

export async function postHermesBridgeMessage(
  fetchImpl: typeof fetch,
  serverUrl: string,
  headers: Record<string, string>,
  target: string,
  content: string,
): Promise<BridgePostResult> {
  const url = `${serverUrl}/agent-api/message/send`;
  const first = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ target, content }),
  });
  const firstBody = await responseJson(first);
  if (!first.ok) return { ok: false, status: first.status };
  if (!firstBody?.held) return { ok: true };
  const held: BridgePostResult = { ok: false, held: true, sentDraft: false };
  if (typeof firstBody.text === "string") held.text = firstBody.text;
  return held;
}

export function hermesProfileHome(profile: string, home = homedir(), roots = hermesProfileRoots(home)): string | null {
  if (!profile || profile === "default") return null;
  for (const root of roots) {
    const dir = path.join(root, profile);
    if (existsSync(dir)) return dir;
  }
  return null;
}

export function hermesRuntimeEnv(baseEnv: NodeJS.ProcessEnv, cwd: string, requestedProfile: string, home = homedir()): { env: NodeJS.ProcessEnv; profile: string } {
  const env: NodeJS.ProcessEnv = { ...baseEnv, PWD: cwd };
  delete env.NODE_OPTIONS;
  delete env.HERMES_HOME;
  delete env.HERMES_PROFILE;
  const profileHome = hermesProfileHome(requestedProfile, home, hermesProfileRoots(home, env));
  const profile = requestedProfile === "default" || profileHome ? requestedProfile : "default";
  if (profileHome) {
    env.HERMES_HOME = profileHome;
    env.HERMES_PROFILE = profile;
  }
  return { env, profile };
}

class HermesRun {
  private queue: string[] = [];
  private turnBusy = false;
  private stopped = false;
  private proc: ChildProcess | null = null;
  private everSucceeded = false;
  private readonly env: NodeJS.ProcessEnv;
  private readonly profile: string;
  private sessionId: string | null;

  constructor(private readonly opts: StartOpts, private readonly cb: RuntimeCallbacks) {
    const requestedProfile = hermesProfile(opts.model, opts.runtimeConfig);
    const resolved = hermesRuntimeEnv(opts.env, opts.cwd, requestedProfile);
    this.env = resolved.env;
    this.profile = resolved.profile;
    if (requestedProfile !== "default" && this.profile === "default") {
      cb.log.warn("hermes profile not found; using default profile", { profile: requestedProfile });
    }
    this.sessionId = opts.sessionId ?? null;
    if (this.sessionId) cb.onSession(this.sessionId);
    if (opts.initialPrompt.trim()) this.enqueue(opts.initialPrompt);
  }

  enqueue(text: string): void {
    if (this.stopped || !text.trim()) return;
    this.queue.push(text);
    this.pump();
  }

  private pump(): void {
    if (this.stopped || this.turnBusy || this.queue.length === 0) return;
    this.runTurn(this.queue.shift()!);
  }

  private runTurn(message: string): void {
    this.turnBusy = true;
    this.cb.onActivity("working", `hermes/${this.profile}`);
    const prompt = buildHermesPrompt(message, this.opts);
    const args = buildHermesArgs(prompt, this.sessionId);
    const turnFile = path.join(tmpdir(), `open-tag-hermes-turn-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    const proc = spawn("hermes", args, { cwd: this.opts.cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...this.env, OPEN_TAG_TURN_FILE: turnFile } });
    this.proc = proc;
    let stdout = "";
    const errTail: string[] = [];
    let errLen = 0;
    proc.stdout?.on("data", (c: Buffer) => {
      if (this.stopped) return;
      if (stdout.length < MAX) stdout += c.toString();
    });
    proc.stderr?.on("data", (c: Buffer) => {
      const t = c.toString();
      errTail.push(t);
      errLen += t.length;
      while (errLen > 16_384 && errTail.length > 1) errLen -= errTail.shift()!.length;
    });
    proc.on("error", (e) => {
      this.proc = null;
      this.turnBusy = false;
      if (this.stopped) return;
      this.cb.log.error("hermes spawn failed", { detail: String((e as any)?.message ?? e) });
      this.cb.onActivity("offline", "hermes not found");
      if (!this.everSucceeded) this.cb.onExit(1);
      else this.pump();
    });
    proc.on("exit", async (code) => {
      this.proc = null;
      if (this.stopped) return;
      const out = stdout.trim();
      const tail = errTail.join("").trim();
      if (code === 0) {
        this.everSucceeded = true;
        const nextSessionId = parseHermesSessionId(tail);
        if (nextSessionId && nextSessionId !== this.sessionId) {
          this.sessionId = nextSessionId;
          this.cb.onSession(nextSessionId);
        }
        const bridged = await this.bridgeFinalResponse(turnFile, out);
        if (out) this.cb.onTrajectory([{ kind: "text", text: clip(out) }]);
        if (bridged !== false) this.cb.onActivity("online", "");
        this.turnBusy = false;
        this.pump();
        return;
      }
      if (this.sessionId && isMissingHermesSession(tail)) {
        this.cb.log.warn("hermes resume session missing; retrying fresh", { sessionId: this.sessionId });
        this.sessionId = null;
        this.cb.onSession(null);
        this.queue.unshift(message);
        this.turnBusy = false;
        this.pump();
        return;
      }
      const last = tail.split("\n").filter(Boolean).pop() || `hermes exited ${code ?? "signal"}`;
      this.cb.onTrajectory([{ kind: "text", text: "[hermes error] " + clip(tail || last).slice(0, 800) }]);
      this.cb.onActivity("error", last.slice(0, 200));
      this.turnBusy = false;
      if (!this.everSucceeded) {
        this.cb.onExit(code ?? 1);
        return;
      }
      this.pump();
    });
  }

  private async bridgeFinalResponse(turnFile: string, stdout: string): Promise<boolean | null> {
    let state: TurnState = { sent: false, held: false, engaged: false, target: null };
    try { state = parseHermesTurnEvents(await readFile(turnFile, "utf8")); }
    catch { /* no CLI side-channel events recorded */ }
    finally { try { await unlink(turnFile); } catch { /* best-effort cleanup */ } }
    const decision = hermesBridgeDecision(stdout, state);
    if (!decision.ok) {
      if (stdout.trim() && decision.reason !== "already-sent") {
        this.cb.log.warn("hermes final response not bridged", { reason: decision.reason });
        this.cb.onActivity("error", `hermes reply not sent (${decision.reason})`);
        return false;
      }
      return null;
    }
    try {
      const result = await postHermesBridgeMessage(fetch, this.env.OPEN_TAG_SERVER_URL ?? "", {
        authorization: `Bearer ${this.env.OPEN_TAG_AGENT_TOKEN ?? ""}`,
        "x-agent-id": this.env.OPEN_TAG_AGENT_ID ?? "",
        "content-type": "application/json",
      }, decision.target, decision.content);
      if (!result.ok) {
        if (result.held) {
          this.cb.log.warn("hermes final response freshness-held; draft saved for review", { target: decision.target });
          if (result.text) this.cb.onTrajectory([{ kind: "status", text: "[open-tag freshness hold]\n" + clip(result.text) }]);
          this.cb.onActivity("error", "hermes reply held for freshness review");
          return false;
        }
        this.cb.log.warn("hermes final response bridge failed", { status: result.status, target: decision.target });
        this.cb.onActivity("error", "hermes bridge send failed");
        return false;
      } else {
        this.cb.log.info("hermes final response bridged", { target: decision.target, chars: decision.content.length, held: !!result.held });
        return true;
      }
    } catch (e) {
      this.cb.log.warn("hermes final response bridge failed", { detail: String((e as any)?.message ?? e), target: decision.target });
      this.cb.onActivity("error", "hermes bridge send failed");
      return false;
    }
  }

  stop(): void {
    this.stopped = true;
    const p = this.proc;
    this.proc = null;
    if (p) {
      try { p.kill("SIGTERM"); } catch { /* */ }
    }
  }
}

export const hermesRuntime: Runtime = {
  name: "hermes",
  experimental: true,
  oneShotWake: true,
  start(opts: StartOpts, cb: RuntimeCallbacks): RuntimeSession {
    const run = new HermesRun(opts, cb);
    return { deliver: (text) => run.enqueue(text), stop: () => run.stop() };
  },
};

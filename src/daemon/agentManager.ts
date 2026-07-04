// Manages local agents: spawns processes via the runtime interface, bridges events to the server, and handles delivery/sleep. Runtime protocol details live in each runtime file.
import { mkdir, writeFile, readFile, access, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildSystemPrompt, STARTUP_NUDGE, RESUME_NUDGE, ONE_SHOT_WAKE_NUDGE, inboxNotice } from "./prompt.js";
import { seedMemory, applyProfileToMemory } from "./memory.js";
import { ensureOpenTagBin } from "./openTagBin.js";
import { getRuntime } from "./runtimes.js";
import type { Runtime, RuntimeSession, RuntimeCallbacks } from "./runtime.js";
import { createLogger } from "../log.js";
import { agentsDir } from "../paths.js";

const DATA_DIR = agentsDir();
const IDLE_MS = Number(process.env.OPEN_TAG_IDLE_MS ?? 10 * 60 * 1000); // how long before idle sleep (kills process to save memory; next wake uses --resume)
const DELIVER_DEBOUNCE_MS = Number(process.env.OPEN_TAG_DELIVER_DEBOUNCE_MS ?? 3000); // batching window for deliveries while agent is busy (saves tokens, reduces interruptions)
const ONE_SHOT_DELIVER_DEBOUNCE_MS = Number(process.env.OPEN_TAG_ONE_SHOT_DELIVER_DEBOUNCE_MS ?? process.env.OPEN_TAG_HERMES_DELIVER_DEBOUNCE_MS ?? 500); // One-shot runtimes need a short fixed wait when there is only one live notice.
const PENDING_DELIVER_TTL_MS = Number(process.env.OPEN_TAG_PENDING_DELIVER_TTL_MS ?? 15_000); // start+deliver can arrive back-to-back; keep deliver briefly while start prepares workspace

export interface AgentConfig {
  name: string; displayName: string; description?: string | null;
  model?: string; runtime?: string; runtimeConfig?: Record<string, unknown> | null; sessionId?: string;
  serverUrl: string; serverId: string; agentId: string; agentToken?: string; // per-agent token (slice10); re-sent start for a running agent may omit it (daemon ignores)
}
interface DeliverBuf { count: number; from: string; target: string; targetName: string; firstShort: string; latestShort: string; isTask: boolean; mentioned: boolean; targets: Set<string>; timer: ReturnType<typeof setTimeout>; }
export interface DeliverMeta { targetName?: string; msgShort?: string; isTask?: boolean; }
interface Running { session: RuntimeSession; config: AgentConfig; sessionId: string | null; idleTimer?: ReturnType<typeof setTimeout>; deliverBuf?: DeliverBuf; }
interface PendingDeliver { from: string; target: string; mentioned: boolean; meta: DeliverMeta; }
interface PendingDeliverQueue { items: PendingDeliver[]; timer: ReturnType<typeof setTimeout>; }
interface AgentManagerOptions {
  dataDir?: string;
  binDir?: string;
  deliverDebounceMs?: number;
  oneShotDeliverDebounceMs?: number;
  pendingDeliverTtlMs?: number;
  runtimeResolver?: (name: string) => Runtime | null;
}

export class AgentManager {
  private agents = new Map<string, Running>();
  private starting = new Map<string, Promise<void>>();
  private pendingDelivers = new Map<string, PendingDeliverQueue>();
  private binDir: string;
  private dataDir: string;
  private deliverDebounceMs: number;
  private oneShotDeliverDebounceMs: number;
  private pendingDeliverTtlMs: number;
  private runtimeResolver: (name: string) => Runtime | null;
  private log = createLogger("daemon:agents");
  constructor(private send: (msg: unknown) => void, opts: AgentManagerOptions = {}) {
    this.binDir = opts.binDir ?? ensureOpenTagBin();
    this.dataDir = opts.dataDir ?? DATA_DIR;
    this.deliverDebounceMs = opts.deliverDebounceMs ?? DELIVER_DEBOUNCE_MS;
    this.oneShotDeliverDebounceMs = opts.oneShotDeliverDebounceMs ?? ONE_SHOT_DELIVER_DEBOUNCE_MS;
    this.pendingDeliverTtlMs = opts.pendingDeliverTtlMs ?? PENDING_DELIVER_TTL_MS;
    this.runtimeResolver = opts.runtimeResolver ?? getRuntime;
  }

  running(): string[] { return [...this.agents.keys()]; }
  stopAll(): void { for (const id of [...this.agents.keys()]) this.stop(id); }
  // Tear down process: clear timers + remove from map first (critical: deletion before session.stop() lets the onExit has() guard recognize this as an intentional stop, suppressing unexpected sleeping status) + stop runtime. Returns whether the agent was found.
  private teardown(agentId: string): boolean { this.clearPendingDeliver(agentId); const r = this.agents.get(agentId); if (!r) return false; if (r.idleTimer) clearTimeout(r.idleTimer); if (r.deliverBuf) clearTimeout(r.deliverBuf.timer); this.agents.delete(agentId); r.session.stop(); return true; }
  // User-initiated stop: emits inactive/offline
  stop(agentId: string): void { if (!this.teardown(agentId)) return; this.send({ type: "agent:status", agentId, status: "inactive" }); this.send({ type: "agent:activity", agentId, activity: "offline", detail: "" }); }
  // Idle sleep: emits sleeping/sleeping (activity also set to sleeping so the frontend activity+status dual mapping stays consistent; session is preserved for --resume on next wake)
  sleep(agentId: string): void { if (!this.teardown(agentId)) return; this.log.info("sleep", { agentId }); this.send({ type: "agent:status", agentId, status: "sleeping" }); this.send({ type: "agent:activity", agentId, activity: "sleeping", detail: "" }); }
  /** Reset: stop the process + clear the server-side session (next start will not --resume); wipeWorkspace deletes the entire workspace; clearMemory clears MEMORY.md only. */
  async reset(agentId: string, wipeWorkspace = false, clearMemory = false): Promise<void> {
    this.teardown(agentId); // skip stop() to avoid double inactive emit; reset sends its own inactive/offline+detail=reset below
    this.send({ type: "agent:session", agentId, sessionId: null });
    const dir = path.join(this.dataDir, agentId);
    if (wipeWorkspace) {
      try { await rm(dir, { recursive: true, force: true }); this.log.info("workspace wiped", { agentId }); }
      catch (e) { this.log.warn("wipe failed", { agentId, detail: String(e) }); }
    } else if (clearMemory) {
      try { await writeFile(path.join(dir, "MEMORY.md"), "# Memory\n\n(reset)\n"); this.log.info("memory cleared", { agentId }); }
      catch (e) { this.log.warn("clearMemory failed", { agentId, detail: String(e) }); }
    }
    this.send({ type: "agent:status", agentId, status: "inactive" });
    this.send({ type: "agent:activity", agentId, activity: "offline", detail: "reset" });
    this.log.info("agent reset", { agentId, wipeWorkspace, clearMemory });
  }
  /** Profile changed on the server (displayName/description) — surgically sync the workspace MEMORY.md
   *  title + `## Role`, preserving the agent's own sections. No-op if the workspace/file doesn't exist
   *  yet (a not-yet-started agent gets fresh values from the DB when start() seeds it). */
  async syncProfile(agentId: string, displayName: string, description?: string | null): Promise<void> {
    const mem = path.join(this.dataDir, agentId, "MEMORY.md");
    let content: string;
    try { content = await readFile(mem, "utf8"); }
    catch { this.log.debug("syncProfile: no MEMORY.md yet", { agentId }); return; }
    const next = applyProfileToMemory(content, displayName || agentId, description);
    if (next !== content) {
      try { await writeFile(mem, next); this.log.info("profile synced to MEMORY.md", { agentId }); }
      catch (e) { this.log.warn("syncProfile write failed", { agentId, detail: String(e) }); return; }
    }
    // Keep a running agent's cached config fresh so a later --resume uses the new values.
    const r = this.agents.get(agentId);
    if (r) { r.config.displayName = displayName; r.config.description = description ?? null; }
  }
  private resetIdle(agentId: string): void {
    const r = this.agents.get(agentId); if (!r) return;
    if (r.idleTimer) clearTimeout(r.idleTimer);
    r.idleTimer = setTimeout(() => { this.log.info("idle sleep", { agentId, idleMs: IDLE_MS }); this.sleep(agentId); }, IDLE_MS);
  }

  async start(agentId: string, config: AgentConfig): Promise<void> {
    if (this.agents.has(agentId)) return;
    const existing = this.starting.get(agentId);
    if (existing) return existing;
    const pending = this.startNow(agentId, config).finally(() => this.starting.delete(agentId));
    this.starting.set(agentId, pending);
    return pending;
  }

  private async startNow(agentId: string, config: AgentConfig): Promise<void> {
    if (this.agents.has(agentId)) return;
    const runtime = this.runtimeResolver(config.runtime ?? "claude");
    if (!runtime) {
      this.log.error("no runtime", { runtime: config.runtime });
      this.send({ type: "agent:activity", agentId, activity: "offline", detail: `no runtime: ${config.runtime}` });
      return;
    }
    if (runtime.experimental) this.log.warn("experimental runtime", { runtime: runtime.name });

    const dir = path.join(this.dataDir, agentId);
    await mkdir(path.join(dir, "notes"), { recursive: true });
    const mem = path.join(dir, "MEMORY.md");
    try { await access(mem); } catch {
      await writeFile(mem, seedMemory(config.displayName || config.name, config.description));
    }

    const systemPrompt = buildSystemPrompt({
      name: config.name, displayName: config.displayName, description: config.description,
      agentId, serverId: config.serverId, hostname: os.hostname(), os: `${os.platform()} ${os.arch()}`, workspace: dir,
    });
    const env: NodeJS.ProcessEnv = {
      ...process.env, FORCE_COLOR: "0",
      PATH: `${this.binDir}:${process.env.PATH ?? ""}`,
      OPEN_TAG_SERVER_URL: config.serverUrl, OPEN_TAG_AGENT_ID: agentId, OPEN_TAG_AGENT_TOKEN: config.agentToken ?? "",
    };
    delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;

    const running: Running = { session: undefined as unknown as RuntimeSession, config, sessionId: config.sessionId ?? null };
    const cb: RuntimeCallbacks = {
      onSession: (sid) => { running.sessionId = sid; this.send({ type: "agent:session", agentId, sessionId: sid }); },
      onActivity: (activity, detail) => { this.resetIdle(agentId); this.send({ type: "agent:activity", agentId, activity, detail: detail ?? "" }); },
      onTrajectory: (entries) => this.send({ type: "agent:trajectory", agentId, entries }),
      onExit: (code) => {
        this.log.info("agent exited", { agentId, code });
        if (!this.agents.has(agentId)) return; // intentional stop/sleep/reset already called teardown (removed from map) — they sent their own status, don't overwrite
        this.agents.delete(agentId);
        // Process died on its own (not intentionally stopped): keep status=sleeping (session preserved, @ can --resume to recover);
        // Non-zero exit code (crash/signal kill) → activity=error to surface the failure; clean exit → sleeping.
        const crashed = code !== 0;
        this.send({ type: "agent:status", agentId, status: "sleeping" });
        this.send({ type: "agent:activity", agentId, activity: crashed ? "error" : "sleeping", detail: crashed ? `crashed (exit ${code ?? "signal"})` : "" });
      },
      log: this.log,
    };

    // No await between set and runtime.start (single-threaded event loop), so deliver cannot interleave and read an empty session.
    // Deliveries that arrived earlier during workspace preparation are flushed just below, except
    // one-shot runtimes where the wakeup prompt itself is the concrete "check then send" turn.
    const pendingDeliveryCount = this.pendingDelivers.get(agentId)?.items.length ?? 0;
    const useOneShotWakeNudge = !!runtime.oneShotWake && pendingDeliveryCount > 0;
    this.agents.set(agentId, running);
    running.session = runtime.start({
      cwd: dir, model: config.model, runtimeConfig: config.runtimeConfig, sessionId: config.sessionId, systemPrompt, env,
      initialPrompt: useOneShotWakeNudge ? ONE_SHOT_WAKE_NUDGE : (config.sessionId ? RESUME_NUDGE : STARTUP_NUDGE),
    }, cb);

    this.send({ type: "agent:status", agentId, status: "active" });
    this.send({ type: "agent:activity", agentId, activity: "working", detail: "starting" });
    this.log.info("agent started", { agentId, runtime: runtime.name, model: config.model ?? "(default)", resume: !!config.sessionId, experimental: runtime.experimental ?? false });
    this.resetIdle(agentId);
    if (useOneShotWakeNudge) {
      this.clearPendingDeliver(agentId);
      this.log.debug("pending deliver consumed by one-shot wake nudge", { agentId, runtime: runtime.name, count: pendingDeliveryCount });
    } else {
      this.flushPendingDeliver(agentId);
    }
  }

  private queuePendingDeliver(agentId: string, item: PendingDeliver): void {
    let q = this.pendingDelivers.get(agentId);
    if (!q) {
      const timer = setTimeout(() => {
        this.pendingDelivers.delete(agentId);
        this.log.debug("pending deliver expired", { agentId });
      }, this.pendingDeliverTtlMs);
      q = { items: [], timer };
      this.pendingDelivers.set(agentId, q);
    }
    q.items.push(item);
    if (q.items.length > 10) q.items.shift();
    this.log.debug("deliver queued pending start", { agentId, count: q.items.length });
  }

  private clearPendingDeliver(agentId: string): void {
    const q = this.pendingDelivers.get(agentId);
    if (!q) return;
    clearTimeout(q.timer);
    this.pendingDelivers.delete(agentId);
  }

  private flushPendingDeliver(agentId: string): void {
    const q = this.pendingDelivers.get(agentId);
    if (!q) return;
    this.clearPendingDeliver(agentId);
    this.log.debug("pending deliver -> agent", { agentId, count: q.items.length });
    for (const item of q.items) this.deliver(agentId, item.from, item.target, item.mentioned, item.meta);
  }

  private debounceMsFor(r: Running): number {
    const runtime = this.runtimeResolver(r.config.runtime ?? "claude");
    return runtime?.oneShotWake ? this.oneShotDeliverDebounceMs : this.deliverDebounceMs;
  }

  /** server agent:deliver — wake a running agent with new messages; if start is still preparing the workspace, briefly queue and flush once the runtime exists. */
  deliver(agentId: string, from: string, target: string, mentioned = false, meta: DeliverMeta = {}): void {
    const r = this.agents.get(agentId);
    if (!r) { this.queuePendingDeliver(agentId, { from, target, mentioned, meta }); return; }
    // Delivery batching while busy: multiple messages within 3 s are coalesced into one inbox notice, reducing interruptions and token usage.
    const tname = meta.targetName ?? target;
    const short = meta.msgShort ?? "";
    const b = r.deliverBuf;
    if (b) { // accumulate: count++, update latest, keep first unchanged, union target set
      clearTimeout(b.timer); b.count++; b.from = from; b.target = target; b.targetName = tname; b.latestShort = short;
      b.isTask = b.isTask || !!meta.isTask; b.mentioned = b.mentioned || mentioned; b.targets.add(tname);
    }
    const buf: DeliverBuf = b ?? { count: 1, from, target, targetName: tname, firstShort: short, latestShort: short, isTask: !!meta.isTask, mentioned, targets: new Set([tname]), timer: undefined as any };
    buf.timer = setTimeout(() => {
      r.deliverBuf = undefined;
      const note = inboxNotice({ count: buf.count, from: buf.from, targetName: buf.targetName, firstShort: buf.firstShort, latestShort: buf.latestShort, isTask: buf.isTask, isDm: buf.targetName.startsWith("dm:"), changedTargets: buf.targets.size, mentioned: buf.mentioned });
      try { r.session.deliver(note); this.resetIdle(agentId); this.log.debug("inbox notice -> agent", { agentId, count: buf.count, mentioned: buf.mentioned }); }
      catch (e) { this.log.warn("deliver failed", { agentId, detail: String(e) }); }
    }, this.debounceMsFor(r));
    r.deliverBuf = buf;
  }
}

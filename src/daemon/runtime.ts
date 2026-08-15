// Runtime abstraction: each runtime (claude/codex/…) owns its process and protocol lifecycle.
// Types only — no implementation imports, avoiding circular dependencies with concrete runtime files.
import type { Logger } from "../log.js";

export interface TrajectoryEntry {
  kind: "thinking" | "text" | "tool" | "status";
  text?: string;
  toolName?: string;
  toolInput?: string;
}

export interface RuntimeCallbacks {
  onSession(sessionId: string | null): void;          // receive/update/clear session id (claude session_id / codex threadId)
  onInitialTurnAdmission(error?: Error): void;         // exactly-once result: adapter accepted the initial prompt, or rejected before acceptance
  onAcceptedTurnFailure(): void;                       // exactly-once terminal failure after admission when the reusable session emits no online/onExit
  onActivity(activity: string, detail?: string): void; // working|thinking|online|offline
  onTrajectory(entries: TrajectoryEntry[]): void;      // streaming trajectory: thinking/text/tool entries
  onExit(code: number | null): void;
  log: Logger;
}

/** Keep the adapter boundary exactly-once even when spawn, write, and exit race. */
export function initialTurnAdmission(cb: RuntimeCallbacks): { accept(): void; reject(cause: unknown): void } {
  let settled = false;
  return {
    accept() {
      if (settled) return;
      settled = true;
      cb.onInitialTurnAdmission();
    },
    reject(cause) {
      if (settled) return;
      settled = true;
      cb.onInitialTurnAdmission(cause instanceof Error ? cause : new Error(String(cause)));
    },
  };
}

export interface ProtocolAdmission {
  promise: Promise<void>;
  accept(): void;
  reject(cause: unknown): void;
}

/** Promise for one concrete adapter input; queueing alone never settles it. */
export function protocolAdmission(): ProtocolAdmission {
  let settled = false;
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return {
    promise,
    accept() {
      if (settled) return;
      settled = true;
      resolve();
    },
    reject(cause) {
      if (settled) return;
      settled = true;
      reject(cause instanceof Error ? cause : new Error(String(cause)));
    },
  };
}

export interface StartOpts {
  cwd: string;                     // operator-owned project directory, or stateDir when unbound
  stateDir: string;                // open-tag-owned durable memory/runtime artifacts; safe to reset
  model?: string;
  runtimeConfig?: Record<string, unknown> | null;
  sessionId?: string | null;       // for session resume
  systemPrompt: string;            // injected system prompt (claude=--append-system-prompt; codex=developerInstructions)
  env: NodeJS.ProcessEnv;          // includes PATH injection for open-tag + OPEN_TAG_* env vars
  initialPrompt: string;           // first drive message (new session="Start."; resume=RESUME_NUDGE)
}

/** Compatibility channel for one-shot CLIs that expose no independent system/custom-instruction API. */
export function runtimeInstructionEnvelope(systemPrompt: string, input: string): string {
  return `<open-tag-runtime-instructions>\n${systemPrompt}\n</open-tag-runtime-instructions>\n\n<open-tag-turn>\n${input}\n</open-tag-turn>`;
}

export interface RuntimeSession {
  pid?: number;
  deliver(text: string): Promise<void>; // resolves only when the concrete runtime protocol accepts this input
  stop(): void;
}

export interface Runtime {
  name: string;
  experimental?: boolean;
  oneShotWake?: boolean;          // runtime needs each wake to be a concrete check/send turn
  start(opts: StartOpts, cb: RuntimeCallbacks): RuntimeSession;
}

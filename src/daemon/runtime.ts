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
  onActivity(activity: string, detail?: string): void; // working|thinking|online|offline
  onTrajectory(entries: TrajectoryEntry[]): void;      // streaming trajectory: thinking/text/tool entries
  onExit(code: number | null): void;
  log: Logger;
}

export interface StartOpts {
  cwd: string;
  model?: string;
  runtimeConfig?: Record<string, unknown> | null;
  sessionId?: string | null;       // for session resume
  systemPrompt: string;            // injected system prompt (claude=--append-system-prompt; codex=developerInstructions)
  env: NodeJS.ProcessEnv;          // includes PATH injection for open-tag + OPEN_TAG_* env vars
  initialPrompt: string;           // first drive message (new session="Start."; resume=RESUME_NUDGE)
}

export interface RuntimeSession {
  deliver(text: string): void;     // deliver a new message / wake up → drives one turn (claude=stdin write; codex=turn/start)
  stop(): void;
}

export interface Runtime {
  name: string;
  experimental?: boolean;
  oneShotWake?: boolean;          // runtime needs each wake to be a concrete check/send turn
  start(opts: StartOpts, cb: RuntimeCallbacks): RuntimeSession;
}

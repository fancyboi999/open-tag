// Runtime registry and local detection. Concrete implementations live in claudeRuntime.ts / codexRuntime.ts / copilotRuntime.ts.
import { execSync } from "node:child_process";
import { claudeRuntime } from "./claudeRuntime.js";
import { codexRuntime } from "./codexRuntime.js";
import { copilotRuntime } from "./copilotRuntime.js";
import type { Runtime } from "./runtime.js";

export type { Runtime, RuntimeSession, RuntimeCallbacks, StartOpts, TrajectoryEntry } from "./runtime.js";

function has(tool: string): boolean { try { execSync(`command -v ${tool}`, { stdio: "pipe" }); return true; } catch { return false; } }
export function detectRuntimes(): string[] {
  const found = ["claude", "codex", "copilot", "kimi", "gemini", "opencode"].filter(has);
  return found;
}

const REG: Record<string, Runtime> = { claude: claudeRuntime, codex: codexRuntime, copilot: copilotRuntime };
export function getRuntime(name: string): Runtime | null { return REG[name] ?? null; }

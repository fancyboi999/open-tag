// Runtime registry and local detection. Concrete implementations live in claudeRuntime.ts / codexRuntime.ts / copilotRuntime.ts / opencodeRuntime.ts / kimiRuntime.ts / piRuntime.ts / cursorRuntime.ts / hermesRuntime.ts.
import { execSync } from "node:child_process";
import { claudeRuntime } from "./claudeRuntime.js";
import { codexRuntime } from "./codexRuntime.js";
import { copilotRuntime } from "./copilotRuntime.js";
import { opencodeRuntime } from "./opencodeRuntime.js";
import { kimiRuntime } from "./kimiRuntime.js";
import { piRuntime } from "./piRuntime.js";
import { cursorRuntime } from "./cursorRuntime.js";
import { hermesRuntime } from "./hermesRuntime.js";
import type { Runtime } from "./runtime.js";

export type { Runtime, RuntimeSession, RuntimeCallbacks, StartOpts, TrajectoryEntry } from "./runtime.js";

function has(tool: string): boolean { try { execSync(`command -v ${tool}`, { stdio: "pipe" }); return true; } catch { return false; } }
export function detectRuntimes(): string[] {
  return ["claude", "codex", "copilot", "kimi", "opencode", "pi", "cursor-agent", "hermes"].filter(has).map((t) => (t === "cursor-agent" ? "cursor" : t));
}

const REG: Record<string, Runtime> = { claude: claudeRuntime, codex: codexRuntime, copilot: copilotRuntime, opencode: opencodeRuntime, kimi: kimiRuntime, pi: piRuntime, cursor: cursorRuntime, hermes: hermesRuntime };
export function getRuntime(name: string): Runtime | null { return REG[name] ?? null; }

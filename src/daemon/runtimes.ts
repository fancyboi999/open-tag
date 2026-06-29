// Runtime registry and local detection. Concrete implementations live in claudeRuntime.ts / codexRuntime.ts / copilotRuntime.ts / opencodeRuntime.ts / kimiRuntime.ts / piRuntime.ts / cursorRuntime.ts.
import { execSync } from "node:child_process";
import { claudeRuntime } from "./claudeRuntime.js";
import { codexRuntime } from "./codexRuntime.js";
import { copilotRuntime } from "./copilotRuntime.js";
import { opencodeRuntime } from "./opencodeRuntime.js";
import { kimiRuntime } from "./kimiRuntime.js";
import { piRuntime } from "./piRuntime.js";
import { cursorRuntime } from "./cursorRuntime.js";
import type { Runtime } from "./runtime.js";

export type { Runtime, RuntimeSession, RuntimeCallbacks, StartOpts, TrajectoryEntry } from "./runtime.js";

// ── Cross-platform binary resolution ─────────────────────────────
// On Windows, `spawn("claude")` fails because npm installs .cmd shims and
// CreateProcessW doesn't resolve PATHEXT for bare names. We use `where` to
// locate the binary and, if it's a .cmd/.ps1 wrapper, read it to find the
// underlying .exe. On Unix this is a no-op pass-through.
export function resolveBin(tool: string): string {
  if (process.platform !== "win32") return tool;
  try {
    const raw = execSync(`where ${tool}`, { encoding: "utf8", stdio: "pipe" }).trim();
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const p of lines) {
      if (/\.(cmd|bat|ps1)$/i.test(p)) {
        try {
          const content = execSync(`type "${p}"`, { encoding: "utf8", stdio: "pipe" }).trim();
          const m = content.match(/["']([^"']+\.exe)["']/);
          if (m) {
            const exePath = m[1].replace(/%\w+%/g, "");
            const resolved = /^[A-Za-z]:/.test(exePath)
              ? exePath
              : `${p.replace(/[\/][^\/]+$/, "")}/${exePath}`;
            if (require("node:fs").existsSync(resolved)) return resolved;
          }
        } catch { /* fall through */ }
      } else if (/\.exe$/i.test(p)) {
        return p;
      }
    }
    // where returned extensionless shim path — try appending .exe
    for (const l of lines) {
      const exe = l + ".exe";
      if (require("node:fs").existsSync(exe)) return exe;
    }
    return lines[0] || tool;
  } catch {
    return tool;
  }
}

function has(tool: string): boolean {
  try {
    // Use `where` on Windows (cmd.exe doesn't have `command -v`), `command -v` on Unix.
    const cmd = process.platform === "win32" ? "where" : "command -v";
    execSync(`${cmd} ${tool}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
export function detectRuntimes(): string[] {
  return ["claude", "codex", "copilot", "kimi", "opencode", "pi", "cursor-agent"].filter(has).map((t) => (t === "cursor-agent" ? "cursor" : t));
}

const REG: Record<string, Runtime> = { claude: claudeRuntime, codex: codexRuntime, copilot: copilotRuntime, opencode: opencodeRuntime, kimi: kimiRuntime, pi: piRuntime, cursor: cursorRuntime };
export function getRuntime(name: string): Runtime | null { return REG[name] ?? null; }

// Unified structured logging: JSON lines written to ~/.open-tag/logs/<component>.log plus human-readable console output.
// To tail logs: tail -f ~/.open-tag/logs/server.log  (or daemon/cli/agent-<id>)
import fs from "node:fs";
import path from "node:path";
import { logsDir } from "./paths.js";

const LOG_DIR = logsDir();
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* */ }

type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = order[(process.env.OPEN_TAG_LOG_LEVEL as Level) ?? "debug"] ?? 10;

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(sub: string): Logger;
}

export function createLogger(component: string): Logger {
  const file = path.join(LOG_DIR, `${component.split(":")[0]}.log`);
  function write(level: Level, msg: string, fields?: Record<string, unknown>): void {
    if (order[level] < MIN) return;
    const rec = { t: new Date().toISOString(), level, comp: component, msg, ...(fields ?? {}) };
    try { fs.appendFileSync(file, JSON.stringify(rec) + "\n"); } catch { /* */ }
    const extra = fields && Object.keys(fields).length ? " " + safeJson(fields) : "";
    const line = `${rec.t} ${level.toUpperCase().padEnd(5)} [${component}] ${msg}${extra}`;
    const stream = consoleStream(component, level);
    try { stream.write(line + "\n"); } catch { /* */ }
  }
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (sub) => createLogger(`${component}:${sub}`),
  };
}

function consoleStream(component: string, level: Level): NodeJS.WriteStream {
  if (level === "error" || component === "cli" || component.startsWith("cli:")) return process.stderr;
  return process.stdout;
}

function safeJson(o: unknown): string {
  try { return JSON.stringify(o, (_k, v) => (typeof v === "string" && v.length > 300 ? v.slice(0, 300) + "…" : v)); }
  catch { return "[unserializable]"; }
}

export const logDir = LOG_DIR;

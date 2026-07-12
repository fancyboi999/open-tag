import { spawn } from "cross-spawn";
import type { SpawnOptions, ChildProcess } from "node:child_process";
import { applyResourceLimits } from "./resourceLimit.js";
import { createLogger } from "../log.js";

const log = createLogger("daemon:spawn");

export function spawnSafe(command: string, args: string[], options: SpawnOptions): ChildProcess {
  const child = spawn(command, args, options);
  applyResourceLimits(child);
  log.debug("spawned", { pid: child.pid, cmd: command });
  return child;
}

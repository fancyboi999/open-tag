import { spawn } from "cross-spawn";
import type { SpawnOptions, ChildProcess } from "node:child_process";
import { applyResourceLimits } from "./resourceLimit.js";
import { createLogger } from "../log.js";

const log = createLogger("daemon:spawn");

export function spawnSafe(command: string, args: string[], options: SpawnOptions): ChildProcess {
  const child = spawn(command, args, options);
  const mem = options.env?.OPEN_TAG_MEM_LIMIT_MB ?? process.env.OPEN_TAG_MEM_LIMIT_MB;
  const cpu = options.env?.OPEN_TAG_CPU_LIMIT_PERCENT ?? process.env.OPEN_TAG_CPU_LIMIT_PERCENT;
  log.debug("spawned", { pid: child.pid, cmd: command, mem, cpu });
  applyResourceLimits(child, {
    memoryLimitMB: mem ? Number(mem) : 0,
    cpuLimitPercent: cpu ? Number(cpu) : 0,
  });
  return child;
}

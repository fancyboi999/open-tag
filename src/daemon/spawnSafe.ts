import { spawn } from "cross-spawn";
import type { SpawnOptions, ChildProcess } from "node:child_process";

export function spawnSafe(command: string, args: string[], options: SpawnOptions): ChildProcess {
  return spawn(command, args, options);
}

import { execSync, type ChildProcess } from "node:child_process";

export function killTree(proc: ChildProcess): void {
  const pid = proc.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" }); } catch { /* already dead */ }
  } else {
    try { process.kill(-pid, "SIGTERM"); } catch { try { proc.kill("SIGTERM"); } catch { /* */ } }
  }
}

import os from "node:os";
import { readFileSync } from "node:fs";

export const PRESSURE_MEM_MB = Number(process.env.OPEN_TAG_PRESSURE_MEM_MB ?? "500");

export interface ResourceBudgetStatus {
  totalMemMB: number;
  totalCpuCores: number;
  queueLength: number;
  availableMemMB: number;
  cpuUsagePct: number;
  agentCount: number;
  actualUsedMemMB: number;
}

export class ResourceBudget {
  readonly totalMemMB: number;
  readonly totalCpuCores: number;

  queueLength = 0;

  private cpuPrev: { idle: number; total: number } | null = null;

  agentCount = 0;
  actualUsedMemMB = 0;

  private _availableMemMB?: () => number;

  constructor(opts?: { totalMemMB?: number; totalCpuCores?: number; availableMemMB?: () => number }) {
    this.totalMemMB = opts?.totalMemMB ?? Math.floor(os.totalmem() / (1024 * 1024));
    this.totalCpuCores = opts?.totalCpuCores ?? os.cpus().length;
    this._availableMemMB = opts?.availableMemMB;
    this.cpuPrev = this.sampleCpu();
  }

  private sampleCpu(): { idle: number; total: number } {
    const cpus = os.cpus();
    let idle = 0, total = 0;
    for (const cpu of cpus) {
      total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
      idle += cpu.times.idle;
    }
    return { idle, total };
  }

  private calcCpuUsage(): number {
    const cur = this.sampleCpu();
    if (!this.cpuPrev) { this.cpuPrev = cur; return 0; }
    const dTotal = Math.max(cur.total - this.cpuPrev.total, 1);
    const dIdle = cur.idle - this.cpuPrev.idle;
    this.cpuPrev = cur;
    return Math.round((1 - dIdle / dTotal) * 100);
  }

  /** Number of agents that have passed tryAllocate() but haven't finished startNow(). */
  pendingStarts = 0;

  /** Reserve a slot for an in-flight start. Returns false if under pressure. */
  tryAllocate(): boolean {
    if (this.availableMemMB() >= PRESSURE_MEM_MB) {
      this.pendingStarts++;
      return true;
    }
    return false;
  }

  /** Release a previously reserved slot. */
  release(): void {
    this.pendingStarts = Math.max(0, this.pendingStarts - 1);
  }

  /** Stateless snapshot — prefer tryAllocate() for burst-safe checks. */
  canAllocate(): boolean {
    return this.availableMemMB() >= PRESSURE_MEM_MB;
  }

  availableMemMB(): number {
    if (this._availableMemMB) return this._availableMemMB();
    if (process.platform === "linux") {
      try {
        const m = readFileSync("/proc/meminfo", "utf8").match(/MemAvailable:\s+(\d+)\s+kB/);
        if (m) return Math.floor(Number(m[1]) / 1024);
      } catch {}
    }
    return Math.floor(os.totalmem() / (1024 * 1024) * 0.15);
  }

  status(): ResourceBudgetStatus {
    return {
      totalMemMB: this.totalMemMB,
      totalCpuCores: this.totalCpuCores,
      queueLength: this.queueLength,
      availableMemMB: this.availableMemMB(),
      cpuUsagePct: this.calcCpuUsage(),
      agentCount: this.agentCount,
      actualUsedMemMB: this.actualUsedMemMB,
    };
  }
}

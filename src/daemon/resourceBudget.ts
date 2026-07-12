import os from "node:os";

const PRESSURE_MEM_MB = Number(process.env.OPEN_TAG_PRESSURE_MEM_MB ?? "500");

export interface ResourceBudgetStatus {
  totalMemMB: number;
  totalCpuCores: number;
  queueLength: number;
  freememMB: number;
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

  constructor(opts?: { totalMemMB?: number; totalCpuCores?: number }) {
    this.totalMemMB = opts?.totalMemMB ?? Math.floor(os.totalmem() / (1024 * 1024));
    this.totalCpuCores = opts?.totalCpuCores ?? os.cpus().length;
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

	canAllocate(): boolean {
		return this.freememMB() >= PRESSURE_MEM_MB;
	}

	freememMB(): number {
		return Math.floor(os.freemem() / (1024 * 1024));
	}

  status(): ResourceBudgetStatus {
    return {
      totalMemMB: this.totalMemMB,
      totalCpuCores: this.totalCpuCores,
      queueLength: this.queueLength,
      freememMB: this.freememMB(),
      cpuUsagePct: this.calcCpuUsage(),
      agentCount: this.agentCount,
      actualUsedMemMB: this.actualUsedMemMB,
    };
  }
}

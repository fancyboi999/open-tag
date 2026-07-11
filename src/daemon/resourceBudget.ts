import os from "node:os";

const RESERVE_MEM_PCT = Number(process.env.OPEN_TAG_RESERVE_MEM_PERCENT ?? "0.2");
const RESERVE_CPU_PCT = Number(process.env.OPEN_TAG_RESERVE_CPU_PERCENT ?? "0.25");

export interface ResourceBudgetStatus {
  totalMemMB: number;
  totalCpuCores: number;
  reserveMemPct: number;
  reserveCpuPct: number;
  maxAgentMemMB: number;
  maxAgentCpuPct: number;
  allocatedMemMB: number;
  allocatedCpuPct: number;
  availableMemMB: number;
  availableCpuPct: number;
  queueLength: number;
}

export class ResourceBudget {
  readonly totalMemMB: number;
  readonly totalCpuCores: number;
  readonly maxAgentMemMB: number;
  readonly maxAgentCpuPct: number;
  readonly reserveMemPct = RESERVE_MEM_PCT;
  readonly reserveCpuPct = RESERVE_CPU_PCT;

  allocatedMemMB = 0;
  allocatedCpuPct = 0;
  queueLength = 0;

  constructor(opts?: { totalMemMB?: number; totalCpuCores?: number }) {
    const mem = opts?.totalMemMB ?? Math.floor(os.totalmem() / (1024 * 1024));
    const cpu = opts?.totalCpuCores ?? os.cpus().length;
    this.totalMemMB = mem;
    this.totalCpuCores = cpu;
    this.maxAgentMemMB = Math.floor(mem * (1 - RESERVE_MEM_PCT));
    this.maxAgentCpuPct = Math.floor(cpu * 100 * (1 - RESERVE_CPU_PCT));
  }

  canAllocate(memMB: number, cpuPct: number): boolean {
    if (memMB <= 0 && cpuPct <= 0) return true;
    const needMem = Math.max(memMB, 0);
    const needCpu = Math.max(cpuPct, 0);
    if (needMem > 0 && this.allocatedMemMB + needMem > this.maxAgentMemMB) return false;
    if (needCpu > 0 && this.allocatedCpuPct + needCpu > this.maxAgentCpuPct) return false;
    return true;
  }

  allocate(memMB: number, cpuPct: number): void {
    this.allocatedMemMB += Math.max(memMB, 0);
    this.allocatedCpuPct += Math.max(cpuPct, 0);
  }

  release(memMB: number, cpuPct: number): void {
    this.allocatedMemMB = Math.max(0, this.allocatedMemMB - Math.max(memMB, 0));
    this.allocatedCpuPct = Math.max(0, this.allocatedCpuPct - Math.max(cpuPct, 0));
  }

  status(): ResourceBudgetStatus {
    return {
      totalMemMB: this.totalMemMB,
      totalCpuCores: this.totalCpuCores,
      reserveMemPct: this.reserveMemPct,
      reserveCpuPct: this.reserveCpuPct,
      maxAgentMemMB: this.maxAgentMemMB,
      maxAgentCpuPct: this.maxAgentCpuPct,
      allocatedMemMB: this.allocatedMemMB,
      allocatedCpuPct: this.allocatedCpuPct,
      availableMemMB: Math.max(0, this.maxAgentMemMB - this.allocatedMemMB),
      availableCpuPct: Math.max(0, this.maxAgentCpuPct - this.allocatedCpuPct),
      queueLength: this.queueLength,
    };
  }
}

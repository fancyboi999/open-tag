import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { createLogger } from "../log.js";

// koffi is only needed on Windows — guarded require avoids missing-module errors on Linux/macOS
const _require = /* @__PURE__ */ createRequire(import.meta.url);
let koffi: any;
try { koffi = _require("koffi"); } catch { /* */ }

const log = createLogger("daemon:limit");
const platform = process.platform;

export interface ResourceLimits {
  memoryLimitMB: number;
  cpuLimitPercent: number;
}

export function applyResourceLimits(child: ChildProcess, limits?: ResourceLimits): void {
  if (child.pid === undefined) return;

  const memLimitMB = limits?.memoryLimitMB ?? (Number(process.env.OPEN_TAG_MEM_LIMIT_MB) || 0);
  const cpuLimitPct = limits?.cpuLimitPercent ?? (Number(process.env.OPEN_TAG_CPU_LIMIT_PERCENT) || 0);
  if (memLimitMB <= 0 && cpuLimitPct <= 0) return;

  try {
    switch (platform) {
      case "win32": return applyWin32(child, memLimitMB, cpuLimitPct);
      case "linux": return applyLinux(child, memLimitMB, cpuLimitPct);
      case "darwin": return applyDarwin(child, cpuLimitPct);
      default: log.debug("unsupported platform, skipping", { platform }); return;
    }
  } catch (err) {
    log.error("applyResourceLimits failed", { pid: child.pid, error: String(err), platform });
  }
}

// ── Windows (Job Object) ────────────────────────────────────────────────────

const JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x00000100;
const JOB_OBJECT_CPU_RATE_CONTROL_ENABLE = 0x1;
const JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP = 0x4;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;
const JobObjectExtendedLimitInformation = 9;
const JobObjectCpuRateControlInformation = 15;

interface Win32Api {
  CreateJobObjectW: (attr: null, name: null) => bigint;
  SetExtendedLimitInfo: (
    hJob: bigint,
    infoClass: number,
    info: Record<string, unknown>,
    cb: number,
  ) => boolean;
  SetCpuRateInfo: (
    hJob: bigint,
    infoClass: number,
    info: Record<string, unknown>,
    cb: number,
  ) => boolean;
  OpenProcess: (
    dwDesiredAccess: number,
    bInheritHandle: number,
    dwProcessId: number,
  ) => bigint;
  AssignProcessToJobObject: (hJob: bigint, hProcess: bigint) => boolean;
  CloseHandle: (hObject: bigint) => boolean;
  ExtendedLimitInfo: ReturnType<typeof koffi.struct>;
  CpuRateControlInfo: ReturnType<typeof koffi.struct>;
}

let winApi: Win32Api | null = null;

function initWinApi(): Win32Api {
  const lib = koffi.load("kernel32.dll");

  const BasicLimitInfo = koffi.struct({
    PerProcessUserTimeLimit: "int64",
    PerJobUserTimeLimit: "int64",
    LimitFlags: "uint32",
    MinimumWorkingSetSize: "int64",
    MaximumWorkingSetSize: "int64",
    ActiveProcessLimit: "uint32",
    Affinity: "int64",
    PriorityClass: "uint32",
    SchedulingClass: "uint32",
  });

  const IoCounters = koffi.struct({
    ReadOperationCount: "int64",
    WriteOperationCount: "int64",
    OtherOperationCount: "int64",
    ReadTransferCount: "int64",
    WriteTransferCount: "int64",
    OtherTransferCount: "int64",
  });

  const ExtendedLimitInfo = koffi.struct({
    BasicLimitInformation: BasicLimitInfo,
    IoInfo: IoCounters,
    ProcessMemoryLimit: "int64",
    JobMemoryLimit: "int64",
    PeakProcessMemoryUsed: "int64",
    PeakJobMemoryUsed: "int64",
  });

  const CpuRateControlInfo = koffi.struct({
    ControlFlags: "uint32",
    CpuRate: "uint32",
  });

  return {
    CreateJobObjectW: lib.func("CreateJobObjectW", "void*", ["void*", "void*"]),
    SetExtendedLimitInfo: lib.func(
      "SetInformationJobObject",
      "bool",
      ["void*", "int", koffi.pointer(ExtendedLimitInfo), "uint32"],
    ),
    SetCpuRateInfo: lib.func(
      "SetInformationJobObject",
      "bool",
      ["void*", "int", koffi.pointer(CpuRateControlInfo), "uint32"],
    ),
    OpenProcess: lib.func("OpenProcess", "void*", ["uint32", "int", "uint32"]),
    AssignProcessToJobObject: lib.func(
      "AssignProcessToJobObject",
      "bool",
      ["void*", "void*"],
    ),
    CloseHandle: lib.func("CloseHandle", "bool", ["void*"]),
    ExtendedLimitInfo,
    CpuRateControlInfo,
  };
}

const jobHandles = new Map<number, bigint>();

function applyWin32(child: ChildProcess, memLimitMB: number, cpuLimitPct: number): void {
  const pid = child.pid!;
  const a = (winApi ??= initWinApi());

  const jobHandle = a.CreateJobObjectW(null, null);
  if (typeof jobHandle !== "bigint" || jobHandle === 0n) {
    log.error("CreateJobObjectW failed", { pid });
    return;
  }

  const z = 0n;
  const extInfo = {
    BasicLimitInformation: {
      PerProcessUserTimeLimit: z,
      PerJobUserTimeLimit: z,
      LimitFlags: memLimitMB > 0 ? JOB_OBJECT_LIMIT_PROCESS_MEMORY : 0,
      MinimumWorkingSetSize: z,
      MaximumWorkingSetSize: z,
      ActiveProcessLimit: 0,
      Affinity: z,
      PriorityClass: 0,
      SchedulingClass: 0,
    },
    IoInfo: {
      ReadOperationCount: z,
      WriteOperationCount: z,
      OtherOperationCount: z,
      ReadTransferCount: z,
      WriteTransferCount: z,
      OtherTransferCount: z,
    },
    ProcessMemoryLimit: memLimitMB > 0 ? BigInt(memLimitMB) * 1024n * 1024n : z,
    JobMemoryLimit: z,
    PeakProcessMemoryUsed: z,
    PeakJobMemoryUsed: z,
  };

  const extOk = a.SetExtendedLimitInfo(
    jobHandle,
    JobObjectExtendedLimitInformation,
    extInfo,
    koffi.sizeof(a.ExtendedLimitInfo),
  );
  if (!extOk) log.error("SetExtendedLimitInfo failed", { pid, memLimitMB });

  if (cpuLimitPct > 0) {
    const cpuOk = a.SetCpuRateInfo(
      jobHandle,
      JobObjectCpuRateControlInformation,
      {
        ControlFlags:
          JOB_OBJECT_CPU_RATE_CONTROL_ENABLE |
          JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP,
        CpuRate: Math.min(10000, Math.round(cpuLimitPct * 100)),
      },
      koffi.sizeof(a.CpuRateControlInfo),
    );
    if (!cpuOk) log.error("SetCpuRateInfo failed", { pid, cpuLimitPct });
  }

  const procHandle = a.OpenProcess(
    PROCESS_SET_QUOTA | PROCESS_TERMINATE,
    0,
    pid,
  );
  if (typeof procHandle === "bigint" && procHandle !== 0n) {
    const assigned = a.AssignProcessToJobObject(jobHandle, procHandle);
    if (assigned) {
      log.info("assigned to Job Object", { pid, memoryLimitMB: memLimitMB || undefined, cpuLimitPercent: cpuLimitPct || undefined });
    } else {
      log.error("AssignProcessToJobObject failed", { pid });
    }
    a.CloseHandle(procHandle);
  } else {
    log.error("OpenProcess failed", { pid });
  }

  jobHandles.set(pid, jobHandle);

  child.once("exit", () => {
    const h = jobHandles.get(child.pid!);
    if (h) {
      a.CloseHandle(h);
      jobHandles.delete(child.pid!);
      log.debug("Job Object closed", { pid: child.pid });
    }
  });
}

// ── Linux (cgroups v2 + v1 fallback) ─────────────────────────────────────────

const CG_ROOT = "/sys/fs/cgroup";

function cgroupV2Available(): boolean {
  try {
    fs.accessSync(path.join(CG_ROOT, "cgroup.controllers"), fs.constants.R_OK);
    return true;
  } catch { return false; }
}

function cgroupV1Available(): boolean {
  try {
    fs.accessSync("/sys/fs/cgroup/memory", fs.constants.F_OK);
    fs.accessSync("/sys/fs/cgroup/cpu", fs.constants.F_OK);
    return true;
  } catch { return false; }
}

const cgV1Cleanup = new Map<number, string[]>();

function applyLinux(child: ChildProcess, memLimitMB: number, cpuLimitPct: number): void {
  if (cgroupV2Available()) return applyCgroupV2(child, memLimitMB, cpuLimitPct);
  if (cgroupV1Available()) return applyCgroupV1(child, memLimitMB, cpuLimitPct);
  log.debug("no cgroup available, skipping");
}

// ── cgroup v2 ────────────────────────────────────────────────────────────────

function applyCgroupV2(child: ChildProcess, memLimitMB: number, cpuLimitPct: number): void {
  const pid = child.pid!;
  const cgName = `open-tag-agent-${pid}`;
  const cgDir = path.join(CG_ROOT, cgName);

  try {
    try {
      const cur = fs.readFileSync(path.join(CG_ROOT, "cgroup.subtree_control"), "utf8");
      const need: string[] = [];
      if (!cur.includes("cpu")) need.push("+cpu");
      if (!cur.includes("memory")) need.push("+memory");
      if (need.length) fs.writeFileSync(path.join(CG_ROOT, "cgroup.subtree_control"), need.join(" "));
    } catch { /* may not have permission */ }

    fs.mkdirSync(cgDir, { recursive: true });

    if (memLimitMB > 0) {
      fs.writeFileSync(path.join(cgDir, "memory.max"), String(BigInt(memLimitMB) * 1024n * 1024n));
    }
    if (cpuLimitPct > 0) {
      const quota = Math.round(cpuLimitPct * 1000);
      fs.writeFileSync(path.join(cgDir, "cpu.max"), `${quota} 100000`);
    }
    fs.writeFileSync(path.join(cgDir, "cgroup.procs"), String(pid));

    log.info("assigned to cgroup v2", { pid, memoryLimitMB: memLimitMB || undefined, cpuLimitPercent: cpuLimitPct || undefined });
  } catch (err) {
    try { fs.rmdirSync(cgDir); } catch { /* */ }
    log.error("cgroup v2 setup failed", { pid, error: String(err) });
    return;
  }

  child.once("exit", () => {
    try { fs.rmdirSync(cgDir); } catch { /* */ }
  });
}

// ── cgroup v1 (fallback, e.g. WSL2) ─────────────────────────────────────────

function applyCgroupV1(child: ChildProcess, memLimitMB: number, cpuLimitPct: number): void {
  const pid = child.pid!;
  const cgName = `open-tag-agent-${pid}`;
  const dirs: string[] = [];

  try {
    if (memLimitMB > 0) {
      const memDir = `/sys/fs/cgroup/memory/${cgName}`;
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(`${memDir}/memory.limit_in_bytes`, String(BigInt(memLimitMB) * 1024n * 1024n));
      fs.writeFileSync(`${memDir}/cgroup.procs`, String(pid));
      dirs.push(memDir);
    }

    if (cpuLimitPct > 0) {
      const cpuDir = `/sys/fs/cgroup/cpu/${cgName}`;
      fs.mkdirSync(cpuDir, { recursive: true });
      const period = Number(fs.readFileSync(`${cpuDir}/cpu.cfs_period_us`, "utf8").trim()) || 100000;
      const quota = Math.round(cpuLimitPct / 100 * period);
      fs.writeFileSync(`${cpuDir}/cpu.cfs_quota_us`, String(quota));
      fs.writeFileSync(`${cpuDir}/cgroup.procs`, String(pid));
      dirs.push(cpuDir);
    }

    if (dirs.length) {
      cgV1Cleanup.set(pid, dirs);
      log.info("assigned to cgroup v1", { pid, memoryLimitMB: memLimitMB || undefined, cpuLimitPercent: cpuLimitPct || undefined });
    }
  } catch (err) {
    for (const d of dirs) { try { fs.rmdirSync(d); } catch { /* */ } }
    log.error("cgroup v1 setup failed", { pid, error: String(err) });
  }

  child.once("exit", () => {
    const d = cgV1Cleanup.get(child.pid!);
    if (d) {
      for (const dir of d) {
        // write 0 to migrate remaining tasks to root cgroup before rmdir
        try { fs.writeFileSync(`${dir}/cgroup.procs`, "0"); } catch { /* */ }
        try { fs.rmdirSync(dir); } catch { /* */ }
      }
      cgV1Cleanup.delete(child.pid!);
    }
  });
}

// ── macOS (best-effort background priority) ──────────────────────────────────

function applyDarwin(child: ChildProcess, cpuLimitPct: number): void {
  if (cpuLimitPct <= 0) {
    log.debug("macOS: no CPU limit configured, skipping");
    return;
  }

  const pid = child.pid!;
  try {
    const lib = koffi.load("libc.dylib");
    const setpriority = lib.func("setpriority", "int", ["int", "int", "int"]);
    const PRIO_DARWIN_BG = 0x10000;

    const ret = setpriority(PRIO_DARWIN_BG, pid, 0);
    if (ret === 0) {
      log.debug("set macOS background priority", { pid, cpuLimitPercent: cpuLimitPct });
    } else {
      log.error("setpriority failed", { pid });
    }
  } catch (err) {
    log.error("macOS resource limit setup failed", { pid, error: String(err) });
  }
}

import fs from "node:fs";
import { execSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { createLogger } from "../log.js";

// koffi is only needed on Windows — guarded require avoids missing-module errors on Linux/macOS
const _require = /* @__PURE__ */ createRequire(import.meta.url);
let koffi: any;
try { koffi = _require("koffi"); } catch { /* */ }

const log = createLogger("daemon:limit");
const platform = process.platform;

export function applyResourceLimits(child: ChildProcess): void {
  if (child.pid === undefined) return;

  try {
    switch (platform) {
      case "win32": return setupWin32Job(child);
      case "linux": return setupLinuxCgroup(child);
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
const JOB_OBJECT_CPU_RATE_CONTROL_SOFT_CAP = 0x8;
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
  SetProcessWorkingSetSizeEx: (hProcess: bigint, min: bigint, max: bigint, flags: number) => boolean;
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
    SetProcessWorkingSetSizeEx: lib.func("SetProcessWorkingSetSizeEx", "bool", ["void*", "int64", "int64", "uint32"]),
    CloseHandle: lib.func("CloseHandle", "bool", ["void*"]),
    ExtendedLimitInfo,
    CpuRateControlInfo,
  };
}

const jobHandles = new Map<number, bigint>();

function setupWin32Job(child: ChildProcess): void {
  const pid = child.pid!;
  const a = (winApi ??= initWinApi());
  const jobHandle = a.CreateJobObjectW(null, null);
  if (typeof jobHandle !== "bigint" || jobHandle === 0n) {
    log.error("CreateJobObjectW failed", { pid });
    return;
  }

  const procHandle = a.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
  if (typeof procHandle === "bigint" && procHandle !== 0n) {
    const assigned = a.AssignProcessToJobObject(jobHandle, procHandle);
    if (assigned) {
      log.debug("assigned to Job Object (pressure-ready)", { pid });
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

// ── Linux (cgroups v2) ───────────────────────────────────────────────────────

const CG_ROOT = "/sys/fs/cgroup";

function setupLinuxCgroup(child: ChildProcess): void {
  const pid = child.pid!;
  const cgName = `open-tag-agent-${pid}`;
  const cgDir = path.join(CG_ROOT, cgName);

  try {
    try {
      fs.mkdirSync(cgDir, { recursive: true });
    } catch {
      log.debug("cgroup setup skipped (no permission)", { pid });
      return;
    }

    fs.writeFileSync(path.join(cgDir, "cgroup.procs"), String(pid));
    log.debug("assigned to cgroup (pressure-ready)", { pid });

    child.once("exit", () => {
      try { fs.rmdirSync(cgDir); } catch { /* */ }
    });
  } catch (err) {
    log.debug("cgroup setup failed", { pid, error: String(err) });
  }
}

// ── Process memory reading ────────────────────────────────────────────────────

export function readProcessMemoryMB(pid: number): number {
  if (pid <= 0) return 0;
  try {
    if (platform === "win32") return readWin32ProcessMemoryMB(pid);
    if (platform === "linux") return readLinuxProcessMemoryMB(pid);
    if (platform === "darwin") return readDarwinProcessMemoryMB(pid);
  } catch { /* */ }
  return 0;
}

function readDarwinProcessMemoryMB(pid: number): number {
  const out = execSync(`ps -o rss= -p ${pid}`, { encoding: "utf8", timeout: 2000 }).trim();
  return out ? Math.round(Number(out) / 1024) : 0;
}

function readWin32ProcessMemoryMB(pid: number): number {
  const a = (winApi ??= initWinApi());
  const PROCESS_QUERY_INFORMATION = 0x0400;
  const PROCESS_VM_READ = 0x0010;
  const hProcess = a.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
  if (typeof hProcess !== "bigint" || hProcess === 0n) return 0;
  try {
    const PSAPI = koffi.load("psapi.dll");
    const PMC = koffi.struct("PMC", {
      cb: "uint32",
      PageFaultCount: "uint32",
      PeakWorkingSetSize: "uint64",
      WorkingSetSize: "uint64",
      QuotaPeakPagedPoolUsage: "uint64",
      QuotaPagedPoolUsage: "uint64",
      QuotaPeakNonPagedPoolUsage: "uint64",
      QuotaNonPagedPoolUsage: "uint64",
      PagefileUsage: "uint64",
      PeakPagefileUsage: "uint64",
    });
    const getMem = PSAPI.func("GetProcessMemoryInfo", "bool", ["void*", koffi.pointer(PMC), "uint32"]);
    const pmc: Record<string, unknown> = {};
    const ok = getMem(hProcess, pmc, koffi.sizeof(PMC));
    if (!ok) return 0;
    return Math.round(Number(pmc.WorkingSetSize) / (1024 * 1024));
  } finally {
    a.CloseHandle(hProcess);
  }
}

function readLinuxProcessMemoryMB(pid: number): number {
  const st = fs.readFileSync(`/proc/${pid}/status`, "utf8");
  const m = st.match(/^VmRSS:\s+(\d+)\s+kB/m);
  return m ? Math.round(Number(m[1]) / 1024) : 0;
}

// ── Memory pressure: cap agents at current usage ───────────────────────────

export function applyMemoryPressure(pid: number, currentMB: number, marginMB = 200): void {
  if (pid <= 0) return;
  try {
    if (platform === "win32") applyWin32Pressure(pid, currentMB, marginMB);
    if (platform === "linux") applyLinuxPressure(pid, currentMB, marginMB);
  } catch { /* best-effort */ }
}

function applyWin32Pressure(pid: number, currentMB: number, marginMB: number): void {
  const a = (winApi ??= initWinApi());
  const handle = jobHandles.get(pid);
  if (!handle) { log.debug("pressure: no job handle", { pid }); return; }

  const newCapBytes = BigInt(Math.max(currentMB + marginMB, 1)) * 1024n * 1024n;
  const z = 0n;
  const extInfo = {
    BasicLimitInformation: {
      PerProcessUserTimeLimit: z,
      PerJobUserTimeLimit: z,
      LimitFlags: JOB_OBJECT_LIMIT_PROCESS_MEMORY,
      MinimumWorkingSetSize: z,
      MaximumWorkingSetSize: z,
      ActiveProcessLimit: 0, Affinity: z, PriorityClass: 0, SchedulingClass: 0,
    },
    IoInfo: {
      ReadOperationCount: z, WriteOperationCount: z, OtherOperationCount: z,
      ReadTransferCount: z, WriteTransferCount: z, OtherTransferCount: z,
    },
    ProcessMemoryLimit: newCapBytes, JobMemoryLimit: z,
    PeakProcessMemoryUsed: z, PeakJobMemoryUsed: z,
  };
  if (!a.SetExtendedLimitInfo(handle, JobObjectExtendedLimitInformation, extInfo, koffi.sizeof(a.ExtendedLimitInfo))) {
    log.warn("pressure: SetExtendedLimitInfo failed", { pid, newCapMB: currentMB + marginMB });
  }

  const hProcess = a.OpenProcess(PROCESS_SET_QUOTA, 0, pid);
  if (typeof hProcess === "bigint" && hProcess !== 0n) {
    const wsBytes = BigInt(currentMB) * 1024n * 1024n;
    a.SetProcessWorkingSetSizeEx(hProcess, wsBytes, wsBytes, 0);
    a.CloseHandle(hProcess);
  }
}

function applyLinuxPressure(pid: number, currentMB: number, marginMB: number): void {
  const newCap = BigInt(currentMB + marginMB) * 1024n * 1024n;
  try {
    const cgDir = `/sys/fs/cgroup/open-tag-agent-${pid}`;
    if (fs.existsSync(path.join(cgDir, "memory.high"))) {
      // Use memory.high (throttle/reclaim) instead of memory.max (hard limit → OOM kill)
      fs.writeFileSync(path.join(cgDir, "memory.high"), String(newCap));
    }
  } catch { /* */ }
}

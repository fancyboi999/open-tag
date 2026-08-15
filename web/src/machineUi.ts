export interface MachineVersionState {
  status?: string;
  daemonVersion?: string;
}

export function isDaemonOutdated(current: string | undefined, latest: string | undefined): boolean {
  const cur = parseSemver(current);
  const next = parseSemver(latest);
  if (!cur || !next) return false;
  for (let i = 0; i < 3; i++) {
    if (cur[i]! < next[i]!) return true;
    if (cur[i]! > next[i]!) return false;
  }
  return false;
}

function parseSemver(v: string | undefined): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v ?? "");
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function isDaemonUpdateAvailable(machine: MachineVersionState | null | undefined, latestDaemonVersion: string): boolean {
  return !!machine
    && machine.status === "online"
    && isDaemonOutdated(machine.daemonVersion, latestDaemonVersion);
}

export function daemonUpdateCommandTemplate(origin: string): string {
  return `npx @fancyboi999/open-tag-daemon@latest --server-url ${origin} --api-key <your sk_machine_... key>`;
}

// The runnable connect command with a real machine key filled in (the connect-computer wizard has the
// freshly-minted key; daemonUpdateCommandTemplate keeps a placeholder for the key-not-shown update flow).
export function daemonConnectCommand(origin: string, key: string): string {
  return `npx @fancyboi999/open-tag-daemon@latest --server-url ${origin} --api-key ${key}`;
}

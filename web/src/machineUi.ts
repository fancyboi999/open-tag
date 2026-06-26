export interface MachineVersionState {
  status?: string;
  daemonVersion?: string;
}

export function isDaemonUpdateAvailable(machine: MachineVersionState | null | undefined, latestDaemonVersion: string): boolean {
  return !!machine
    && machine.status === "online"
    && !!machine.daemonVersion
    && !!latestDaemonVersion
    && machine.daemonVersion !== latestDaemonVersion;
}

export function daemonUpdateCommandTemplate(origin: string): string {
  return `npx @fancyboi999/open-tag-daemon@latest --server-url ${origin} --api-key <your sk_machine_... key>`;
}

export interface AgentStartGuardAgent { machineId: string | null; runtime: string; }
export interface AgentStartGuardMachine { id: string; status: string; runtimes: string[]; }

export function agentStartBlockReason(
  agent: AgentStartGuardAgent,
  machine: AgentStartGuardMachine | null | undefined,
  hasDaemon: boolean,
): string | null {
  if (!hasDaemon) return "no daemon online";
  if (!agent.machineId) return null;
  if (!machine || machine.id !== agent.machineId) return "machine not found";
  if (machine.status !== "online") return "machine offline";
  if (!machine.runtimes.includes(agent.runtime)) return `runtime ${agent.runtime} unavailable on selected machine`;
  return null;
}

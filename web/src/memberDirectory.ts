import type { Agent, Human } from "./store.tsx";

export interface MemberDirectoryFilters {
  query: string;
  kind: string;
  status: string;
  role: string;
}

function agentStatus(agent: Pick<Agent, "activity" | "status">): string {
  return agent.activity && agent.activity !== "offline" ? agent.activity : agent.status;
}

function statusMatches(actual: string, requested: string): boolean {
  if (requested === "all") return true;
  if (requested === "active") return actual === "active" || actual === "online";
  if (requested === "offline") return actual === "inactive" || actual === "offline";
  if (requested === "failure") return actual === "error" || actual === "failed";
  return actual === requested;
}

export function filterMemberDirectory(agents: Agent[], humans: Human[], filters: MemberDirectoryFilters) {
  const query = filters.query.trim().toLocaleLowerCase();
  const matches = (person: Agent | Human) => !query || [person.name, person.displayName, person.description, "role" in person ? person.role : "", "runtime" in person ? person.runtime : ""]
    .some((value) => String(value || "").toLocaleLowerCase().includes(query));
  return {
    agents: filters.kind === "humans" ? [] : agents.filter((agent) => matches(agent) && statusMatches(agentStatus(agent), filters.status)),
    humans: filters.kind === "agents" ? [] : humans.filter((human) => matches(human) && (filters.role === "all" || (human.role || "member") === filters.role)),
  };
}

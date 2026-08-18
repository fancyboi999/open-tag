// Stateless disinfection gateway view (live 2026-08-18): for agents with incoming_mode
// "sanitized", non-whitelisted agent senders' messages are replaced by the daemon-run one-shot
// sanitizer's data-only output; "sealed" drops them. Fail closed (drop) when no daemon/gateway.
import { requestDaemon } from "./daemonHub.js";
import { senderAllowedByPolicy, type TriggerPolicySubject } from "./triggerPolicy.js";

const cache = new Map<string, string>(); // messageId -> sanitized text (memory-only; re-sanitize after restart)
export const NO_PAYLOAD = "无数据载荷";
export const SANITIZED_PREFIX = "[网关消毒输出] ";

export async function applyPolicyView<T extends { id: string; senderType: string; senderId: string | null; content: string }>(
  serverId: string,
  machineId: string | null,
  agent: TriggerPolicySubject,
  messages: T[],
): Promise<{ view: T[]; replaced: Set<string> }> {
  const mode = agent.incomingMode ?? "open";
  if (mode === "open") return { view: messages, replaced: new Set() };
  const view: T[] = [];
  const replaced = new Set<string>();
  for (const m of messages) {
    if (senderAllowedByPolicy(agent, m.senderType, m.senderId ?? "")) { view.push(m); continue; }
    if (mode !== "sanitized") continue; // sealed: invisible
    const cached = cache.get(m.id);
    const s: string | null = cached !== undefined ? cached : await sanitizeViaDaemon(serverId, machineId, m.content);
    if (s !== null && cached === undefined) cache.set(m.id, s);
    if (s === null || s === "" || s === NO_PAYLOAD) continue; // fail closed / no data payload
    view.push({ ...m, content: SANITIZED_PREFIX + s });
    replaced.add(m.id);
  }
  return { view, replaced };
}

async function sanitizeViaDaemon(serverId: string, machineId: string | null, raw: string): Promise<string | null> {
  if (!machineId) return null;
  try {
    const r = await requestDaemon(serverId, { type: "sanitize", text: raw }, 30_000, true);
    if (!r || r.error) return null;
    return String(r.text ?? "").trim();
  } catch {
    return null; // gateway unavailable → fail closed
  }
}

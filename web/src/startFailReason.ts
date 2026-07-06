// Agent start-failure reason → i18n key. The server's 503 body carries a machine-readable-ish English
// reason (the closed set from src/server/agentStartGuard.ts agentStartBlockReason); mapping it here keeps
// the toast fully localized instead of splicing raw English into a translated sentence. Unknown reasons
// return null — the caller falls back to showing the raw server string (information > cosmetics).
// ⚠️ Keep in sync with agentStartBlockReason; the unit test's drift guard asserts every mapped key exists
// in both locale files.
export function startFailReasonKey(reason: string): { key: string; params?: Record<string, string> } | null {
  if (reason === "no daemon online") return { key: "members.startFailReasonNoDaemon" };
  if (reason === "machine not found") return { key: "members.startFailReasonMachineNotFound" };
  if (reason === "machine offline") return { key: "members.startFailReasonMachineOffline" };
  const m = /^runtime (\S+) unavailable on selected machine$/.exec(reason);
  if (m) return { key: "members.startFailReasonRuntimeUnavailable", params: { runtime: m[1]! } };
  return null;
}

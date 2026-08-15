// Live model discovery for the user-facing runtime-models endpoint. We ask THAT machine's daemon to
// probe its installed CLI — the server has no such CLI or login — cache the result briefly per
// (machine,runtime), and let the caller fall back to a static candidate list on miss/offline/timeout.
import { requestDaemonByMachine } from "./daemonHub.js";

export interface ModelOption {
  id: string;
  label: string;
  provider?: string;
  default?: boolean;
  thinking?: { levels: { value: string; label: string; description?: string }[]; default?: string };
}

export const CODEX_FALLBACK_MODELS: ModelOption[] = [
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  { id: "gpt-5.5", label: "GPT-5.5" },
  { id: "gpt-5.4", label: "GPT-5.4" },
  { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
  { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" },
  { id: "gpt-5.2-codex", label: "GPT-5.2 Codex" },
  { id: "gpt-5.2", label: "GPT-5.2" },
  { id: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max" },
  { id: "gpt-5.1-codex", label: "GPT-5.1 Codex" },
  { id: "gpt-5-codex", label: "GPT-5 Codex" },
];

// Runtimes probed live on the machine: opencode/cursor/pi/codex enumerate their model list, Hermes
// enumerates profiles, and Claude enriches its static catalog with supported effort levels.
export const DYNAMIC_RUNTIMES = new Set(["opencode", "cursor", "pi", "hermes", "claude", "codex"]);

const TTL_MS = 60_000; // matches multica's 60s model cache — lists rarely change within a minute
const PROBE_TIMEOUT_MS = 8_000; // bound how long the modal waits on the first probe before fallback
const cache = new Map<string, { models: ModelOption[]; exp: number }>();

// Returns the machine's live model list for a runtime (cached ~60s), or null on miss/offline/timeout/
// empty so the caller serves its static fallback. Never throws.
export async function getDynamicModels(machineId: string, runtime: string): Promise<ModelOption[] | null> {
  const key = `${machineId}:${runtime}`;
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.models;
  const r = await requestDaemonByMachine(machineId, { type: "probe-models", runtime }, PROBE_TIMEOUT_MS);
  const models = Array.isArray(r?.models) ? (r.models as ModelOption[]) : null;
  if (!models || !models.length) return null; // never cache empty/error — don't lock a transient failure for 60s
  models.sort((a, b) => (b.default ? 1 : 0) - (a.default ? 1 : 0)); // default first → frontend preselects ms[0]
  cache.set(key, { models, exp: Date.now() + TTL_MS });
  return models;
}

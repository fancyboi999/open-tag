// Live model discovery for the user-facing runtime-models endpoint. For runtimes whose CLI can list
// its own models (opencode/cursor/pi) we ask THAT machine's daemon to probe live — the server has no
// such CLI or login — cache the result briefly per (machine,runtime), and let the caller fall back to
// a static candidate list on any miss/offline/timeout. claude/codex/copilot/kimi are not probed here
// (no list command, or would need an ACP handshake) — tracked in docs/tech-debt-tracker.md.
import { requestDaemonByMachine } from "./daemonHub.js";

export interface ModelOption {
  id: string;
  label: string;
  provider?: string;
  default?: boolean;
  thinking?: { levels: { value: string; label: string; description?: string }[]; default?: string };
}

// Runtimes probed live on the machine: opencode/cursor/pi/hermes enumerate their model/profile list; claude/codex
// keep a static catalog but probe each model's reasoning-effort levels. The rest stay fully static.
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

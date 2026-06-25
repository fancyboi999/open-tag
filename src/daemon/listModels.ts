// Model discovery for the CLI runtimes that can list their own models (opencode / cursor / pi).
// The daemon shells out to the runtime's list command on its own machine and parses stdout, so the
// candidates reflect what that machine + login can actually use (not a hard-coded server table).
//
// Scope (first slice): opencode / cursor / pi only.
//  - claude / codex have no "list models" command — their catalogs stay static, server-side.
//  - copilot / kimi would need an ACP (JSON-RPC over stdio) handshake — not done yet.
//  Both gaps are tracked in docs/tech-debt-tracker.md.
//
// The parse functions are pure (unit-tested against fixtures captured from multica's discovery
// research) and mirror multica's server/pkg/agent/models.go field-for-field.
import { spawn, type ChildProcess } from "node:child_process";

export interface ThinkingLevel { value: string; label: string; description?: string }
export interface ModelThinking { levels: ThinkingLevel[]; default?: string }
export interface DiscoveredModel {
  id: string;
  label: string;
  provider?: string;
  default?: boolean;
  thinking?: ModelThinking; // reasoning-effort levels this model supports (claude/codex)
}

const titleCase = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

// A model id is a token that starts with a letter and holds only [A-Za-z0-9-_./] (mirrors multica's
// isOpenclawIdentifier) — used to reject prose/header lines that happen to contain a separator.
function isModelId(s: string): boolean {
  return /^[A-Za-z][A-Za-z0-9\-_./]*$/.test(s);
}

// claude/codex have no "list models" command — their catalog is static, but each model's reasoning-effort
// levels ARE probed (so the UI offers exactly what the installed CLI supports, not a guess).

// `claude --help` advertises the effort *superset* on one `--effort` line:
//   `--effort <level>   Effort level for the current session (low, medium, high, xhigh, max)`
// (the help wraps across lines; [^(] in the regex spans newlines, so the multi-line form still matches).
// But that superset has per-model gaps the CLI does NOT express programmatically — xhigh is Opus-only,
// max is not offered on Haiku. So we parse the superset, then project it through a per-model allow-list
// (multica's hand-maintained claudeModelEffortAllow, MUL-2339, thinking.go — collapsed to our short ids).
// Over-offering a level the model rejects would defeat the point of discovery, so we filter, not flatten.
const CLAUDE_MODELS: { id: string; label: string }[] = [
  { id: "sonnet", label: "Sonnet" }, { id: "opus", label: "Opus" }, { id: "haiku", label: "Haiku" },
];

// Friendly labels for Claude's effort tokens (matches Anthropic's own slash UI; titleCase would give "Xhigh").
const CLAUDE_EFFORT_LABEL: Record<string, string> = {
  low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max",
};

// Per-model effort allow-list. A model absent from this map keeps the full parsed superset (defensive:
// a newly-shipped alias still gets a usable picker until the table is updated). Update when Anthropic
// ships a model with a different effort surface.
const CLAUDE_MODEL_EFFORT_ALLOW: Record<string, Set<string>> = {
  opus: new Set(["low", "medium", "high", "xhigh", "max"]),
  sonnet: new Set(["low", "medium", "high", "max"]),
  haiku: new Set(["low", "medium", "high"]),
};

export function parseClaudeEffortLevels(helpText: string): string[] {
  const m = /--effort\s*(?:<[^>]+>)?\s*(?:Effort level[^(]*)?\(([^)]+)\)/.exec(helpText);
  if (!m) return [];
  return m[1]!.split(",").map((s) => s.trim()).filter((s) => /^[a-z]+$/i.test(s));
}

// Project the parsed effort superset onto one model: keep only the levels the model supports (∩ allow-list),
// label them, and default to medium when offered. Returns undefined when nothing survives (UI hides the picker).
export function claudeThinkingForModel(modelId: string, superset: string[]): ModelThinking | undefined {
  const allow = CLAUDE_MODEL_EFFORT_ALLOW[modelId];
  const levels: ThinkingLevel[] = superset
    .filter((v) => !allow || allow.has(v))
    .map((v) => ({ value: v, label: CLAUDE_EFFORT_LABEL[v] ?? titleCase(v) }));
  if (!levels.length) return undefined;
  return { levels, default: levels.some((l) => l.value === "medium") ? "medium" : levels[0]!.value };
}

// codex: `codex debug models` emits the raw catalog as JSON. Each model carries per-model
// supported_reasoning_levels + default_reasoning_level; visibility "list" = shown (drop "hide").
export function parseCodexModels(jsonStr: string): DiscoveredModel[] {
  let parsed: any;
  try { parsed = JSON.parse(jsonStr); } catch { return []; }
  const models = Array.isArray(parsed?.models) ? parsed.models : [];
  const out: DiscoveredModel[] = [];
  for (const m of models) {
    if (m?.visibility !== "list") continue; // whitelist: only explicitly "list" models show — a hidden/unmarked one never leaks
    const slug = typeof m?.slug === "string" ? m.slug : "";
    if (!slug) continue;
    const raw = Array.isArray(m?.supported_reasoning_levels) ? m.supported_reasoning_levels : [];
    const levels: ThinkingLevel[] = raw
      .map((l: any) => ({ value: String(l?.effort ?? ""), label: titleCase(String(l?.effort ?? "")), description: typeof l?.description === "string" ? l.description : undefined }))
      .filter((l: ThinkingLevel) => l.value);
    const thinking = levels.length ? { levels, default: typeof m?.default_reasoning_level === "string" ? m.default_reasoning_level : undefined } : undefined;
    out.push({ id: slug, label: typeof m?.display_name === "string" && m.display_name ? m.display_name : slug, provider: "openai", ...(thinking ? { thinking } : {}) });
  }
  return out;
}

// `opencode models [--verbose]`: one `provider/model` per line. In --verbose a JSON block (reasoning
// variants — not consumed in this slice) follows each id. Skip the `PROVIDER/MODEL` header and any
// line that starts a JSON block (`{` / `"`).
export function parseOpencodeModels(stdout: string): DiscoveredModel[] {
  const out: DiscoveredModel[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("{") || line.startsWith('"') || line.startsWith("}")) continue; // verbose JSON block
    if (line === line.toUpperCase() && /[A-Z]/.test(line)) continue; // PROVIDER/MODEL header
    const id = line.split(/\s+/)[0]!; // defensive: a verbose line could trail metadata
    const slash = id.indexOf("/");
    if (slash <= 0 || slash >= id.length - 1) continue; // need a non-empty provider AND model
    out.push({ id, label: id, provider: id.slice(0, slash) });
  }
  return out;
}

// `cursor-agent --list-models`: `<id> - <label>` lines under an "Available models" header. A
// `(current, default)`-style suffix marks the default; provider is always "cursor".
export function parseCursorModels(stdout: string): DiscoveredModel[] {
  const out: DiscoveredModel[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const sep = line.indexOf(" - ");
    if (sep < 0) continue; // skip the "Available models" header & blank lines
    const id = line.slice(0, sep).trim();
    if (!isModelId(id)) continue;
    let label = line.slice(sep + 3).trim();
    const isDefault = /default/i.test(label);
    const paren = label.indexOf("("); // strip "(current, default)" and the like
    if (paren >= 0) label = label.slice(0, paren).trim();
    out.push({ id, label: label || id, provider: "cursor", ...(isDefault ? { default: true } : {}) });
  }
  return out;
}

// `pi --list-models`: either `provider:model` lines (old) or a whitespace `provider model …` table
// (new). Skip the `provider …` header row and warning/error/info noise lines.
export function parsePiModels(out: string): DiscoveredModel[] {
  const res: DiscoveredModel[] = [];
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (isPiNoise(line)) continue;
    const fields = line.split(/\s+/);
    const first = fields[0]!;
    if (first.toLowerCase() === "provider") continue; // table header row
    let id: string;
    if (first.includes(":") || first.includes("/")) id = first.replace(":", "/");
    else if (fields.length >= 2) id = `${first}/${fields[1]}`;
    else continue;
    const slash = id.indexOf("/");
    if (slash <= 0 || slash >= id.length - 1) continue; // both sides non-empty
    res.push({ id, label: id, provider: id.slice(0, slash) });
  }
  return res;
}

function isPiNoise(line: string): boolean {
  const l = line.toLowerCase();
  return l.includes("no models match pattern") || l.startsWith("warning:") || l.startsWith("error:") || l.startsWith("info:");
}

// ── shelling out (not unit-tested — covered by the live E2E run) ──

const LIST_TIMEOUT_MS = 7_000; // a single probe must stay under runtimeModels' 8s WS-RPC budget, else the server gives up while the daemon keeps spawning
const OUT_CAP = 256 * 1024; // bound memory if a CLI floods stdout

// Run a runtime's list command and capture stdout/stderr. Uses the daemon's own env (so the CLI sees
// the same login/config the agent runs use) minus NODE_OPTIONS — a proxy flag there makes some
// bundled CLIs refuse to start (same gotcha the opencode/cursor/pi runtimes guard against).
function runList(bin: string, args: string[], timeoutMs: number = LIST_TIMEOUT_MS): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    let proc: ChildProcess;
    try {
      proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env });
    } catch (e) {
      return resolve({ stdout: "", stderr: String((e as any)?.message ?? e), code: 1 });
    }
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (c: Buffer) => { if (stdout.length < OUT_CAP) stdout += c.toString(); });
    proc.stderr?.on("data", (c: Buffer) => { if (stderr.length < OUT_CAP) stderr += c.toString(); });
    const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* */ } }, timeoutMs);
    proc.on("error", (e) => { clearTimeout(timer); resolve({ stdout, stderr: stderr || String((e as any)?.message ?? e), code: 1 }); });
    proc.on("exit", (code) => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
  });
}

// Probe the live model list for a runtime on this machine. Returns null for runtimes we can't probe
// (claude/codex/copilot/kimi) or when the probe yields nothing — the caller falls back to a static
// list. Never throws; a missing CLI surfaces as the spawn "error" event → empty output → null.
export async function listModels(runtime: string): Promise<DiscoveredModel[] | null> {
  switch (runtime) {
    case "opencode": {
      // Two attempts share the server's probe budget: verbose first, then a quick non-verbose retry.
      // 5s + 2s stays under runtimeModels' 8s WS-RPC timeout so the server never waits on a probe it
      // already gave up on (the retry hits a now-warm CLI, so 2s suffices).
      let r = await runList("opencode", ["models", "--verbose"], 5_000);
      let models = parseOpencodeModels(r.stdout);
      if (!models.length) { r = await runList("opencode", ["models"], 2_000); models = parseOpencodeModels(r.stdout); }
      return models.length ? models : null;
    }
    case "cursor": {
      const r = await runList("cursor-agent", ["--list-models"]);
      const models = parseCursorModels(r.stdout);
      return models.length ? models : null;
    }
    case "pi": {
      const r = await runList("pi", ["--list-models"]);
      const models = parsePiModels(r.stdout || r.stderr); // older pi writes the list to stderr
      return models.length ? models : null;
    }
    case "claude": {
      const r = await runList("claude", ["--help"]);
      const superset = parseClaudeEffortLevels(r.stdout || r.stderr);
      if (!superset.length) return null; // no effort info → static fallback (no thinking)
      return CLAUDE_MODELS.map((m) => {
        const thinking = claudeThinkingForModel(m.id, superset); // per-model effort subset, not the flat superset
        return { ...m, provider: "anthropic", ...(thinking ? { thinking } : {}) };
      });
    }
    case "codex": {
      const r = await runList("codex", ["debug", "models"]);
      const models = parseCodexModels(r.stdout);
      return models.length ? models : null;
    }
    default:
      return null;
  }
}

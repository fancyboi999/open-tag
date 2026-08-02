// Unit tests for daemon model discovery parsers (opencode / cursor / pi / reasonix). Pure string → model[].
// Fixtures are stdout samples from multica's discovery research (server/pkg/agent/models.go).
// Run: npx tsx --test --test-force-exit test/listModels.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { parseOpencodeModels, parseCursorModels, parsePiModels, parseClaudeEffortLevels, claudeThinkingForModel, parseCodexModels, parseReasonixModels } from "../src/daemon/listModels.ts";

// ── opencode ──
test("opencode: plain (non-verbose) lines → provider/model", () => {
  const out = parseOpencodeModels("openai/gpt-4o\nanthropic/claude-opus-4-8\ngoogle/gemini-2.5-pro\n");
  assert.deepEqual(out.map((m) => m.id), ["openai/gpt-4o", "anthropic/claude-opus-4-8", "google/gemini-2.5-pro"]);
  assert.deepEqual(out.map((m) => m.provider), ["openai", "anthropic", "google"]);
  assert.equal(out[0]!.label, "openai/gpt-4o"); // label = full id (no separate label in opencode output)
});

test("opencode: --verbose skips the JSON blocks and the PROVIDER/MODEL header", () => {
  const stdout = [
    "PROVIDER/MODEL",
    "anthropic/claude-sonnet-4-6",
    "{",
    '  "reasoning": true,',
    '  "variants": { "none": {}, "medium": {}, "high": {} }',
    "}",
    "openai/gpt-5.5",
    '{ "reasoning": false }',
    "google/gemini-2.5-pro",
  ].join("\n");
  const out = parseOpencodeModels(stdout);
  assert.deepEqual(out.map((m) => m.id), ["anthropic/claude-sonnet-4-6", "openai/gpt-5.5", "google/gemini-2.5-pro"]);
});

test("opencode: empty stdout → []", () => {
  assert.deepEqual(parseOpencodeModels(""), []);
});

// ── cursor ──
test("cursor: `<id> - <label>` lines, header skipped, default detected, suffix stripped", () => {
  const stdout = [
    "Available models",
    "",
    "auto - Auto",
    "composer-2-fast - Composer 2 Fast (current, default)",
    "composer-2 - Composer 2",
    "claude-4.6-sonnet-medium - Claude 4.6 Sonnet Medium",
  ].join("\n");
  const out = parseCursorModels(stdout);
  assert.deepEqual(out.map((m) => m.id), ["auto", "composer-2-fast", "composer-2", "claude-4.6-sonnet-medium"]);
  assert.equal(out[1]!.label, "Composer 2 Fast"); // "(current, default)" stripped
  assert.equal(out[1]!.default, true);
  assert.equal(out[0]!.default ?? false, false);
  assert.ok(out.every((m) => m.provider === "cursor"));
});

// ── pi ──
test("pi: old `provider:model` format → provider/model", () => {
  const out = parsePiModels("openai:gpt-4o\nanthropic:claude-opus-4-8\n");
  assert.deepEqual(out.map((m) => m.id), ["openai/gpt-4o", "anthropic/claude-opus-4-8"]);
  assert.deepEqual(out.map((m) => m.provider), ["openai", "anthropic"]);
});

test("pi: new whitespace-table format, header row skipped", () => {
  const stdout = ["provider   model              context", "openai     gpt-4o             128000", "anthropic  claude-opus-4-8    200000"].join("\n");
  const out = parsePiModels(stdout);
  assert.deepEqual(out.map((m) => m.id), ["openai/gpt-4o", "anthropic/claude-opus-4-8"]);
});

test("pi: warning/error/info noise lines filtered out", () => {
  const stdout = ["warning: no config found", "openai:gpt-4o", "no models match pattern", "info: done"].join("\n");
  const out = parsePiModels(stdout);
  assert.deepEqual(out.map((m) => m.id), ["openai/gpt-4o"]);
});

// ── claude thinking (effort levels parsed from `claude --help`; fixture = real claude 2.1.191 wrapping) ──
test("claude: parses --effort levels across the wrapped help line", () => {
  const help = [
    "  --disallowedTools <tools...>          Deny tools",
    "  --effort <level>                      Effort level for the current session",
    "                                        (low, medium, high, xhigh, max)",
    "  --exclude-dynamic-system-prompt-sections",
  ].join("\n");
  assert.deepEqual(parseClaudeEffortLevels(help), ["low", "medium", "high", "xhigh", "max"]);
});

test("claude: no --effort line → []", () => {
  assert.deepEqual(parseClaudeEffortLevels("  --model <m>   Model to use\n"), []);
});

// ── claude per-model effort projection (multica's claudeModelEffortAllow: xhigh is Opus-only, max not on Haiku) ──
const FULL = ["low", "medium", "high", "xhigh", "max"];
test("claude effort: opus keeps the full superset", () => {
  assert.deepEqual(claudeThinkingForModel("opus", FULL)?.levels.map((l) => l.value), ["low", "medium", "high", "xhigh", "max"]);
});

test("claude effort: sonnet drops xhigh, keeps max", () => {
  assert.deepEqual(claudeThinkingForModel("sonnet", FULL)?.levels.map((l) => l.value), ["low", "medium", "high", "max"]);
});

test("claude effort: haiku drops both xhigh and max", () => {
  assert.deepEqual(claudeThinkingForModel("haiku", FULL)?.levels.map((l) => l.value), ["low", "medium", "high"]);
});

test("claude effort: friendly labels (xhigh → 'Extra high', not 'Xhigh') and medium default", () => {
  const t = claudeThinkingForModel("opus", FULL)!;
  assert.equal(t.levels.find((l) => l.value === "xhigh")!.label, "Extra high");
  assert.equal(t.levels.find((l) => l.value === "max")!.label, "Max");
  assert.equal(t.default, "medium");
});

test("claude effort: result is superset ∩ allow-list (CLI that lists only low/medium/high → opus gets those 3)", () => {
  assert.deepEqual(claudeThinkingForModel("opus", ["low", "medium", "high"])?.levels.map((l) => l.value), ["low", "medium", "high"]);
});

test("claude effort: unknown model id keeps the full superset (defensive — new alias still gets a picker)", () => {
  assert.deepEqual(claudeThinkingForModel("future-model", FULL)?.levels.map((l) => l.value), ["low", "medium", "high", "xhigh", "max"]);
});

// ── codex thinking (`codex debug models` JSON; fixture mirrors real codex-cli 0.142.0) ──
test("codex: parses JSON, drops non-list visibility, maps per-model reasoning levels", () => {
  const json = JSON.stringify({
    models: [
      { slug: "gpt-5.5", display_name: "GPT-5.5", default_reasoning_level: "medium", visibility: "list", supported_in_api: true,
        supported_reasoning_levels: [{ effort: "low", description: "Fast" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }] },
      { slug: "codex-auto-review", display_name: "Auto Review", visibility: "hide", supported_reasoning_levels: [{ effort: "low" }] },
    ],
  });
  const out = parseCodexModels(json);
  assert.deepEqual(out.map((m) => m.id), ["gpt-5.5"]); // "hide" model filtered out
  assert.equal(out[0]!.label, "GPT-5.5");
  assert.equal(out[0]!.provider, "openai");
  assert.deepEqual(out[0]!.thinking?.levels.map((l) => l.value), ["low", "medium", "high", "xhigh"]);
  assert.equal(out[0]!.thinking?.levels[0]!.label, "Low"); // title-cased
  assert.equal(out[0]!.thinking?.default, "medium");
});

test("codex: malformed JSON → []", () => {
  assert.deepEqual(parseCodexModels("not json at all"), []);
});

test("codex: whitelist — only visibility:list shows; unmarked or hidden never leak", () => {
  const json = JSON.stringify({
    models: [
      { slug: "shown", visibility: "list", supported_reasoning_levels: [{ effort: "low" }] },
      { slug: "no-visibility-field", supported_reasoning_levels: [{ effort: "low" }] }, // missing → excluded
      { slug: "hidden", visibility: "hide", supported_reasoning_levels: [{ effort: "low" }] },
    ],
  });
  assert.deepEqual(parseCodexModels(json).map((m) => m.id), ["shown"]);
});

// ── reasonix (`reasonix doctor --json`; fixtures are REAL captured output from reasonix v1.18.0,
//    behavior re-verified live on v1.19.1) ──
// Load-bearing detail: v1.18.0/v1.19.1 emit `is_default: false` on EVERY provider even though
// `config.default_model` names one. The default must come from default_model, not the flag.
test("reasonix: enumerates provider models and marks config.default_model as the default", () => {
  const json = JSON.stringify({
    version: "v1.18.0", cwd: "/tmp",
    config: { source_path: "~/.reasonix/config.toml", user_path: "~/.reasonix/config.toml", default_model: "hy3/hy3-ioa" },
    providers: [
      { name: "deepseek-flash", kind: "openai", model: "deepseek-v4-flash-ioa", models: ["deepseek-v4-flash-ioa"], is_default: false, context_window: 1000000 },
      { name: "deepseek-pro", kind: "openai", model: "deepseek-v4-pro-ioa", models: ["deepseek-v4-pro-ioa"], is_default: false },
      { name: "kimi-k3", kind: "openai", model: "kimi-k3-ioa", models: ["kimi-k3-ioa"], is_default: false },
      { name: "hy3", kind: "openai", model: "hy3-ioa", models: ["hy3-ioa"], is_default: false },
    ],
  });
  const out = parseReasonixModels(json);
  assert.deepEqual(out.map((m) => m.id), ["deepseek-v4-flash-ioa", "deepseek-v4-pro-ioa", "kimi-k3-ioa", "hy3-ioa"]);
  assert.equal(out.find((m) => m.id === "hy3-ioa")?.default, true, "default_model hy3/hy3-ioa must mark hy3-ioa");
  assert.equal(out.filter((m) => m.default).length, 1, "exactly one model may be the default");
  assert.equal(out[0]!.default ?? false, false, "config order must NOT decide the default");
  assert.equal(out[0]!.provider, "deepseek-flash");
});

test("reasonix: default_model as a bare provider name or a bare model id both resolve", () => {
  const providers = [
    { name: "kimi-k3", model: "kimi-k3-ioa", models: ["kimi-k3-ioa"] },
    { name: "hy3", model: "hy3-ioa", models: ["hy3-ioa"] },
  ];
  const byProvider = parseReasonixModels(JSON.stringify({ config: { default_model: "hy3" }, providers }));
  assert.equal(byProvider.find((m) => m.id === "hy3-ioa")?.default, true, "bare provider name resolves");
  const byModel = parseReasonixModels(JSON.stringify({ config: { default_model: "kimi-k3-ioa" }, providers }));
  assert.equal(byModel.find((m) => m.id === "kimi-k3-ioa")?.default, true, "bare model id resolves");
  // an explicit is_default flag still wins if a future build starts setting it
  const flagged = parseReasonixModels(JSON.stringify({ config: { default_model: "hy3" }, providers: [{ name: "kimi-k3", models: ["kimi-k3-ioa"], is_default: true }, providers[1]] }));
  assert.equal(flagged.find((m) => m.id === "kimi-k3-ioa")?.default, true);
});

test("reasonix: a provider's `models` list form is honored; duplicate ids are dropped", () => {
  const json = JSON.stringify({
    config: { default_model: "kimi-k3" },
    providers: [
      { name: "kimi-k3", model: "kimi-k3-ioa", models: ["kimi-k3-ioa", "kimi-k3-lite"] },
      { name: "alias", model: "kimi-k3-ioa", models: ["kimi-k3-ioa"] }, // same model id under a second provider
    ],
  });
  const out = parseReasonixModels(json);
  assert.deepEqual(out.map((m) => m.id), ["kimi-k3-ioa", "kimi-k3-lite"]); // deduped, no re-order
  assert.equal(out[0]!.default, true);
});

test("reasonix: malformed JSON, empty providers, or an unmatched default → no crash / no default", () => {
  assert.deepEqual(parseReasonixModels("not json at all"), []);
  assert.deepEqual(parseReasonixModels(JSON.stringify({ providers: [] })), []);
  const orphan = parseReasonixModels(JSON.stringify({ config: { default_model: "gone/missing" }, providers: [{ name: "hy3", models: ["hy3-ioa"] }] }));
  assert.equal(orphan.length, 1);
  assert.equal(orphan[0]!.default ?? false, false, "a default_model naming no configured provider marks nothing");
});

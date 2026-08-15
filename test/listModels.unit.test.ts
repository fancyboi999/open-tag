// Unit tests for daemon model discovery parsers, bounded CLI capture, and server fallbacks.
// Parser fixtures mirror real runtime discovery output; the large-output case uses a fake executable.
// Run: npx tsx --test test/listModels.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { claudeThinkingForModel, parseClaudeEffortLevels, parseCodexModels, parseCursorModels, parseOpencodeModels, parsePiModels, runList } from "../src/daemon/listModels.ts";
import { CODEX_FALLBACK_MODELS } from "../src/server/runtimeModels.ts";

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

// ── codex models + thinking (`codex debug models` JSON) ──
test("codex: parses JSON, drops non-list visibility, maps per-model reasoning levels", () => {
  const json = JSON.stringify({
    models: [
      { slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol", default_reasoning_level: "low", visibility: "list", supported_in_api: true,
        supported_reasoning_levels: [{ effort: "low", description: "Fast" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }, { effort: "max" }, { effort: "ultra" }] },
      { slug: "gpt-5.6-terra", display_name: "GPT-5.6 Terra", default_reasoning_level: "medium", visibility: "list", supported_in_api: true,
        supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }, { effort: "max" }, { effort: "ultra" }] },
      { slug: "gpt-5.6-luna", display_name: "GPT-5.6 Luna", default_reasoning_level: "medium", visibility: "list", supported_in_api: true,
        supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }, { effort: "max" }] },
      { slug: "codex-auto-review", display_name: "Auto Review", visibility: "hide", supported_reasoning_levels: [{ effort: "low" }] },
    ],
  });
  const out = parseCodexModels(json);
  assert.deepEqual(out.map((m) => m.id), ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]); // "hide" model filtered out
  assert.equal(out[0]!.label, "GPT-5.6 Sol");
  assert.equal(out[0]!.provider, "openai");
  assert.deepEqual(out[0]!.thinking?.levels.map((l) => l.value), ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.equal(out[0]!.thinking?.levels[0]!.label, "Low"); // title-cased
  assert.equal(out[0]!.thinking?.default, "low");
});

test("codex: live probe accepts a catalog larger than the old 256 KiB ceiling", async () => {
  const script = `const payload = { models: [{ slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol", visibility: "list", supported_reasoning_levels: [{ effort: "low" }] }], padding: "x".repeat(400000) }; process.stdout.write(JSON.stringify(payload));`;
  const result = await runList(process.execPath, ["-e", script]);
  assert.equal(result.code, 0);
  assert.deepEqual(parseCodexModels(result.stdout).map((m) => m.id), ["gpt-5.6-sol"]);
});

test("codex: static fallback contains exact GPT-5.6 CLI slugs", () => {
  const ids = CODEX_FALLBACK_MODELS.map((model) => model.id);
  assert.deepEqual(ids.slice(0, 3), ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
  assert.equal(ids.includes("gpt-5.6"), false);
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

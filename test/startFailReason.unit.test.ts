// Unit tests for the agent start-failure reason → i18n key mapper (PR #165 review follow-up):
// the toast previously spliced the raw English server reason into a localized string ("无法启动 agent: no
// daemon online"). Known reasons (the closed set emitted by src/server/agentStartGuard.ts
// agentStartBlockReason) now map to i18n keys — including the parametric `runtime X unavailable…` form —
// and BOTH locale files must carry every mapped key (drift guard). Unknown reasons return null so the
// caller falls back to showing the raw server string (still better than hiding it).
// Run: npx tsx --test --test-force-exit test/startFailReason.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startFailReasonKey } from "../web/src/startFailReason.ts";

test("maps the three fixed reasons from agentStartBlockReason", () => {
  assert.deepEqual(startFailReasonKey("no daemon online"), { key: "members.startFailReasonNoDaemon" });
  assert.deepEqual(startFailReasonKey("machine not found"), { key: "members.startFailReasonMachineNotFound" });
  assert.deepEqual(startFailReasonKey("machine offline"), { key: "members.startFailReasonMachineOffline" });
});

test("maps the parametric runtime-unavailable reason and extracts the runtime name", () => {
  assert.deepEqual(startFailReasonKey("runtime codex unavailable on selected machine"),
    { key: "members.startFailReasonRuntimeUnavailable", params: { runtime: "codex" } });
  assert.deepEqual(startFailReasonKey("runtime claude unavailable on selected machine"),
    { key: "members.startFailReasonRuntimeUnavailable", params: { runtime: "claude" } });
});

test("unknown / free-form reasons return null (caller shows the raw string)", () => {
  assert.equal(startFailReasonKey("cannot start"), null);
  assert.equal(startFailReasonKey("runtime  unavailable on selected machine"), null); // empty runtime
  assert.equal(startFailReasonKey("some future reason"), null);
  assert.equal(startFailReasonKey(""), null);
});

test("every mapped key exists in BOTH locale files (drift guard)", () => {
  const locales = ["en", "zh"].map((l) =>
    JSON.parse(readFileSync(join(import.meta.dirname, "../web/src/locales", `${l}.json`), "utf8")));
  const reasons = ["no daemon online", "machine not found", "machine offline", "runtime codex unavailable on selected machine"];
  for (const reason of reasons) {
    const mapped = startFailReasonKey(reason)!;
    const [ns, key] = mapped.key.split(".");
    for (const [i, loc] of locales.entries()) {
      const val = loc[ns!]?.[key!];
      assert.equal(typeof val, "string", `locale ${["en", "zh"][i]} missing ${mapped.key}`);
      if (mapped.params) for (const p of Object.keys(mapped.params)) assert.ok(val.includes(`{{${p}}}`), `locale ${["en", "zh"][i]} ${mapped.key} missing {{${p}}} placeholder`);
    }
  }
});

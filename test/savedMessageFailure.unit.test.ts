// Static wiring contracts for saved-message mutations.
// Run: node --test-force-exit --import tsx --test test/savedMessageFailure.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { shareSavedMutation } from "../web/src/store.tsx";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const storeSrc = read("../web/src/store.tsx");
const chatSrc = read("../web/src/views/Chat.tsx");
const miscSrc = read("../web/src/views/misc.tsx");
const mutationSrc = storeSrc.slice(storeSrc.indexOf("const mutateSaved"), storeSrc.indexOf("const listSaved"));
const savedUnsaveSrc = miscSrc.slice(miscSrc.indexOf("const unsave = async"), miscSrc.indexOf("const source ="));
const en = JSON.parse(read("../web/src/locales/en.json"));
const zh = JSON.parse(read("../web/src/locales/zh.json"));

test("concurrent saved-message callers share the mutation result", async () => {
  type Result = "updated" | "failed" | "ignored";
  const mutations = new Map<string, Promise<Result>>();
  let runs = 0;
  let finish!: (result: Result) => void;
  const run = () => { runs++; return new Promise<Result>((resolve) => { finish = resolve; }); };
  const first = shareSavedMutation(mutations, "workspace:message", run);
  const second = shareSavedMutation(mutations, "workspace:message", run);
  assert.strictEqual(second, first);
  assert.equal(runs, 1);
  finish("updated");
  assert.deepEqual(await Promise.all([first, second]), ["updated", "updated"]);
  assert.equal(mutations.size, 0);
  assert.equal(await shareSavedMutation(mutations, "workspace:message", async () => { runs++; return "failed"; }), "failed");
  assert.equal(runs, 2);
});

test("bookmark mutations require strict success in the initiating workspace", () => {
  assert.match(mutationSrc, /const sid = sidRef\.current;/);
  assert.match(mutationSrc, /if \(sidRef\.current !== sid\) return "ignored";/);
  assert.match(mutationSrc, /if \(r\?\.ok !== true\) return "failed";/);
  assert.ok(mutationSrc.indexOf("sidRef.current !== sid") < mutationSrc.indexOf("r?.ok !== true"), "workspace fence must run before accepting success");
  assert.ok(mutationSrc.indexOf("r?.ok !== true") < mutationSrc.indexOf("setSavedIds"), "state must change only after confirmed success");
  assert.match(mutationSrc, /catch \{ return sidRef\.current === sid \? "failed" : "ignored"; \}/);
  assert.match(mutationSrc, /nextSaved \? "POST" : "DELETE"/);
  assert.match(mutationSrc, /const saveMsg = \(messageId: string\) => mutateSaved\(messageId, true\);/);
  assert.match(mutationSrc, /const unsaveMsg = \(messageId: string\) => mutateSaved\(messageId, false\);/);
});

test("one mutation per message is shared and ignored responses do not alter views", () => {
  assert.match(mutationSrc, /const key = `\$\{sid\}:\$\{messageId\}`;\s*return shareSavedMutation\(savedMutationsRef\.current, key,/);
  assert.match(chatSrc, /if \(savedUpdatesRef\.current\.has\(messageId\)\) return;\s*savedUpdatesRef\.current\.add\(messageId\);/);
  assert.match(chatSrc, /if \(result === "failed"\) toast\.error\(t\("common\.savedUpdateFailed"\)\);\s*\} finally \{ savedUpdatesRef\.current\.delete\(messageId\); \}/);
  assert.match(chatSrc, /className="ctx-item" onClick=\{\(\) => \{ void updateSaved\(m\.id, savedIds\.has\(m\.id\)\); close\(\); \}\}/);
  assert.match(miscSrc, /if \(result === "failed"\) \{ toast\.error\(t\("common\.savedUpdateFailed"\)\); return; \}\s*if \(result === "ignored"\) return;\s*setItems/);
  assert.match(savedUnsaveSrc, /if \(unsavingRef\.current\.has\(it\.messageId\)\) return;\s*unsavingRef\.current\.add\(it\.messageId\);/);
  assert.match(savedUnsaveSrc, /finally \{ unsavingRef\.current\.delete\(it\.messageId\); \}/);
  assert.match(miscSrc, /onClick=\{\(e\) => unsave\(e, it\)\}/);
  assert.ok(savedUnsaveSrc.indexOf('result === "failed"') < savedUnsaveSrc.indexOf('result === "ignored"'));
  assert.ok(savedUnsaveSrc.indexOf('result === "ignored"') < savedUnsaveSrc.indexOf("setItems"));
  assert.ok(savedUnsaveSrc.indexOf("setItems") < savedUnsaveSrc.indexOf("setNextOffset"));
});

test("saved-message failure feedback exists in both locales", () => {
  assert.equal(en.common.savedUpdateFailed, "Could not update saved messages");
  assert.equal(zh.common.savedUpdateFailed, "更新收藏失败");
});

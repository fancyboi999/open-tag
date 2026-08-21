import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path: string) => fs.readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n?/g, "\n");
const misc = read("../web/src/views/misc.tsx");
const store = read("../web/src/store.tsx");
const showcase = read("../web/src/views/Showcase.tsx");

test("Search, Activity, and Saved reject malformed error envelopes and expose retry feedback", () => {
  assert.match(misc, /invalid search response/);
  assert.match(misc, /invalid mentions response/);
  assert.match(misc, /invalid inbox response/);
  assert.match(store, /invalid saved messages response/);
  assert.match(misc, /role="alert"[\s\S]*?misc\.retry/);
  assert.match(misc, /role="status"/);
});

test("Search and Activity selections survive refresh and source-detail return through URL state", () => {
  assert.match(misc, /searchParams\.get\("q"\)/);
  assert.match(misc, /next\.set\("q", value\)/);
  assert.match(misc, /searchQ=\$\{encodeURIComponent\(q\)\}/);
  assert.match(misc, /searchParams\.get\("filter"\)/);
  assert.match(misc, /activityFilter=\$\{encodeURIComponent\(filter\)\}/);
  assert.match(misc, /seq !== loadSeqRef\.current/);
  assert.match(misc, /queryRef\.current\.trim\(\) !== v/);
});

test("Saved mutations keep bookmark and list state unchanged when the server rejects the change", () => {
  const mutation = store.slice(store.indexOf("const mutateSaved"), store.indexOf("const listSaved"));
  const unsave = misc.slice(misc.indexOf("const unsave = async"), misc.indexOf("const source ="));
  assert.match(mutation, /if \(r\?\.ok !== true\) return "failed";/);
  assert.ok(mutation.indexOf('return "failed"') < mutation.indexOf("setSavedIds"));
  assert.match(unsave, /if \(result === "failed"\) \{ toast\.error\(t\("common\.savedUpdateFailed"\)\); return; \}/);
  assert.ok(unsave.indexOf('result === "failed"') < unsave.indexOf("setItems"));
});

test("Showcase case selection is URL-backed for deep links and browser history", () => {
  assert.match(showcase, /searchParams\.get\("case"\)/);
  assert.match(showcase, /next\.set\("case", String\(index\)\)/);
  assert.match(showcase, /setSearchParams\(next, \{ replace: false \}\)/);
});

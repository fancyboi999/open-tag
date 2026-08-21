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

test("Saved mutations restore bookmark state and list content when the server rejects the change", () => {
  assert.match(store, /r\?\.ok !== true[\s\S]*?unsave message failed/);
  assert.match(store, /setSavedIds\(\(s\) => new Set\(s\)\.add\(messageId\)\)/);
  assert.match(misc, /catch \{ setItems\([\s\S]*?next\.splice/);
});

test("Showcase case selection is URL-backed for deep links and browser history", () => {
  assert.match(showcase, /searchParams\.get\("case"\)/);
  assert.match(showcase, /next\.set\("case", String\(index\)\)/);
  assert.match(showcase, /setSearchParams\(next, \{ replace: false \}\)/);
});

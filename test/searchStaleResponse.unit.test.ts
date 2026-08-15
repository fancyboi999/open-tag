// Unit regression for stale human-search responses overwriting the current query.
// Run: npx tsx --test --test-force-exit test/searchStaleResponse.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const miscSrc = fs.readFileSync(new URL("../web/src/views/misc.tsx", import.meta.url), "utf8");
const searchSrc = /export function Search\(\)[\s\S]*?\n}\n\n\/\/ Settings sub-pages/.exec(miscSrc)?.[0] ?? "";

test("search drops an in-flight response after the query changes or clears", () => {
  assert.match(searchSrc, /let cancelled = false/);
  assert.match(
    searchSrc,
    /const d = await api\([\s\S]*?if \(cancelled\) return;[\s\S]*?setResults\([\s\S]*?setSearched\(true\)/,
  );
  assert.match(
    searchSrc,
    /return \(\) => \{[\s\S]*?cancelled = true;[\s\S]*?clearTimeout\(h\);[\s\S]*?}/,
  );
});

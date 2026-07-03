// Unit regression for the chat message initial-load failure state.
// Run: npx tsx --test --test-force-exit test/chatInitialLoadError.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const chatSrc = fs.readFileSync(new URL("../web/src/views/Chat.tsx", import.meta.url), "utf8");
const en = JSON.parse(fs.readFileSync(new URL("../web/src/locales/en.json", import.meta.url), "utf8"));
const zh = JSON.parse(fs.readFileSync(new URL("../web/src/locales/zh.json", import.meta.url), "utf8"));

test("initial message load failure exits the skeleton and shows a retryable error state", () => {
  assert.match(chatSrc, /const \[loadError,\s*setLoadError\] = useState/);
  assert.match(chatSrc, /catch\s*(?:\([^)]*\))?\s*\{[\s\S]*setLoadError\(/);
  assert.match(chatSrc, /finally\s*\{[\s\S]*setLoaded\(true\)/);
  assert.match(chatSrc, /loaded && loadError/);
  assert.match(chatSrc, /onClick=\{loadCurrentMessages\}/);
  assert.match(chatSrc, /t\("chat\.loadFailedTitle"\)/);
  assert.match(chatSrc, /t\("chat\.loadFailedBody"\)/);
  assert.match(chatSrc, /t\("chat\.retryLoad"\)/);
});

test("initial message load drops stale async results after switching channels", () => {
  assert.match(chatSrc, /const chId = cur\.id/);
  assert.match(chatSrc, /if \(curIdRef\.current !== chId\) return;[\s\S]*setMsgs\(ms\)/);
  assert.match(chatSrc, /catch\s*(?:\([^)]*\))?\s*\{[\s\S]*if \(curIdRef\.current !== chId\) return;[\s\S]*setLoadError\(true\)/);
  assert.match(chatSrc, /finally\s*\{[\s\S]*if \(curIdRef\.current === chId\) setLoaded\(true\)/);
});

test("chat load failure copy is localized", () => {
  assert.equal(en.chat.loadFailedTitle, "Could not load this conversation");
  assert.equal(en.chat.loadFailedBody, "OpenTag could not reach the server. Check that the control plane is running, then retry.");
  assert.equal(en.chat.retryLoad, "Retry");

  assert.equal(zh.chat.loadFailedTitle, "无法加载此对话");
  assert.equal(zh.chat.loadFailedBody, "OpenTag 暂时连不上服务端。确认 control plane 正在运行后重试。");
  assert.equal(zh.chat.retryLoad, "重试");
});

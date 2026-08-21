import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const members = readFileSync(new URL("../web/src/views/Members.tsx", import.meta.url), "utf8");
const store = readFileSync(new URL("../web/src/store.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../web/src/styles.css", import.meta.url), "utf8");

test("member bootstrap rejects malformed API envelopes and exposes a retryable directory state", () => {
  assert.match(store, /!Array\.isArray\(ag\) \|\| !Array\.isArray\(hm\)/);
  assert.match(store, /setMembersState\("error"\)/);
  assert.match(members, /state === "error"[\s\S]*onRetry/);
});

test("agent and human profiles stop loading on server errors and can retry", () => {
  assert.equal((members.match(/data\.error \|\| !data\.(?:id|userId)/g) || []).length, 2);
  assert.equal((members.match(/profileLoadFailed/g) || []).length, 2);
  assert.match(members, /const r = await api\("DELETE", "\/api\/agents\/" \+ id\); if \(r\?\.error\)/);
});

test("member dialogs trap focus and expose named dialog semantics", () => {
  assert.match(members, /useDialogFocus\(onClose\)/);
  for (const id of ["invite-member-title", "create-agent-title", "restart-agent-title"]) {
    assert.match(members, new RegExp(`role="dialog" aria-modal="true" aria-labelledby="${id}"`));
  }
});

test("Agent permission editing follows manageAgents and never paints rejection as saved", () => {
  assert.match(members, /const canEdit = !!capabilities\.manageAgents/);
  assert.match(members, /disabled=\{!canEdit \|\| busy\}/);
  assert.match(members, /if \(d\?\.error \|\| !Array\.isArray\(d\?\.granted\)\)/);
  assert.match(members, /permissionsReadOnly/);
});

test("mobile member controls meet the 44px touch target contract", () => {
  assert.match(css, /\.addbtn\{width:44px;height:44px\}/);
  assert.match(css, /\.ptabs button\{flex:none;min-height:44px/);
});

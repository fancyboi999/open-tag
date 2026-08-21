import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const misc = fs.readFileSync(new URL("../web/src/views/misc.tsx", import.meta.url), "utf8");
const store = fs.readFileSync(new URL("../web/src/store.tsx", import.meta.url), "utf8");
const shell = fs.readFileSync(new URL("../web/src/baselineShell.css", import.meta.url), "utf8");
const routing = fs.readFileSync(new URL("../web/src/shellRouting.ts", import.meta.url), "utf8");
const wizard = fs.readFileSync(new URL("../web/src/views/ConnectComputerWizard.tsx", import.meta.url), "utf8");

test("settings root exposes the personal and workspace matrix", () => {
  for (const key of ["account", "language-region", "appearance", "notifications", "server", "invites", "machines"]) {
    assert.match(misc, new RegExp(`key: "${key}"`));
  }
  assert.match(misc, /!cur \? <PaneEmpty/);
});

test("settings writes reject API errors instead of painting success", () => {
  assert.match(misc, /PATCH", "\/api\/auth\/me"[\s\S]*?if \(next\?\.error\) throw/);
  assert.match(misc, /PATCH", "\/api\/servers\/" \+ serverId[\s\S]*?if \(next\?\.error\) throw/);
  assert.match(misc, /notification-settings`[\s\S]*?if \(r\?\.error\) throw/);
  assert.match(misc, /join-links`[\s\S]*?if \(r\?\.error \|\| !r\?\.id\) throw/);
});

test("notification rejection rolls the optimistic draft back", () => {
  assert.match(misc, /catch \(e: any\) \{ setMuted\(initial\.current\); setError/);
  assert.match(misc, /disabled=\{busy \|\| muted === initial\.current\}/);
});

test("workspace and invite editing follow server capabilities", () => {
  assert.match(misc, /const canEdit = !!capabilities\.manageServer/);
  assert.match(misc, /if \(!capabilities\.manageMembers\) return/);
});

test("machine loading distinguishes loading, error, empty, and ready", () => {
  assert.match(store, /machinesState: "loading" \| "refreshing" \| "ready" \| "error"/);
  assert.match(store, /if \(!Array\.isArray\(mc\?\.machines\)\) throw/);
  assert.match(misc, /machinesState === "error"/);
  assert.match(misc, /computersSelectMachine/);
  assert.match(misc, /budgetState === "error"/);
  assert.match(misc, /machineId \? <div className="page-load-error"/);
});

test("mobile settings root and details preserve the baseline hierarchy", () => {
  assert.match(shell, /data-page-id="settings"[\s\S]*?settings-sidebar\{display:flex/);
  assert.match(shell, /settings-content \.ok[\s\S]*?min-height:44px/);
});

test("machines opened from Settings keep a deterministic two-level return path", () => {
  assert.match(misc, /computer\?from=settings/);
  assert.match(routing, /id: "computers-settings", kind: "workspace-detail"[\s\S]*?parentHref: `\$\{root\}\/settings`/);
  assert.match(routing, /`\$\{root\}\/computer\$\{fromSettings \? "\?from=settings" : ""\}`/);
});

test("machine dialogs are named, modal, focus-contained, and restore the trigger", () => {
  assert.match(wizard, /useDialogFocus\(close, shown\)/);
  assert.match(wizard, /role="dialog" aria-modal="true" aria-labelledby="connect-computer-title"/);
  assert.match(misc, /aria-labelledby="daemon-update-title"/);
});

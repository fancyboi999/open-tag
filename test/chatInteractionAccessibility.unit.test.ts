import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const chat = fs.readFileSync(new URL("../web/src/views/Chat.tsx", import.meta.url), "utf8");
const sidebar = fs.readFileSync(new URL("../web/src/views/ChatSidebar.tsx", import.meta.url), "utf8");
const modal = fs.readFileSync(new URL("../web/src/ConfirmModal.tsx", import.meta.url), "utf8");

test("message actions use a keyboard-operable menu and restore their trigger", () => {
  assert.match(chat, /className="ctx-menu" role="menu"/);
  assert.match(chat, /role="menuitem"/);
  assert.match(chat, /\["ArrowDown", "ArrowUp", "Home", "End"\]/);
  assert.match(chat, /event\.key === "Escape"/);
  assert.match(chat, /ctxTriggerRef\.current\.focus\(\)/);
});

test("chat dialogs trap focus, close on Escape, and restore the opener", () => {
  assert.match(modal, /export function useDialogFocus/);
  assert.match(modal, /event\.key !== "Tab"/);
  assert.match(modal, /event\.key === "Escape"/);
  assert.match(modal, /previous\?\.isConnected && previous\.focus\(\)/);
  assert.match(chat, /role="dialog" aria-modal="true" aria-labelledby="edit-channel-title"/);
  assert.match(chat, /role="dialog" aria-modal="true" aria-labelledby="channel-members-title"/);
});

test("an opened thread receives deterministic focus on its close control", () => {
  assert.match(chat, /className="tp-close" autoFocus/);
  assert.match(chat, /const closeThread = \(\) => \{ setThread\(null\); restoreContextTrigger\(\); \}/);
});

test("the direct-message menu exposes both real humans and agents with keyboard navigation", () => {
  assert.match(sidebar, /visibleAgents\.map\(\(a\).*doDM\("agent", a\.id\)/s);
  assert.match(sidebar, /dmHumans\.map\(\(u\).*doDM\("user", u\.userId\)/s);
  assert.match(sidebar, /id="new-dm-menu" className="dm-pick" role="menu"/);
  assert.match(sidebar, /\["ArrowDown", "ArrowUp", "Home", "End"\]/);
  assert.match(sidebar, /event\.key === "Escape"/);
  assert.match(sidebar, /role="dialog" aria-modal="true" aria-labelledby="create-channel-title"/);
});

test("Baseline mobile collaboration surfaces remove Classic cards and use square thread/composer geometry", () => {
  const css = fs.readFileSync(new URL("../web/src/baselineShell.css", import.meta.url), "utf8");
  assert.match(css, /@media \(max-width:767px\)[\s\S]*?\.shell-baseline \.msg\{[^}]*border-radius:0[^}]*box-shadow:none/);
  assert.match(css, /@media \(max-width:767px\)[\s\S]*?main\.content-col>\.composer\{[^}]*border-top:2px solid var\(--baseline-line\)/);
  assert.match(css, /@media \(max-width:767px\)[\s\S]*?\.shell-baseline \.thread-head\{[^}]*height:62px[^}]*border-bottom:2px solid var\(--baseline-line\)/);
  assert.match(css, /\.shell-baseline \.tp-link,\.shell-baseline \.tp-close\{width:44px;height:44px/);
});

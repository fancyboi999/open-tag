import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { canSendComposerDraft, messageSendSucceeded } from "../web/src/views/Composer.tsx";

test("composer sends only text or a fully uploaded attachment queue", () => {
  assert.equal(canSendComposerDraft("", []), false);
  assert.equal(canSendComposerDraft("hello", []), true);
  assert.equal(canSendComposerDraft("", [{ status: "done" }]), true);
  assert.equal(canSendComposerDraft("hello", [{}]), false);
  assert.equal(canSendComposerDraft("hello", [{ status: "uploading" }]), false);
  assert.equal(canSendComposerDraft("hello", [{ status: "error" }]), false);
  assert.equal(canSendComposerDraft("hello", [{ status: "unknown" }]), false);
  assert.equal(canSendComposerDraft("hello", [{ status: "done" }, { status: "uploading" }]), false);
  assert.equal(canSendComposerDraft("hello", [{ status: "done" }, { status: "error" }]), false);
});

test("composer wires the readiness decision before clearing its draft", () => {
  const src = fs.readFileSync(new URL("../web/src/views/Composer.tsx", import.meta.url), "utf8");
  const guard = src.indexOf("if (!canSend) return;");
  const effects = [src.indexOf('setText("")'), src.indexOf("setPendingAtts([])"), src.indexOf('api("POST", "/api/messages"')];
  assert.ok(guard >= 0 && effects.every((i) => i > guard), "the send guard must run before clearing or posting the draft");
  assert.match(src, /disabled=\{!canSend\}/, "the button must expose the same readiness rule");
  assert.match(src, /const ids = pendingAtts\.map\(\(a\) => a\.id\)/, "a ready queue must be attached in full");
  assert.match(src, /catch \{ setPendingAtts\(\(p\) => p\.map\(\(x\) => \(x\.id === tmpId \? \{ \.\.\.x, status: "error" \} : x\)\)\); \}/, "a failed upload must remain visible");
  assert.match(src, /setPendingAtts\(\(p\) => p\.filter\(\(x\) => x\.id !== a\.id\)\)/, "the user must be able to remove a blocked row explicitly");
});

test("composer only clears a draft after the message API confirms success", () => {
  assert.equal(messageSendSucceeded({ ok: true }), true);
  assert.equal(messageSendSucceeded({ ok: false, error: "forbidden" }), false);
  assert.equal(messageSendSucceeded({ error: "offline" }), false);
  assert.equal(messageSendSucceeded(null), false);

  const src = fs.readFileSync(new URL("../web/src/views/Composer.tsx", import.meta.url), "utf8");
  const post = src.indexOf('await api("POST", "/api/messages"');
  const clearText = src.indexOf('setText("")', post);
  assert.ok(post >= 0 && clearText > post, "draft clearing must happen after the message response succeeds");
  assert.match(src, /setSendError\(true\)/, "a failed send must expose a retryable error state");
  assert.match(src, /ref=\{retryRef\}[^>]*onClick=\{\(\) => send\(\)\}/, "retry must submit the preserved draft");
  assert.match(src, /disabled=\{sending\}/, "the composer input must expose the submitting state");
});

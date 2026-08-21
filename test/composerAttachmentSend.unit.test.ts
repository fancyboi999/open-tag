import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { canSendComposerDraft } from "../web/src/views/Composer.tsx";

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
  const guard = src.indexOf("if (!canSend || sendingRef.current) return;");
  const claim = src.indexOf("sendingRef.current = true;");
  const effects = [src.indexOf('setText("")'), src.indexOf("setPendingAtts([])"), src.indexOf('api("POST", "/api/messages"')];
  assert.ok(guard >= 0 && claim > guard && effects.every((i) => i > claim), "the send lock must be claimed before clearing or posting the draft");
  assert.match(src, /const canSend = !!channelId && !sending && canSendComposerDraft/, "the rendered send state must stay disabled in flight");
  assert.match(src, /finally \{\s*sendingRef\.current = false; setSending\(false\);/, "the send lock must release after the request settles");
  assert.match(src, /disabled=\{!canSend\}/, "the button must expose the same readiness rule");
  assert.match(src, /const ids = pendingAtts\.map\(\(a\) => a\.id\)/, "a ready queue must be attached in full");
  assert.match(src, /catch \{ setPendingAtts\(\(p\) => p\.map\(\(x\) => \(x\.id === tmpId \? \{ \.\.\.x, status: "error" \} : x\)\)\); \}/, "a failed upload must remain visible");
  assert.match(src, /setPendingAtts\(\(p\) => p\.filter\(\(x\) => x\.id !== a\.id\)\)/, "the user must be able to remove a blocked row explicitly");
});

test("composer locks draft changes while a send is in flight", () => {
  const src = fs.readFileSync(new URL("../web/src/views/Composer.tsx", import.meta.url), "utf8");
  assert.match(src, /if \(!arr\.length \|\| !channelId \|\| sendingRef\.current\) return;/, "new uploads must be rejected while sending");
  assert.match(src, /setSending\(true\); setAtQuery\(null\);/, "starting a send must close the mention menu");
  assert.match(src, /const pick = \(c: \{ name: string \}\) => \{\s*if \(sendingRef\.current\) return;/, "mention picks must not mutate an in-flight draft");
  assert.match(src, /aria-selected=\{i === atSel\} disabled=\{sending\}/, "mention choices must be disabled while sending");
  assert.match(src, /onPaste=\{onPaste\} readOnly=\{sending\}/, "the text draft must be read-only while sending");
  assert.equal(src.match(/disabled=\{uploading \|\| sending\}/g)?.length, 2, "both upload controls must be disabled while sending");
  assert.match(src, /checked=\{asTask\} disabled=\{sending\}/, "task mode must be disabled while sending");
  assert.match(src, /<button disabled=\{sending\} onClick=\{\(\) => setPendingAtts/, "attachment removal must be disabled while sending");
});

test("composer reports API and network send failures", () => {
  const src = fs.readFileSync(new URL("../web/src/views/Composer.tsx", import.meta.url), "utf8");
  const request = src.indexOf('const result = await api("POST", "/api/messages"');
  const failed = src.indexOf("if (result?.ok !== true) { reportSendFailure(result?.error); return; }");
  assert.ok(request >= 0 && failed > request, "the parsed API response must be checked after the request");
  assert.match(src, /catch \(error\) \{\s*reportSendFailure\(error\);/, "network failures must surface through the same reporter");
  assert.match(src, /setSendError\(reason\)/, "the reporter must expose a localized inline retry state");
  assert.match(src, /ref=\{retryRef\}[^>]*onClick=\{\(\) => send\(\)\}/, "retry must submit the preserved draft");
  assert.match(src, /requestAnimationFrame\(\(\) => retryRef\.current\?\.focus\(\)\)/, "failure must focus the retry action");
});

test("composer preserves content until the message request succeeds", () => {
  const src = fs.readFileSync(new URL("../web/src/views/Composer.tsx", import.meta.url), "utf8");
  const failed = src.indexOf("if (result?.ok !== true) { reportSendFailure(result?.error); return; }");
  const clearText = src.indexOf('setText("")');
  const clearAttachments = src.indexOf("setPendingAtts([])");
  assert.ok(clearText > failed && clearAttachments > failed, "composer content must clear only after confirmed success");
});

test("composer retains shortcut-forced task mode after failure", () => {
  const src = fs.readFileSync(new URL("../web/src/views/Composer.tsx", import.meta.url), "utf8");
  const forcedTask = src.indexOf("if (asT && !asTask) setAsTask(true);");
  const request = src.indexOf('const result = await api("POST", "/api/messages"');
  const confirmed = src.indexOf("if (result?.ok !== true)");
  const clearTask = src.indexOf("setAsTask(false)");
  assert.ok(forcedTask >= 0 && forcedTask < request, "a shortcut-forced task must be recorded before the request");
  assert.ok(clearTask > confirmed, "submitted task mode must clear only after confirmed success");
});

test("composer send failures have generic and detailed localized feedback", () => {
  const src = fs.readFileSync(new URL("../web/src/views/Composer.tsx", import.meta.url), "utf8");
  const en = JSON.parse(fs.readFileSync(new URL("../web/src/locales/en.json", import.meta.url), "utf8"));
  const zh = JSON.parse(fs.readFileSync(new URL("../web/src/locales/zh.json", import.meta.url), "utf8"));
  assert.equal(en.chat.sendFailed, "Could not send message");
  assert.equal(en.chat.sendFailedReason, "Could not send message: {{error}}");
  assert.equal(zh.chat.sendFailed, "消息发送失败");
  assert.equal(zh.chat.sendFailedReason, "消息发送失败：{{error}}");
  assert.match(src, /sendError \? t\("chat\.sendFailedReason", \{ error: sendError \}\) : t\("chat\.sendFailed"\)/);
});

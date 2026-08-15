import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../web/src/views/Members.tsx", import.meta.url), "utf8");
const en = JSON.parse(fs.readFileSync(new URL("../web/src/locales/en.json", import.meta.url), "utf8"));
const zh = JSON.parse(fs.readFileSync(new URL("../web/src/locales/zh.json", import.meta.url), "utf8"));

const start = src.indexOf("function PermissionsTab");
const end = src.indexOf("function AppsTab", start);
assert.ok(start >= 0 && end > start, "PermissionsTab implementation must exist");
const permissions = src.slice(start, end);

test("agent permission saves reject API failures before showing Saved", () => {
  const saveStart = permissions.indexOf("const save = async");
  const saveEnd = permissions.indexOf("const groups", saveStart);
  assert.ok(saveStart >= 0 && saveEnd > saveStart, "permission save implementation must exist");
  const save = permissions.slice(saveStart, saveEnd);

  const requestAt = save.indexOf('await api("PUT"');
  const responseGuard = /if\s*\(\s*[A-Za-z_$][\w$]*\?\.error\b/.exec(save);
  const responseGuardAt = responseGuard?.index ?? -1;
  const agentAt = save.indexOf("?.agentId !== id", responseGuardAt);
  const modeAt = save.indexOf('?.mode !== "custom"', responseGuardAt);
  const revisionAt = save.indexOf("Number.isInteger(", responseGuardAt);
  const grantedArrayAt = save.indexOf("Array.isArray(", responseGuardAt);
  const grantedStringsAt = save.indexOf('typeof scope === "string"', responseGuardAt);
  const successDataAt = save.indexOf("setData(", requestAt);
  const successGrantedAt = save.indexOf("setGranted(", requestAt);
  const successSavedAt = save.indexOf("setSaved(true)", requestAt);
  const catchAt = save.indexOf("catch", successSavedAt);
  const failureAt = save.indexOf('toast.error(t("members.permissionsSaveFailed"))', catchAt);
  const finallyAt = save.indexOf("finally", failureAt);

  assert.ok(
    requestAt >= 0 && responseGuardAt > requestAt && successDataAt > responseGuardAt
      && successGrantedAt > responseGuardAt && successSavedAt > responseGuardAt,
    "a resolved permission API error must be rejected before response state is adopted or Saved is shown",
  );
  assert.ok(
    agentAt > responseGuardAt && modeAt > responseGuardAt && revisionAt > responseGuardAt
      && grantedArrayAt > responseGuardAt && grantedStringsAt > responseGuardAt
      && successDataAt > agentAt && successDataAt > modeAt && successDataAt > revisionAt
      && successDataAt > grantedArrayAt && successDataAt > grantedStringsAt,
    "only the real agent scope success envelope may be adopted",
  );
  assert.ok(
    catchAt > successSavedAt && failureAt > catchAt && finallyAt > failureAt,
    "rejected requests and resolved API errors must share visible failure feedback",
  );
  const catchBody = save.slice(catchAt, finallyAt);
  assert.doesNotMatch(
    catchBody,
    /set(?:Data|Granted)\(|setSaved\(true\)/,
    "the failure path must not commit response state or Saved",
  );
  assert.equal(en.members.permissionsSaveFailed, "Couldn't save agent permissions. Try again.");
  assert.equal(zh.members.permissionsSaveFailed, "保存 agent 权限失败，请重试。");
});

test("agent permission saves are single-flight and always release their gate", () => {
  assert.match(permissions, /const \[saving, setSaving\] = useState\(false\)/);
  assert.match(permissions, /const savingRef = useRef\(false\)/);

  const saveStart = permissions.indexOf("const save = async");
  const saveEnd = permissions.indexOf("const groups", saveStart);
  const save = permissions.slice(saveStart, saveEnd);
  const guardAt = save.search(/if\s*\(\s*!canManage\s*\|\|\s*savingRef\.current\s*\)\s*return/);
  const acquireRefAt = save.indexOf("savingRef.current = true");
  const acquireUiAt = save.indexOf("setSaving(true)");
  const clearSavedAt = save.indexOf("setSaved(false)");
  const requestAt = save.indexOf('await api("PUT"');
  const finallyAt = save.indexOf("finally", requestAt);
  const releaseRefAt = save.indexOf("savingRef.current = false", finallyAt);
  const releaseUiAt = save.indexOf("setSaving(false)", finallyAt);

  assert.ok(
    guardAt >= 0 && acquireRefAt > guardAt && acquireUiAt > guardAt
      && clearSavedAt > guardAt && requestAt > acquireRefAt
      && requestAt > acquireUiAt && requestAt > clearSavedAt,
    "save must synchronously acquire one shared gate before issuing the PUT",
  );
  assert.ok(
    finallyAt > requestAt && releaseRefAt > finallyAt && releaseUiAt > finallyAt,
    "success and failure must both release the save gate",
  );
});

test("members without manageAgents can inspect but cannot edit agent permissions", () => {
  assert.match(permissions, /const\s*\{[^}]*\bcapabilities\b[^}]*\}\s*=\s*useStore\(\)/);
  assert.match(permissions, /const canManage\s*=\s*!!capabilities\.manageAgents/);
  assert.match(
    permissions,
    /\{canManage\s*&&\s*<>[\s\S]*t\("members\.grantAll"\)[\s\S]*t\("members\.save"\)[\s\S]*<\/\>\}/,
    "Grant all and Save must only render for members who can manage agents",
  );

  const grantLabelAt = permissions.indexOf('{t("members.grantAll")}');
  const grantButtonAt = permissions.lastIndexOf("<button", grantLabelAt);
  const saveLabelAt = permissions.indexOf('{t("members.save")}', grantLabelAt);
  const saveButtonAt = permissions.lastIndexOf("<button", saveLabelAt);
  assert.ok(grantButtonAt >= 0 && saveButtonAt > grantButtonAt);
  assert.match(permissions.slice(grantButtonAt, grantLabelAt), /disabled=\{saving\}/);
  assert.match(permissions.slice(saveButtonAt, saveLabelAt), /disabled=\{saving\}/);
  assert.match(
    permissions,
    /<input\s+type="checkbox"[^>]*disabled=\{!canManage\s*\|\|\s*saving\}/,
    "read-only members and in-flight saves must not be able to change local checkbox state",
  );
});

// Unit regressions for human-auth error UX.
// Run: npx tsx --test --test-force-exit test/authUx.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const routeSrc = fs.readFileSync(new URL("../src/server/routes-api/auth.ts", import.meta.url), "utf8");
const authSrc = fs.readFileSync(new URL("../web/src/views/Auth.tsx", import.meta.url), "utf8");
const en = JSON.parse(fs.readFileSync(new URL("../web/src/locales/en.json", import.meta.url), "utf8"));
const zh = JSON.parse(fs.readFileSync(new URL("../web/src/locales/zh.json", import.meta.url), "utf8"));

test("login distinguishes unknown email from wrong password with stable error codes", () => {
  assert.match(routeSrc, /auth_login_email_not_found/);
  assert.match(routeSrc, /auth_login_password_wrong/);
  assert.match(routeSrc, /!b\.email\.trim\(\)/);
  assert.match(routeSrc, /!b\.password\.trim\(\)/);
  assert.match(
    routeSrc,
    /sendErr\(\s*res,\s*404,\s*"email not found",\s*\{\s*code:\s*"auth_login_email_not_found"/,
    "unknown login email should return a stable code the UI can map to an actionable message",
  );
  assert.match(
    routeSrc,
    /sendErr\(\s*res,\s*401,\s*"password incorrect",\s*\{\s*code:\s*"auth_login_password_wrong"/,
    "wrong password should return a different stable code from unknown email",
  );
});

test("registration conflicts expose stable codes for email and username collisions", () => {
  assert.match(routeSrc, /auth_register_email_taken/);
  assert.match(routeSrc, /auth_register_username_taken/);
  assert.match(routeSrc, /code:\s*dup\.email === b\.email \? "auth_register_email_taken" : "auth_register_username_taken"/);
});

test("Auth page maps backend error codes to localized actionable copy", () => {
  assert.match(authSrc, /authErrorMessage/);
  assert.match(authSrc, /data\?\.code/);
  assert.match(authSrc, /auth\.errors\./);

  assert.equal(en.auth.errors.auth_login_email_not_found, "No account uses that email yet. Check the address, or create an account.");
  assert.equal(en.auth.errors.auth_login_password_wrong, "That password is not right for this email. Try again, or reset it with your admin.");
  assert.equal(en.auth.errors.auth_register_email_taken, "That email already has an account. Sign in instead.");
  assert.equal(en.auth.errors.auth_register_username_taken, "That username is taken. Choose another @mention name.");

  assert.equal(zh.auth.errors.auth_login_email_not_found, "这个邮箱还没有账号。确认邮箱是否输入正确，或先注册。");
  assert.equal(zh.auth.errors.auth_login_password_wrong, "这个邮箱对应的密码不对。请重试，或联系管理员重置。");
  assert.equal(zh.auth.errors.auth_register_email_taken, "这个邮箱已注册。请直接登录。");
  assert.equal(zh.auth.errors.auth_register_username_taken, "这个用户名已被占用。换一个 @ 提及名。");
});

test("Auth form errors are announced and tied to fields", () => {
  assert.match(authSrc, /role="alert"/);
  assert.match(authSrc, /aria-live="polite"/);
  assert.match(authSrc, /const describedBy = err \? "auth-error" : undefined/);
  assert.match(authSrc, /aria-describedby=\{describedBy\}/);
  assert.match(authSrc, /<label[^>]*htmlFor="auth-email"/);
  assert.match(authSrc, /<label[^>]*htmlFor="auth-password"/);
  assert.match(authSrc, /id="auth-email"[\s\S]*?required/);
  assert.match(authSrc, /id="auth-password"[\s\S]*?required/);
  assert.match(authSrc, /<form[^>]*className="auth-form"/);
  assert.match(authSrc, /onSubmit=\{submit/);
  assert.match(authSrc, /type="submit"/);
  assert.match(authSrc, /nativeEvent\.isComposing/);
  assert.doesNotMatch(authSrc, /onSubmit\(\)/, "password Enter handling must not bypass native form validation");
});

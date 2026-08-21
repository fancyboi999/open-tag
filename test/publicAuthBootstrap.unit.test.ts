import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const auth = fs.readFileSync(new URL("../web/src/views/Auth.tsx", import.meta.url), "utf8");
const baseline = fs.readFileSync(new URL("../web/src/baselineShell.css", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../web/src/main.tsx", import.meta.url), "utf8");
const store = fs.readFileSync(new URL("../web/src/store.tsx", import.meta.url), "utf8");
const skeleton = fs.readFileSync(new URL("../web/src/views/Skeleton.tsx", import.meta.url), "utf8");

test("public auth styling is Preview-gated and keeps Classic as the fallback", () => {
  assert.match(auth, /shellMode === "baseline" \? " auth-baseline" : ""/);
  assert.match(baseline, /\.auth-page\.auth-baseline/);
  assert.doesNotMatch(baseline, /(^|[,{])\s*\.auth-page\s*[{,]/m);
});

test("invite discovery distinguishes transport failure from a real invalid invite", () => {
  assert.match(auth, /infoState.*"loading" \| "ready" \| "error"/);
  assert.match(auth, /!response\.ok \|\| !data \|\| typeof data\.valid !== "boolean"/);
  assert.match(auth, /infoState === "error"[\s\S]*?role="alert"[\s\S]*?loadInfo/);
  assert.match(auth, /!info\?\.valid[\s\S]*?invalidInvite/);
});

test("auth and invite controls preserve native keyboard form behavior", () => {
  assert.match(auth, /<form className="auth-form" onSubmit=/);
  assert.match(auth, /className="auth-link" type="button"/);
  assert.match(auth, /className="auth-brand" href="\/" aria-label="open-tag home"/);
  assert.match(baseline, /min-height:48px/);
});

test("protected routes keep bootstrap ahead of the workspace shell", () => {
  assert.match(main, /if \(!ready \|\| \(known && server !== slug\)\) return <WorkspaceSkeleton/);
  assert.match(main, /if \(authState !== "authed"\) return <Navigate to="\/login" replace/);
});

test("bootstrap transport failures settle into a retryable state instead of an infinite skeleton", () => {
  assert.match(store, /bootstrapState.*"loading" \| "ready" \| "error"/);
  assert.match(store, /catch \{\s*if \(!cancelled\) \{ setBootstrapState\("error"\); setReady\(true\); \}/);
  assert.match(store, /try \{ await reload\(\); \}\s*catch \{ if \(!cancelled\) \{ setBootstrapState\("error"\); setReady\(true\); \}/);
  assert.match(main, /bootstrapState === "error"[\s\S]*?<BootstrapFailure onRetry=\{retryBootstrap\}/);
  assert.match(skeleton, /className="bootstrap-failure" role="alert"[\s\S]*?onClick=\{onRetry\}/);
});

test("a transient identity failure preserves the stored session token", () => {
  assert.match(store, /meResponse\.status === 401 \|\| meResponse\.status === 403/);
  assert.match(store, /only a confirmed auth rejection may discard the session/);
  assert.doesNotMatch(store, /if \(meRes\?\.id\)[^\n]+\n\s*else localStorage\.removeItem/);
});

test("public Raft styling is resolved from the shell and fails closed during prerender", () => {
  assert.match(auth, /shellMode === "baseline" \? " auth-baseline" : ""/);
  const landing = fs.readFileSync(new URL("../web/src/views/Landing.tsx", import.meta.url), "utf8");
  const features = fs.readFileSync(new URL("../web/src/views/Features.tsx", import.meta.url), "utf8");
  assert.match(landing, /useOptionalAppShell\(\)\?\.mode \?\? "classic"/);
  assert.match(landing, /shellMode === "baseline" \? " lp-baseline" : ""/);
  assert.match(features, /shellMode === "baseline" \? " lp-baseline" : ""/);
});

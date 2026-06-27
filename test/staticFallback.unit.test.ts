// Production log regression: crawler/security-probe paths like /.git/config and
// /js/twint_ch.js were served the SPA app shell with HTTP 200. Only real client
// routes should fall back to index.html; unknown file/probe paths must be 404.
//
// Run: npx tsx --test --test-force-exit test/staticFallback.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { shouldServeAppShell } from "../src/server/staticRoutes.ts";

test("serves the app shell for real client-side routes", () => {
  for (const pathname of [
    "/",
    "/features",
    "/features/",
    "/login",
    "/login/",
    "/register",
    "/register/",
    "/join/invite-token",
    "/s/open-tag",
    "/s/open-tag/channel",
    "/s/open-tag/agent/123",
  ]) {
    assert.equal(shouldServeAppShell(pathname), true, pathname);
  }
});

test("does not serve the app shell for unknown file or scanner paths", () => {
  for (const pathname of [
    "/.git/config",
    "/js/twint_ch.js",
    "/assets/js/auth.js",
    "/wp-admin",
    "/wordpress/",
    "/old/",
    "/favicon.ico",
  ]) {
    assert.equal(shouldServeAppShell(pathname), false, pathname);
  }
});

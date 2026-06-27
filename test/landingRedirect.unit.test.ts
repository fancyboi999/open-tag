// Regression: the public "/" route must never paint the marketing Landing for a user who has
// (or is resolving) a session — every other route gates on the auth bootstrap, "/" did not, so a
// logged-in visitor who refreshed/opened "/" was stranded on the marketing page (and a naive
// redirect would have flashed it for ~1s first). These tests pin the pure routing decisions that
// the "/" guard (main.tsx) and the store's initial auth state (store.tsx) are built on.
// Run: npx tsx --test --test-force-exit test/landingRedirect.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { initialAuthState, homeRoute } from "../web/src/routing.ts";

test("initialAuthState: a true anonymous visitor (no token, no ?as=) is known anon synchronously", () => {
  // Known-anon on the very first render is what lets "/" paint Landing with no skeleton flash.
  assert.equal(initialAuthState({ hasToken: false, hasAsParam: false }), "anon");
});

test("initialAuthState: a stored session token defers to loading until the async bootstrap resolves", () => {
  assert.equal(initialAuthState({ hasToken: true, hasAsParam: false }), "loading");
});

test("initialAuthState: an in-flight ?as= dev-login defers to loading (so it never flashes Landing)", () => {
  assert.equal(initialAuthState({ hasToken: false, hasAsParam: true }), "loading");
});

test("homeRoute: anonymous visitor gets the marketing Landing immediately (ready or not)", () => {
  assert.equal(homeRoute({ authState: "anon", ready: false }), "landing");
  assert.equal(homeRoute({ authState: "anon", ready: true }), "landing");
});

test("homeRoute: while a session is still bootstrapping, show the skeleton — never the marketing page", () => {
  assert.equal(homeRoute({ authState: "loading", ready: false }), "skeleton");
});

test("homeRoute: authed-but-not-yet-activated window also shows skeleton (the flash-prone gap)", () => {
  // authState flips to "authed" before the workspace finishes activating (ready=true). This is the
  // exact window a naive guard would paint Landing in. It must be a skeleton, not Landing.
  assert.equal(homeRoute({ authState: "authed", ready: false }), "skeleton");
});

test("homeRoute: a fully-bootstrapped authed user is redirected to their workspace (not Landing)", () => {
  assert.equal(homeRoute({ authState: "authed", ready: true }), "redirect");
});

test("homeRoute: a token that proved invalid (authState settles to anon) falls back to Landing", () => {
  assert.equal(homeRoute({ authState: "anon", ready: true }), "landing");
});

test("homeRoute: a (defensively-handled, normally unreachable) ready+loading state falls back to Landing", () => {
  // The store flips authState and ready together, so ready=true is never observed while still "loading";
  // pin the total function's behavior anyway so the decision table is exhaustively covered.
  assert.equal(homeRoute({ authState: "loading", ready: true }), "landing");
});

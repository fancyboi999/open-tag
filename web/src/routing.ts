// Pure auth-bootstrap routing decisions, kept free of React/DOM so they can be unit-tested
// without a browser. Consumed by store.tsx (the store's initial auth state) and main.tsx
// (the public "/" guard). The invariant they encode: the marketing Landing must never paint
// for a user who has — or is still resolving — a session; every route waits on the bootstrap.
export type AuthState = "loading" | "authed" | "anon";

export const TOKEN_KEY = "open-tag.token"; // session JWT persisted after register/login/dev-login

// Synchronous best-effort read of "does this visitor have (or is starting) a session?", from the
// same storage key the store uses + the dev-login ?as= param. Used only to pick the FIRST-render
// auth state; the async bootstrap in store.tsx is still the source of truth.
export function readSessionHints(): { hasToken: boolean; hasAsParam: boolean } {
  if (typeof window === "undefined") return { hasToken: false, hasAsParam: false };
  let hasToken = false;
  try { hasToken = !!window.localStorage?.getItem(TOKEN_KEY); } catch { /* storage blocked */ }
  let hasAsParam = false;
  try { hasAsParam = new URLSearchParams(window.location.search).has("as"); } catch { /* no search */ }
  return { hasToken, hasAsParam };
}

// Initial human-auth state on first render. A true anonymous visitor (no token, no in-flight
// dev-login) is known "anon" immediately, so "/" can paint Landing with zero skeleton/Landing
// flash; anything that could become a session defers to "loading" until the bootstrap resolves it.
export function initialAuthState(hints?: { hasToken: boolean; hasAsParam: boolean }): AuthState {
  const h = hints ?? readSessionHints();
  return h.hasToken || h.hasAsParam ? "loading" : "anon";
}

// The public "/" (home) route decision:
//   - "landing"  → render the marketing page (anonymous visitors, or a token that proved invalid)
//   - "skeleton" → a session is bootstrapping/activating; show the workspace skeleton, NOT Landing
//   - "redirect" → a fully-resolved session belongs in its workspace, not on the marketing page
// The skeleton branch deliberately covers BOTH "loading" and the "authed-but-not-yet-ready"
// activation window — the gap a naive guard would flash the marketing page in.
export type HomeView = "landing" | "skeleton" | "redirect";
export function homeRoute(s: { authState: AuthState; ready: boolean }): HomeView {
  if (s.authState === "anon") return "landing";       // known anonymous → marketing page, no wait
  if (!s.ready) return "skeleton";                    // session resolving (loading or activating) → skeleton
  // settled (ready=true): authed → workspace. The else is normally "anon" (token proved invalid); a lingering
  // "loading" here is unreachable (store flips authState+ready together) but defensively falls to Landing too.
  return s.authState === "authed" ? "redirect" : "landing";
}

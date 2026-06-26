// SSR entry — used only at build time by scripts/prerender.js to generate a
// static HTML snapshot of the landing page for crawlers.
// NOT imported by the SPA at runtime; the client builds this separately.
import React from "react";
import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { StoreProvider } from "./store.tsx";
import { Landing } from "./views/Landing.tsx";

// HeroTitle guards `typeof window !== "undefined"` before calling matchMedia.
// Provide a minimal mock so the guard passes and `matches: false` (no
// reduced-motion shortcut) so the full title text lands in the aria-label,
// which is what crawlers read.
if (typeof globalThis.window === "undefined") {
  (globalThis as any).window = { matchMedia: () => ({ matches: false }) };
}

export function renderLanding(): string {
  return renderToString(
    <StaticRouter location="/">
      <StoreProvider>
        <Landing />
      </StoreProvider>
    </StaticRouter>
  );
}

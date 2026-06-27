// Unit contract for the public marketing/docs navigation.
// Run: npx tsx --test --test-force-exit test/publicNavContract.unit.test.ts
//
// The public surfaces (/ landing, /features, /docs/) must not each hand-maintain
// their own brand mark and top-level links. The React pages share a MarketingNav
// component, and the Astro docs page imports the same public-nav contract.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const navContract = fs.readFileSync(new URL("../web/src/landing/publicNav.ts", import.meta.url), "utf8");
const marketingNav = fs.readFileSync(new URL("../web/src/landing/MarketingNav.tsx", import.meta.url), "utf8");
const landing = fs.readFileSync(new URL("../web/src/views/Landing.tsx", import.meta.url), "utf8");
const features = fs.readFileSync(new URL("../web/src/views/Features.tsx", import.meta.url), "utf8");
const docs = fs.readFileSync(new URL("../docs-site/src/pages/index.astro", import.meta.url), "utf8");
const publicNavCss = fs.readFileSync(new URL("../web/src/landing/publicNav.css", import.meta.url), "utf8");
const landingCss = fs.readFileSync(new URL("../web/src/landing/landing.css", import.meta.url), "utf8");
const docsCss = fs.readFileSync(new URL("../docs-site/src/styles/docs.css", import.meta.url), "utf8");

test("public nav source of truth exports the shared brand asset and top-level links", () => {
  assert.match(navContract, /PUBLIC_BRAND_MARK_SRC\s*=\s*"\/favicon\.svg"/);
  assert.match(navContract, /GITHUB_URL\s*=\s*"https:\/\/github\.com\/fancyboi999\/open-tag"/);
  for (const key of ["features", "capabilities", "engines", "selfHosted", "docs"]) {
    assert.match(navContract, new RegExp(`key:\\s*"${key}"`), `missing shared nav key ${key}`);
  }
});

test("landing and features render the shared MarketingNav instead of hand-written nav markup", () => {
  assert.match(marketingNav, /PUBLIC_NAV_LINKS/);
  assert.match(marketingNav, /PUBLIC_BRAND_MARK_SRC/);
  assert.match(marketingNav, /className="lp-brand-mark"/);
  assert.match(marketingNav, /export function PublicBrand/);

  assert.match(landing, /<MarketingNav[\s\S]*variant="landing"/);
  assert.match(landing, /<PublicBrand/);
  assert.doesNotMatch(landing, /<header className="lp-nav">/);
  assert.doesNotMatch(landing, /open<b>-tag<\/b>/);

  assert.match(features, /<MarketingNav[\s\S]*variant="features"/);
  assert.doesNotMatch(features, /<header className="lp-nav">/);
});

test("docs imports the shared public nav contract and renders the shared public-nav visual classes", () => {
  assert.match(docs, /PUBLIC_NAV_LINKS/);
  assert.match(docs, /PUBLIC_BRAND_MARK_SRC/);
  assert.match(docs, /from\s+"..\/..\/..\/web\/src\/landing\/publicNav"/);
  assert.match(docs, /src=\{PUBLIC_BRAND_MARK_SRC\}/);
  assert.match(docs, /<header class="lp-nav">/);
  assert.match(docs, /<div class="lp-container lp-nav__inner">/);
  assert.match(docs, /class="lp-brand"/);
  assert.match(docs, /class="lp-brand-mark"/);
  assert.match(docs, /class="lp-brand-word">open<b>-tag<\/b><\/span>/);
  assert.match(docs, /class="lp-nav__links"/);
  assert.match(docs, /class="lp-nav__cta"/);
  assert.match(docs, /class="lp-btn lp-btn--ghost lp-btn--sm"/);
  assert.match(docs, /class="lp-btn lp-btn--primary lp-btn--sm"/);
  assert.doesNotMatch(docs, /src="\.\/favicon\.svg"/);
  assert.doesNotMatch(docs, /class="topbar/);
  assert.doesNotMatch(docs, /class="brand"/);
  assert.doesNotMatch(docs, /class="brand-word"/);
  assert.doesNotMatch(docs, /class="outline/);
});

test("marketing and docs headers use the same visual contract", () => {
  assert.match(landingCss, /@import "\.\/publicNav\.css"/);
  assert.match(docsCss, /@import "..\/..\/..\/web\/src\/landing\/publicNav\.css"/);

  assert.match(publicNavCss, /\.lp-nav__inner\s*\{[^}]*height:\s*var\(--lp-public-nav-height\)/s);
  assert.match(publicNavCss, /\.lp-brand-mark\s*\{[^}]*width:\s*34px;[^}]*height:\s*34px/s);
  assert.match(publicNavCss, /\.lp-brand\s*\{[^}]*font-family:\s*var\(--lp-font-display\);[^}]*font-size:\s*24px;[^}]*letter-spacing:\s*-0\.01em/s);
  assert.match(publicNavCss, /\.lp-brand-word\s*\{[^}]*transform:\s*translateY\(-1px\)/s);
  assert.match(publicNavCss, /\.lp-brand b\s*\{[^}]*font-weight:\s*500/s);
  assert.match(publicNavCss, /\.lp-nav__links\s*\{[^}]*gap:\s*var\(--lp-space-8\)/s);
  assert.match(publicNavCss, /\.lp-btn--sm\s*\{[^}]*padding:\s*9px 18px;[^}]*font-size:\s*var\(--lp-text-sm\)/s);

  assert.match(docsCss, /--lp-public-nav-height:\s*64px/);
  assert.doesNotMatch(docsCss, /\.topbar\b/);
  assert.doesNotMatch(docsCss, /\.brand-word\b/);
  assert.doesNotMatch(docsCss, /\.pill\b/);
  assert.doesNotMatch(docsCss, /\.outline\b/);
});

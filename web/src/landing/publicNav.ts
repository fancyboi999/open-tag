export const GITHUB_URL = "https://github.com/fancyboi999/open-tag";
export const MARKETING_SITE_URL = "https://getopentag.com";
export const DOCS_SITE_URL = "https://docs.getopentag.com/";
export const PUBLIC_BRAND_MARK_SRC = "/favicon.svg";

export const MARKETING_ORIGINS = new Set([MARKETING_SITE_URL, "https://www.getopentag.com"]);

export type PublicNavLinkKey = "features" | "capabilities" | "engines" | "selfHosted" | "docs";

export type PublicNavLink = {
  key: PublicNavLinkKey;
  label: string;
  marketingHref: string;
};

export const PUBLIC_NAV_LINKS: PublicNavLink[] = [
  { key: "features", label: "Features", marketingHref: "/features" },
  { key: "capabilities", label: "Capabilities", marketingHref: "/#capabilities" },
  { key: "engines", label: "Engines", marketingHref: "/#engines" },
  { key: "selfHosted", label: "Self-hosted", marketingHref: "/#self-hosted" },
  { key: "docs", label: "Docs", marketingHref: "/docs/" },
];

export function resolveDocsHref(origin = MARKETING_SITE_URL): string {
  return MARKETING_ORIGINS.has(origin) ? DOCS_SITE_URL : `${origin}/docs/`;
}

export function resolveMarketingHomeHref(origin = MARKETING_SITE_URL): string {
  return origin === DOCS_SITE_URL.slice(0, -1) ? `${MARKETING_SITE_URL}/` : `${origin}/`;
}

export function resolvePublicNavHref(link: PublicNavLink, origin = MARKETING_SITE_URL, surface: "marketing" | "docs" = "marketing"): string {
  if (surface === "marketing") return link.key === "docs" ? resolveDocsHref(origin) : link.marketingHref;
  if (link.key === "docs") return "#top";
  const home = resolveMarketingHomeHref(origin);
  return new URL(link.marketingHref, home).toString();
}

import { Link } from "react-router-dom";
import {
  GITHUB_URL,
  PUBLIC_BRAND_MARK_SRC,
  PUBLIC_NAV_LINKS,
  type PublicNavLinkKey,
  resolvePublicNavHref,
} from "./publicNav.ts";

type MarketingNavProps = {
  variant: "landing" | "features";
  labels?: Partial<Record<PublicNavLinkKey, string>>;
  githubLabel?: string;
  enterLabel: string;
  onEnterWorkspace: () => void;
  languageToggle?: {
    label: string;
    text: string;
    onClick: () => void;
  };
};

type PublicBrandProps = {
  href?: string;
  className?: string;
};

function PublicBrandContent() {
  return (
    <>
      <img className="lp-brand-mark" src={PUBLIC_BRAND_MARK_SRC} alt="" width={34} height={34} />
      <span className="lp-brand-word">open<b>-tag</b></span>
    </>
  );
}

function GithubIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.37.5 0 5.78 0 12.29c0 5.21 3.44 9.63 8.21 11.19.6.11.82-.25.82-.56 0-.28-.01-1.02-.02-2-3.34.71-4.04-1.58-4.04-1.58-.55-1.37-1.33-1.74-1.33-1.74-1.09-.73.08-.72.08-.72 1.2.08 1.84 1.21 1.84 1.21 1.07 1.79 2.81 1.27 3.49.97.11-.76.42-1.27.76-1.56-2.67-.3-5.47-1.31-5.47-5.83 0-1.29.47-2.34 1.24-3.17-.13-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.21.96-.26 1.98-.39 3-.4 1.02.01 2.04.14 3 .4 2.29-1.53 3.29-1.21 3.29-1.21.66 1.66.25 2.88.12 3.18.77.83 1.24 1.88 1.24 3.17 0 4.53-2.81 5.53-5.49 5.82.43.37.81 1.1.81 2.22 0 1.6-.01 2.9-.01 3.29 0 .31.21.68.83.56C20.56 21.91 24 17.49 24 12.29 24 5.78 18.63.5 12 .5z"/>
    </svg>
  );
}

export function PublicBrand({ href, className = "" }: PublicBrandProps) {
  const classes = ["lp-brand", className].filter(Boolean).join(" ");
  if (href) return <a className={classes} href={href} aria-label="open-tag home"><PublicBrandContent /></a>;
  return <div className={classes}><PublicBrandContent /></div>;
}

// Shared public-site header for landing and feature pages. Docs imports the same
// publicNav contract from Astro so top-level links and brand assets do not drift.
export function MarketingNav({
  variant,
  labels = {},
  githubLabel = "GitHub",
  enterLabel,
  onEnterWorkspace,
  languageToggle,
}: MarketingNavProps) {
  const origin = typeof window !== "undefined" && window.location?.origin ? window.location.origin : undefined;

  return (
    <header className="lp-nav">
      <div className="lp-container lp-nav__inner">
        {variant === "landing" ? (
          <PublicBrand href="#top" />
        ) : (
          <Link className="lp-brand" to="/" aria-label="open-tag home">
            <PublicBrandContent />
          </Link>
        )}
        <nav className="lp-nav__links" aria-label="Main navigation">
          {PUBLIC_NAV_LINKS.map((link) => (
            <a key={link.key} href={resolvePublicNavHref(link, origin, "marketing")}>
              {labels[link.key] ?? link.label}
            </a>
          ))}
        </nav>
        <div className="lp-nav__cta">
          {languageToggle && (
            <button className="lp-btn lp-btn--ghost lp-btn--sm" type="button" onClick={languageToggle.onClick} aria-label={languageToggle.label}>
              {languageToggle.text}
            </button>
          )}
          <a className="lp-btn lp-btn--ghost lp-btn--sm" href={GITHUB_URL} target="_blank" rel="noreferrer">
            <GithubIcon /> {githubLabel}
          </a>
          <button className="lp-btn lp-btn--primary lp-btn--sm" onClick={onEnterWorkspace}>{enterLabel}</button>
        </div>
      </div>
    </header>
  );
}

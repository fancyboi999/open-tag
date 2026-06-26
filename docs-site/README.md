# open-tag docs site

Public one-page documentation site for [open-tag](https://github.com/fancyboi999/open-tag), built with Astro.

The page intentionally avoids a generic docs framework. It uses the warm-editorial visual system from `DESIGN.md` and keeps the first public docs pass focused on one complete path: quickstart, collaboration, agents, machines, self-hosting, runtimes, and the auth model.

The `中文 / English` control switches the whole page, including metadata. Do not add a separate Chinese section. Legacy visits to `/#chinese` are redirected to the top and shown in Chinese so old links do not land mid-page.

## Local development

```bash
npm install
npm run dev
```

Default local URL: `http://localhost:4321`.

## Build

```bash
npm run verify:onepage
npm run build
```

`verify:onepage` checks that the site stays a single custom Astro page, does not reintroduce Starlight, keeps Chinese as a page-level language toggle, and does not bring back the old purple/blue default theme.

## Structure

```text
src/
  pages/index.astro      One-page docs experience
  styles/docs.css        Warm-editorial docs styling
public/
  favicon.svg            Ink/off-white docs favicon
  og.png                 Social card
  workspace.png          Real open-tag workspace screenshot
astro.config.mjs         Astro + sitemap
```

## Source of truth

This site is a public-facing guide. Implementation contracts still live in the repository:

- `README.md` for the main quickstart and runtime status
- `docs/self-host.md` for production deployment details
- `FEATURES.md` for the capability matrix
- `ARCHITECTURE.md` for the system codemap
- `docs/authorization.md` for auth planes, roles, scopes, and invariants

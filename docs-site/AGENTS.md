# docs-site — guide for AI coding agents

## Load-bearing constraint: this site is ONE custom Astro page

`docs-site/` is **deliberately a single custom Astro page** — `src/pages/index.astro` +
`src/styles/docs.css`, styled with the warm-editorial visual system from the repo root
`DESIGN.md`. It is *not* a docs framework:

- **Do not reintroduce Starlight** (it was removed on purpose) or any other docs framework.
- **Do not add content collections, extra pages, or Tailwind.**
- `npm run verify:onepage` (`scripts/verify-onepage.mjs`) enforces this — run it after changes.
- Rationale + content-editing guidance: `docs-site/README.md`.

Deploys to **https://docs.getopentag.com** via GitHub Pages
(`.github/workflows/docs-deploy.yml`, path-filtered to `docs-site/**`); the same build is
served by self-hosted servers at `/docs/` (see `ARCHITECTURE.md` §II). `public/CNAME`
carries the custom domain — don't remove it.

## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Astro documentation

Full documentation: https://docs.astro.build — for this site, only the basics apply:

- [Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Styling](https://docs.astro.build/en/guides/styling/) (plain CSS in `src/styles/docs.css`)

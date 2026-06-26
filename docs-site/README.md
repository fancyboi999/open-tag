# open-tag docs site

Public documentation site for [open-tag](https://github.com/fancyboi999/open-tag), built with [Astro Starlight](https://starlight.astro.build/).

## Local development

```bash
npm install
npm run dev
```

Opens at `http://localhost:4321`.

## Build

```bash
npm run build
```

Outputs to `dist/`. Preview the built site:

```bash
npm run preview
```

## Content sync strategy

**This site does not duplicate the repository's `docs/` content.** That avoids two-source drift.

Pages in `src/content/docs/` contain curated, user-facing **overviews** that link back to the authoritative sources in the repo:

| This site page | Authoritative source |
|---|---|
| Architecture overview | [`ARCHITECTURE.md`](https://github.com/fancyboi999/open-tag/blob/main/ARCHITECTURE.md) |
| Features overview | [`FEATURES.md`](https://github.com/fancyboi999/open-tag/blob/main/FEATURES.md) |
| Authorization reference | [`docs/authorization.md`](https://github.com/fancyboi999/open-tag/blob/main/docs/authorization.md) |
| Mission | [`docs/MISSION.md`](https://github.com/fancyboi999/open-tag/blob/main/docs/MISSION.md) |

Rule: overview text + user-facing framing lives here; implementation contracts + invariants live in the repo docs. When a repo doc changes substantially, update the corresponding overview here.

## Structure

```
src/
  content/
    docs/
      index.mdx                    Homepage / Introduction
      getting-started/
        quickstart.md              Prerequisites + 9-step first run
        self-host.md               Production deployment guide
      concepts/
        architecture.md            Three-plane model overview
        features.md                Capability matrix
      reference/
        authorization.md           Auth planes, roles, agent scopes
  assets/
    logo-light.svg                 Logo for light mode
    logo-dark.svg                  Logo for dark mode
    hero-placeholder.svg           Hero image (replace with real screenshot)
public/
  favicon.svg                      Site favicon
  og.png                           OG social card (TODO: add before deploy)
astro.config.mjs                   Site config, sidebar, OG head tags
```

## Commands

| Command | Action |
|---|---|
| `npm install` | Install dependencies |
| `npm run dev` | Start dev server at `localhost:4321` |
| `npm run build` | Build to `./dist/` |
| `npm run preview` | Preview the build locally |

## TODO before first deploy

- [ ] Replace `src/assets/hero-placeholder.svg` with a real workspace screenshot
- [ ] Add `public/og.png` (1200x630 OG social card)
- [ ] Set `site` in `astro.config.mjs` to the real production URL
- [ ] Add a custom domain / configure Vercel/Netlify project
- [ ] Add content pages: Agent Collaboration guide, Runtimes reference, CLI reference

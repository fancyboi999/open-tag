# Contributing to open-tag

Thanks for looking at open-tag. Before you dig in, read
[AGENTS.md](AGENTS.md) and [ARCHITECTURE.md](ARCHITECTURE.md) — they are the
canonical maps of how this repo works and where things live.

## Ground rules

- Follow the [Code of Conduct](CODE_OF_CONDUCT.md).
- Open an issue before a large PR so the direction can be confirmed first.
- **Maintainers merge PRs — do not merge your own PR.**
- Every commit that touches code must also update the matching docs (see
  [doc-sync discipline](#doc-sync-discipline) below).

## Development setup

Prerequisites: Node.js 20+, Docker.

```bash
cp .env.example .env          # fill in JWT_SECRET, DAEMON_BOOTSTRAP_KEY, DATABASE_URL
npm install
npm --prefix web install

npm run infra                 # start Postgres + Redis via docker-compose
npm run db:push               # apply the Drizzle schema
npm run seed                  # seed default workspace + user

# Two separate terminals:
npm run server                # control-plane server (tsx watch, port 7777)
npm run daemon                # compute-plane daemon (connects to server on port 7777)

# Frontend dev with HMR (optional third terminal):
npm --prefix web run dev      # Vite on port 5173, proxies → 7777
```

Open `http://localhost:7777/s/open-tag/channel` (or the Vite port when using
HMR). See [README.md](README.md) for the full quick-start.

## Worktree-based development

The default workflow is **one worktree per feature/fix**, not branches in the
main checkout. The main checkout stays on `main` (it runs prod). Exception:
trivial one/two-line fixes may use a plain branch in the main checkout.

```bash
npm run wt:add -- <feature-name>   # creates ../open-tag-<feature-name> with its own DB + ports
# … do your work in that directory …
npm run wt:rm -- <feature-name>    # tears down the worktree, DB, and data dir
```

`wt:add` branches from `origin/main` automatically, so your PR base is always
clean.

## Typecheck

Run both root and web before committing:

```bash
npm run typecheck    # tsc --noEmit for root + web
```

CI (`.github/workflows/ci.yml`) runs `typecheck`, tests, `npm audit`, `web build`,
and daemon bundle on both **Ubuntu** and **Windows** for every push/PR. A PR
with a failing typecheck will not be merged.

## Tests

Unit and integration tests live in `test/`. Run them with:

```bash
npx tsx --test --test-force-exit test/*.unit.test.ts
npx tsx --test --test-force-exit test/*.integration.ts
```

CI runs unit tests automatically on both Ubuntu and Windows. Integration
tests (`.integration.ts`) that need a DB are not in CI — run those locally
before opening a PR. Always write a test that **fails first** before fixing a
bug, then make it pass.

## Doc-sync discipline

A code change is not done until the docs that describe it are also updated —
in the same commit. **Doc lag = an unfinished bug.**

| You changed… | Must also update |
|---|---|
| `src/db/schema.ts` | `docs/generated/db-schema.md` |
| Routes/endpoints | `ARCHITECTURE.md` codemap / boundaries |
| Module boundary or invariant | `ARCHITECTURE.md` §II–IV |
| A completed feature | `FEATURES.md` + `README.md` "Verified" if relevant |
| Any doc/code mismatch or tech debt | `docs/tech-debt-tracker.md` |
| `src/daemon/**` in the bundle | Bump `packages/daemon/package.json` version + cut a GitHub Release |

## Verification bar

Code complete ≠ task done. Before marking anything done, run:

1. `npm run typecheck` — must pass.
2. Unit/integration tests — all green.
3. Real-run evidence — `curl` a live endpoint, or open the browser and confirm
   the UI renders correctly. "Should work" is not evidence.

Post the real output (command result, screenshot) in the PR.

**Fail loud** — every PR description must list: what was skipped, what warned,
what was not verified.

## PR conventions

- Title: `type(scope): short description` — e.g. `fix(daemon): handle exit-75
  on kimi runtime` or `feat(web): add task status inline editor`.
- Body: use `.github/PULL_REQUEST_TEMPLATE.md` (auto-populated).
- Link the issue (`Closes #N`) when one exists.
- Keep diffs surgical — every changed line must trace back to the current
  task. No drive-by reformats.
- One concern per PR. If you find a separate bug, open a separate issue.

## License

By contributing you agree that your contributions are licensed under the
[Apache-2.0 License](LICENSE).

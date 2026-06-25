# open-tag — guide for AI coding agents

**open-tag** is an open-source, self-hosted alternative to Claude Tag — a Slack-style
multi-agent workspace where humans and AI agents collaborate as teammates in channels,
threads, and DMs. Agents are persistent teammates with their own memory, running on a
daemon on a machine you control; data stays in your network.

The project's own mission: accumulate memory, keep docs in sync with code, and drive
its own iterative improvement — autonomously.

## This file is a map, not a manual

> Harness engineering principle: **give the agent a map, not a thousand-page handbook**.
> Architecture details, data models, and contracts live in the files this map points to —
> don't pile detail here (it goes stale, bloats context, and can't be mechanically verified).
> When you change the architecture, update `ARCHITECTURE.md`, not this file.

**Read these first (jump as needed):**

- **`docs/MISSION.md`** — North star / working directive: what open-tag is building
  toward; evidence-driven slices, browser-verified. Read before adding any feature.
- **`ARCHITECTURE.md`** — Repository codemap: three planes, what every file does,
  architectural invariants, module boundaries. "Where does X live?" — check here first.
- **`docs/core-beliefs.md`** — Load-bearing project beliefs: `src/` is canonical,
  three-plane auth, credential hygiene, etc. Scan before you touch anything.
- **`docs/authorization.md`** — The authoritative access-control model: three auth planes, role→capability
  + agent scope tables, the four invariants every route must obey (tenant isolation, resource-access checks,
  channel visibility), and the hardening roadmap. Read before touching any route, `resolveAgent`/`resolveTarget`,
  or anything that reads a resource by a client-supplied id. **越权很危险.**
- **`docs/tech-debt-tracker.md`** — Known doc/implementation drift and debt.
- **`docs/generated/db-schema.md`** — Ground truth for the data model (from `src/db/schema.ts`).
- **`docs/PLANS.md`** — Plan conventions + in-progress plans + roadmap index.
- **`README.md`** — How to run + verified evidence of what works.

## Conventions

- TypeScript throughout. Run `npm run typecheck` (root + web) before committing.
- Agent workspace lives at `~/.open-tag/agents/<agent-id>/` with a `MEMORY.md` per agent.

## Parallel development (worktrees)

- **Default workflow: do your work in a worktree, not the main checkout.** Start any
  **feature, multi-file change, or task that needs an isolated stack** (agent runtime,
  realtime, DB) with `npm run wt:add -- <name>`, and open the PR from there. The main
  checkout stays on `main` (it's where prod runs). **Exception — trivial changes**
  (a doc edit, a one/two-line fix) may use a plain branch off `origin/main` in the main
  checkout; use judgment, don't spin up a worktree's whole DB+seed for a typo. A soft,
  non-blocking reminder fires once per session when you edit on `main` in the main checkout
  (`.claude/hooks/worktree-reminder.sh`, wired in `.claude/settings.json`).
- A `SessionStart` hook (`.claude/hooks/pull-main-on-session-start.sh`) keeps the main
  checkout's `main` fresh by **fast-forwarding** it to `origin/main` once per session —
  but only when it's a zero-risk FF: it skips inside a worktree, off `main`, on a dirty
  tree, or when local `main` has diverged. It never merges, rewrites, or touches a feature
  branch. (Deliberately *not* a pull-on-every-edit hook — that would clobber in-progress work.)
- Use `npm run wt:add -- <name>` to spin up an isolated git worktree (its own ports +
  `opentag_<name>` database + redis index + **`OPEN_TAG_HOME=~/.open-tag-<name>` data dir** +
  seeded data); `npm run wt:rm -- <name>` tears it down (and cleans the data dir + db). Lets
  several features (or agents) run side by side without port, database, **or daemon/agent
  workspace** collisions. wt:add branches each worktree from `origin/main` (not your current
  HEAD), so PRs made from it never inherit an unrelated branch — set `WT_BASE=HEAD` to stack
  on the current branch instead. (`vite.config` + `src/env.ts` read `PORT` / `VITE_PORT` /
  `ENV_FILE`; `src/paths.ts` reads `OPEN_TAG_HOME` — so each worktree is fully isolated.)
- Browser verification: check your own web UI with the chrome-devtools MCP. When several
  agents or worktrees run in parallel, start chrome-devtools with `--isolated` so each
  gets its own Chrome instance instead of fighting over a shared one.

### Isolated dev E2E (on demand)

When a task touches the **agent runtime / human↔agent loop / realtime delivery to agents /
agent memory**, verify it in an isolated live stack instead of poking prod or hand-wiring
JWTs:

1. `npm run wt:add -- <task>` — isolated worktree (own DB, ports, redis, data dir).
2. `cd ../open-tag-<task>` and do the work.
3. `npm run dev:e2e:up` — builds web, starts server + daemon (background), seeds a real
   `claude`/`sonnet` `@dev-bot` in `#all`, and prints the dev-login URL
   `http://localhost:$PORT/?as=you` (the server serves the built web, so no separate vite).
4. Verify (browser dev-login → `@dev-bot`, or curl).
5. `npm run dev:e2e:down`, then from the main repo `npm run wt:rm -- <task>`.

This needs the `claude` CLI installed + authenticated (it runs a real agent). If your task
does **not** involve the agent runtime (docs, pure REST, UI-only), skip it — it's wasted
setup otherwise. Decide per task.

## Doc-sync discipline (highest priority: code change = doc change)

> Docs naturally lag behind code. This project treats doc/code sync as a **hard rule**:
> every change must update the corresponding docs in the **same commit**.
> **Doc lag = an unfinished bug.** Self-check with the table below before marking done,
> then run `/doc-sync` (built-in skill at `.claude/skills/doc-sync/`) for a full audit.

| You changed… | Must also update |
|---|---|
| `src/db/schema.ts` (tables / columns) | `docs/generated/db-schema.md` |
| Routes/endpoints (`routes-api` / `routes-agent`), CLI sub-commands, daemon protocol | `ARCHITECTURE.md` codemap / boundaries / contracts |
| Module purpose / boundary / architectural invariant | `ARCHITECTURE.md` §II–IV |
| A feature (completed or modified) | `FEATURES.md` checkbox + `README.md` "Verified" section if relevant |
| Doc/code mismatch, or a TODO / tech debt left behind | `docs/tech-debt-tracker.md` — add an entry, don't let it rot silently |
| A complex change with a plan | `docs/PLANS.md` (convention) |
| `src/daemon/**` that ships in the bundle (runtime / CLI / daemon protocol) | **Publish a new daemon release** — bump `packages/daemon/package.json` + cut a GitHub Release. See **Release discipline** below. **Merged ≠ shipped.** |

> Keep this file in "map" form: details go into their respective files.
> **Don't accumulate history or changelogs here** — that's what `git log` is for.

## Release discipline (the daemon ships as an npm package — merged ≠ shipped)

> Prod / self-host machines run the compute-plane daemon as `npx @fancyboi999/open-tag-daemon`
> — the **published npm package, not this repo's `src/`**. Merging a daemon change to `main`
> does **not** reach those machines until a new package is published; a green CI and synced
> docs can still leave prod running stale code. (This is exactly how #44's `copilot` /
> `opencode` / … runtimes were live in `src/` yet prod reported `no runtime: copilot` — the
> daemon was still on the `0.1.0` package, which was cut *before* #44 merged.)

- **Changed anything under `src/daemon/**` that ships in the bundle (a runtime, the CLI, the
  daemon protocol)?** Bump `packages/daemon/package.json` `version`, then **publish a GitHub
  Release** (`vX.Y.Z`). That — and only that — fires `.github/workflows/publish-daemon.yml`,
  which builds the bundle and publishes to npm via OIDC Trusted Publishing (token-less). A
  plain merge / tag / push publishes nothing. (New runtime → minor bump; bugfix → patch.)
- A long-lived daemon keeps running the **old** bundle until **restarted** — bounce it
  (`npx @fancyboi999/open-tag-daemon@latest`) on each prod machine after publishing.

## Code quality (load-bearing — full text in `docs/code-quality.md`)

Three rules gate every change. The **why** + full detail live in
**[`docs/code-quality.md`](./docs/code-quality.md)**; the must-obey core:

- **Eight shalls / shall-nots** (craft): understand an interface before using it;
  reuse > invent; verify edge / error / concurrency paths, not just the happy one;
  **surgical diffs** (every line traces to the task — no drive-by cleanup); when two
  patterns conflict, pick the newer / more-central one and say why — **never write
  "satisfies-both" hybrids**.
- **Agent-prompt red line:** `src/daemon/prompt.ts` is the standing prompt shared by
  *every* runtime — keep it **runtime-agnostic**. No provider-specific tool names
  (`Read` / `cat` / `grep` / vision hints); describe capabilities generically; after
  editing, `grep` for provider tool names → expect zero hits.
- **Verification before "done":** code complete ≠ task done. Run every applicable layer
  (unit → integration / E2E → real-run: curl / browser / CLI) and **post the evidence**.
  **Fail loud:** every "done" must list what was skipped, what warned, what wasn't verified.

## Human auth & first deploy

> Full access-control model (capability/scope tables, the four invariants, per-plane enforcement, and the
> hardening roadmap of known gaps) lives in **[`docs/authorization.md`](./docs/authorization.md)** — this
> section is just the deploy-facing summary.

Three separate auth planes — do not conflate them (`src/server/auth.ts`):
- **human** → JWT (`signUser`/`verifyUser`), endpoints under `/api/auth/*`.
- **agent** → per-agent token (`Bearer sk_agent_*` + `x-agent-id`), `resolveAgent`, `/agent-api/*`.
- **daemon** → bootstrap/machine key over WS `/daemon/connect?key=` (`ws.ts`).

Human-auth env flags (`.env` / `.env.prod`):
- `ALLOW_DEV_LOGIN` — when `true`, `POST /api/auth/dev-login` mints a username→JWT with no
  password. **Development only; leave unset in production** (the endpoint 404s when off). Defense in
  depth: `NODE_ENV=production` (set by the Dockerfile runtime stage) force-disables dev-login even if
  the flag is mistakenly set, so the env flag is not the only line of defense. The frontend never
  silently falls back to dev-login; an anonymous visitor to `/s/*` is redirected to `/login` by the
  route guard in `web/src/main.tsx`.
- `ADMIN_SETUP_TOKEN` — one-time first-deploy admin bootstrap. The seeded owner has no password,
  so after `npm run seed` set this to a long random value and call once:
  `curl -X POST $URL/api/auth/setup -d '{"token":"<token>","email":"admin@you","password":"<≥8>"}'`.
  It sets the owner's password and self-closes (`410 already initialized`) once a password exists.
  Disabled (`404`) when the token is unset.

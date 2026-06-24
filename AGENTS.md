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

> Keep this file in "map" form: details go into their respective files.
> **Don't accumulate history or changelogs here** — that's what `git log` is for.

## Code quality rules

### Eight shalls and eight shall-nots

**Shall:** Understand where an interface comes from and why it exists; trace upstream
and downstream dependencies when necessary.
**Shall not:** Guess at interfaces without reading the code or docs.

**Shall:** Clarify goal, boundary conditions, and input/output before writing anything.
**Shall not:** Start coding with a fuzzy understanding, then rely on luck to pass review.

**Shall:** Ask the product owner or backend directly when business logic is unclear.
**Shall not:** Fill in missing information with assumptions and treat them as facts.

**Shall:** Reuse existing interfaces, components, and conventions to keep the system
consistent and maintainable.
**Shall not:** Casually invent a new interface or utility for the sake of it.

**Shall:** Verify code against edge cases, error paths, concurrency, and perf paths.
**Shall not:** Only test the happy path and hope for the best.

**Shall:** Code structure follows the architecture; style follows team conventions —
even when refactoring is expensive.
**Shall not:** Ship "it runs" code that ignores the architecture.

**Shall:** Admit "I don't know" and look it up; make decisions with data.
**Shall not:** Bluff, over-explain, or use confidence to cover ignorance.

**Shall:** Understand the original intent, assess impact, and fully verify before
changing any code.
**Shall not:** Spot a problem and immediately patch it — that turns one bug into three.

**Shall:** Use the minimum code that solves the problem; prefer reuse over invention,
simple over "flexible".
**Shall not:** Write 200 lines of code for a 50-line problem, or add extension points
nobody asked for.

**Shall:** Make surgical changes — every line in the diff must trace back to the
current requirement.
**Shall not:** Opportunistically "clean up" adjacent code or reformat things you
dislike; that turns diffs into archaeology.

**Shall:** When two conflicting patterns exist in the codebase, pick the newer / more
central / more widely depended-on one, state why, and mark the other as pending cleanup.
**Shall not:** Write "satisfies both" code — dual error handlers, calling old and new
APIs simultaneously, mixing two state-management systems. Hybrids are harder to
maintain and harder to debug than either pure form.

### Agent-prompt red line (load-bearing)

`src/daemon/prompt.ts` is the **standing system prompt shared by every runtime**
(claude, codex, and any future runtime). It must stay **runtime-agnostic**:

- Do **not** hard-code tool names specific to one provider (e.g. `Read`, `cat`,
  `grep`, vision-specific instructions).
- Describe capabilities in generic terms.
- After editing, `grep` for provider-specific tool names to confirm zero hits.

### Verification before "done"

Completing code ≠ completing the task. Verification layers (use every applicable one):

1. **Unit tests** — verify logic correctness.
2. **Integration / E2E tests** — verify API endpoints, DB operations, module wiring.
3. **Real-run verification** — `curl` real endpoints; open the browser with the
   chrome-devtools MCP (pass `--isolated` when running in parallel so you get your own
   Chrome instance instead of grabbing a shared one) and confirm rendering and
   interaction; run CLI commands and confirm output. Never just "feel like it should work."
4. Post real evidence (command output, screenshot, test results) before claiming done.

**Fail loudly — no silent failures.** Every "done" claim must explicitly list:
- What was skipped or filtered out.
- Any warnings (compiler, runtime, migration constraints).
- What was not verified — which paths / edge cases were not exercised.

"Migration succeeded / tests passed / feature OK" is not trusted on its own;
it must be accompanied by the above checklist.

## Human auth & first deploy

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

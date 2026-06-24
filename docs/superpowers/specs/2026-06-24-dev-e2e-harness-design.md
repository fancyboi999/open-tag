# Per-worktree on-demand dev E2E harness

Date: 2026-06-24
Status: approved design (pending spec review)

## Problem

There is no isolated, repeatable way to run a **full human↔agent end-to-end** loop
locally. Verifying anything that touches the agent runtime (mention an agent → it runs →
replies; realtime delivery to agents; memory; profile sync) today means hand-signing
JWTs, manually creating channels, and there is no ready-to-run agent bound to the local
daemon. Multiple developers/agents working in parallel also risk colliding on the shared
`~/.open-tag` data dir and the single database.

## Goal

A developer or coding agent can, **on demand**, bring up a fully isolated workspace with a
**real runnable `claudecode`/`sonnet` agent** and drive the complete human↔agent loop —
without disturbing production, other worktrees, or other developers.

## Requirements (from brainstorm)

1. **Real runnable agent** — full E2E: dev-login in the browser, `@` the seeded agent in a
   channel, it actually runs on the local `claude` runtime and replies.
2. **Database isolation** — per worktree, separate database.
3. **Local runtime** — `claude` runs on the host (daemon on host, not in a container).
4. **On-demand** — not always-on. The coding agent decides per task whether to spin it up;
   tasks that don't touch the agent runtime skip it.
5. **Per-worktree isolation, fully parallel** — each worktree gets its own DB + ports +
   data dir; two worktrees run server+daemon+agent simultaneously with zero collision.

## What already exists (build on, don't rebuild)

`scripts/wt-add.sh` (`npm run wt:add -- <name>`) already provisions most isolation: own
branch, free ports (server from 7801, vite from 5301), a separate database
`opentag_<name>`, a separate redis DB index, a generated worktree `.env`, deps install,
schema push, and seed. `src/env.ts` loads the worktree `.env` for **both** the server and
the daemon entry points (both `import "../env.js"`), and the daemon defaults its
`--server-url` to `http://localhost:${PORT}` from that `.env`. `log.ts` and `storage.ts`
already support env overrides (`OPEN_TAG_LOG_DIR`, `OPEN_TAG_UPLOAD_DIR`) — a precedent.

The **only** isolation gap is the daemon/agent data directory, which is hardcoded.

## Approach (chosen): fill the gaps in wt:add + add an on-demand `dev:e2e`

### Component 1 — `OPEN_TAG_HOME` env (the one code change)

`~/.open-tag/{agents,bin,machine-id}` is hardcoded in four daemon files, so two worktrees'
daemons would share agent workspaces and the machine-id. Introduce a single base dir:

```
OPEN_TAG_HOME = process.env.OPEN_TAG_HOME ?? path.join(os.homedir(), ".open-tag")
```

exported from one small module (e.g. `src/paths.ts`). Derive every subdir from it:
- `src/daemon/agentManager.ts` — `DATA_DIR = <HOME>/agents`
- `src/daemon/workspace.ts` — `DATA_DIR = <HOME>/agents`
- `src/daemon/openTagBin.ts` — `<HOME>/bin`
- `src/daemon/index.ts` — `MID_FILE = <HOME>/machine-id`
- `src/log.ts` — default `<HOME>/logs` (keep `OPEN_TAG_LOG_DIR` as a higher-precedence override)
- `src/server/storage.ts` — default `<HOME>/uploads` (keep `OPEN_TAG_UPLOAD_DIR` override)

Default unchanged (`~/.open-tag`), so prod and existing setups are unaffected. Both entry
points already load `.env`, so setting `OPEN_TAG_HOME` in a worktree `.env` is sufficient.

### Component 2 — wt:add / wt:rm extension

- `wt-add.sh`: add `OPEN_TAG_HOME=$HOME/.open-tag-<name>` and `ALLOW_DEV_LOGIN=true` to the
  generated `.env`. Now each worktree is fully isolated: DB + ports + redis + **data dir**.
- `wt-rm.sh`: on removal, also `rm -rf $HOME/.open-tag-<name>` and drop the `opentag_<name>`
  database (verify current wt-rm behavior and extend as needed). No orphans.

### Component 3 — `seed:dev` (dev-only fixture)

New `npm run seed:dev` → `src/db/seed-dev.ts`. Idempotent. On top of the minimal bootstrap
seed, create one agent in the dev workspace: `runtime: "claude"`, `model: "sonnet"`, a
clear dev name (e.g. `dev-bot`), added to `#all`. Never invoked by production paths — this
is explicitly a dev fixture (aligns with the bootstrap seed's "agents created through
onboarding, never as production fixtures"). Login is already covered by dev-login (`?as=`).

### Component 4 — on-demand `dev:e2e:up` / `dev:e2e:down`

New scripts (`scripts/dev-e2e-up.sh` / `dev-e2e-down.sh`, exposed as `npm run dev:e2e:up` /
`dev:e2e:down`):
- **up**: build the web frontend if `web/dist` is stale, then start `server` and `daemon`
  as background processes for the current worktree's `.env` (logs to the worktree's
  `OPEN_TAG_HOME/logs`). The server serves the built `web/dist` on `PORT`, so the browser
  E2E needs **no separate vite process** (vite HMR remains the path for active frontend
  dev, unchanged). Poll until the server is healthy and the daemon's machine is
  registered/online; run `seed:dev` (idempotent) so the agent exists; print the dev-login
  URL `http://localhost:$PORT/?as=you` and the agent handle. Fail loud if the `claude`
  CLI/credentials are missing.
- **down**: stop the background server + daemon for this worktree.

These are the **on-demand** entry point: a coding agent runs `dev:e2e:up` only when its task
needs the live agent loop.

### Component 5 — AGENTS.md guidance

A short subsection: when a task touches the **agent runtime / human↔agent loop / realtime
delivery to agents / agent memory**, spin up the isolated stack with `npm run dev:e2e:up`
(per-worktree: separate DB + data dir + a real `claude`/`sonnet` agent), verify, then
`npm run dev:e2e:down`. Otherwise skip it. This is what lets the coding agent decide
autonomously — the trigger is documentation, not automation.

## Data flow (the dev loop)

```
npm run wt:add -- foo
  → ../open-tag-foo  +  .env { PORT, VITE_PORT, DATABASE_URL=opentag_foo,
                                REDIS_URL, OPEN_TAG_HOME=~/.open-tag-foo, ALLOW_DEV_LOGIN }
cd ../open-tag-foo  (do the code work)
npm run dev:e2e:up
  → server (PORT) + daemon → daemon registers machine, writes ~/.open-tag-foo/machine-id,
    agent workspaces under ~/.open-tag-foo/agents/  (zero collision with other worktrees)
  → seed:dev → claude/sonnet agent in #all
browser http://localhost:$PORT/?as=you (server serves built web/dist) → @dev-bot
  → real claude reply   ← full E2E
npm run dev:e2e:down            (stop the live stack)
npm run wt:rm -- foo            (from main repo: tears down worktree + DB + data dir)
```

## Invocation model

Plain **npm scripts** run via Bash — agent-agnostic (works for Claude Code, Codex, humans),
lives in the repo. **Not** a Claude Code slash command. **Never auto-triggered**; always
explicit. The coding agent decides per task via AGENTS.md guidance. (An optional thin
Claude-side `/dev-e2e` wrapper could exist later, but the npm script is the source of truth.)

## Assumptions

- The dev host has the `claude` CLI installed and authenticated (the team already uses it).
  If absent, `dev:e2e:up` fails loud with a clear message rather than seeding a dead agent.
- The shared docker postgres (5433) and redis (6380) from `docker compose` are running
  (wt:add already relies on this).

## Verification plan

1. **Isolation (unit-ish)**: with `OPEN_TAG_HOME` set, the daemon resolves all paths under
   it (assert via a small script or log inspection).
2. **Parallel (the headline)**: `wt:add a` + `wt:add b`, `dev:e2e:up` in both → two servers,
   two daemons, two machines, two agent workspaces under `~/.open-tag-a` vs `~/.open-tag-b`,
   no shared files; a message in A's workspace never appears in B.
3. **Full E2E**: in one worktree, browser dev-login → `@dev-bot` in #all → confirm a real
   `claude` reply lands in the channel (chrome-devtools).
4. **Teardown**: `dev:e2e:down` stops processes; `wt:rm` removes worktree + DB + data dir,
   leaving no orphans.
5. `npm run typecheck` green.

## Out of scope (YAGNI)

- Containerizing the daemon (conflicts with the local-runtime requirement).
- Multiple seeded agents / extra channels (one agent + #all is enough; revisit if needed).
- CI integration of the E2E harness (separate concern).
- A Claude Code slash-command wrapper (optional future thin layer).

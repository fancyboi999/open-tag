# Railway Preproduction Deployment Design

## Goal

Deploy the open-tag control plane to Railway as a production-shaped preproduction
environment, verify the real frontend/backend/database/realtime path, and leave a
clear gate between "deployed" and "safe to announce as a public beta".

The local daemon remains outside Railway. It connects from a user-controlled
machine to the public control-plane WebSocket, preserving open-tag's three-plane
architecture.

## Scope

This slice includes:

- one Railway Web service built from the repository root `Dockerfile`;
- one Railway-managed Postgres service;
- one Railway-managed Redis service;
- a Railway-generated HTTPS domain;
- production secrets and database reference variables;
- one-time initialization of the seeded owner account;
- real HTTP, browser, persistence, Socket.IO, and daemon WebSocket verification;
- deployment documentation and a fail-loud handoff.

This slice does not declare the service ready for public beta. Public beta still
requires shared Redis-backed auth rate limiting, email verification, durable
object storage, and completion or explicit acceptance of the remaining security
roadmap items in `docs/authorization.md`.

## Architecture

### Railway services

1. **`open-tag-web`**
   - Source: the current deployment worktree uploaded with Railway CLI.
   - Build: the root `Dockerfile`.
   - Runtime: one Node process serving `web/dist`, `/api/*`, `/agent-api/*`,
     Socket.IO, and `/daemon/connect`.
   - Health endpoint: `GET /health`.
   - Public networking: one Railway-generated domain.

2. **`Postgres`**
   - Railway-managed Postgres.
   - Exposes `DATABASE_URL`.
   - Persists users, workspaces, channels, messages, agents, and machine records.

3. **`Redis`**
   - Railway-managed Redis.
   - Exposes `REDIS_URL`.
   - Supplies message/task counters, pub/sub, and agent wake queues.

Railway service references, not copied connection strings, provide
`DATABASE_URL=${{Postgres.DATABASE_URL}}` and
`REDIS_URL=${{Redis.REDIS_URL}}` to `open-tag-web`.

### Container startup

The existing container entrypoint (`scripts/docker-entrypoint.sh`) remains authoritative:

1. `npx drizzle-kit push` (without `--force`) applies additive schema changes.
   If a migration would require destructive changes (drop column/table), drizzle-kit
   exits non-zero in a non-interactive container — causing the container to refuse to
   start rather than silently destroying data. Run it manually with `--force` only after
   reviewing the diff. (**Note:** an earlier version of this design said `push --force`;
   that was removed in PR-E / `docs/self-host.md` — this spec is now aligned.)
2. `npx tsx src/db/seed.ts` creates the bootstrap workspace only when absent (idempotent).
3. `exec npx tsx src/server/index.ts` starts on Railway's injected `PORT`.

The deploy must fail if schema migration or seed fails. The server must not start
against a mismatched schema.

### Human initialization

Production sets:

- a randomly generated `JWT_SECRET`;
- a randomly generated `DAEMON_BOOTSTRAP_KEY`;
- a randomly generated `ADMIN_SETUP_TOKEN`;
- `NODE_ENV=production`;
- no `ALLOW_DEV_LOGIN`.

After the first healthy deployment, the operator calls `POST /api/auth/setup`
once to assign a real email and password to the seeded owner. The endpoint must
return `410 already initialized` on a second valid attempt. The
`ADMIN_SETUP_TOKEN` variable is then deleted.

The preproduction registration page remains reachable because registration does
not yet have a production feature flag. The Railway URL must therefore not be
announced or indexed as a public beta. This is a known temporary exposure, not a
security guarantee.

## Storage

Railway's container filesystem is ephemeral — local-storage uploads are lost on every
restart. **R2 is a required first-class step** in `docs/deploy-railway.md` (Step 5),
not a post-beta item. The code already supports it: `src/server/storage.ts` uses
`@aws-sdk/client-s3` (in `package.json` at `^3.0.0`) with `forcePathStyle: true`
and a configurable `OPEN_TAG_S3_ENDPOINT`, compatible with Cloudflare R2. Set
`OPEN_TAG_S3_REGION=auto` for R2.

Before any public use, complete Step 5 of `docs/deploy-railway.md` (create R2 bucket,
set `OPEN_TAG_STORAGE=s3` + `OPEN_TAG_S3_*` variables in Railway) and verify
persistence: upload → redeploy → confirm the file is still accessible.

## Deployment Source and Release Flow

The durable deployment path (from PR merge onwards):

1. The Railway Web service is connected to
   `https://github.com/fancyboi999/open-tag`, branch `main`.
2. Every push to `main` triggers an automatic Railway build + deploy.
3. Railway reads `railway.json` (repo root) for the healthcheck path and restart policy.
4. `/health` must return `200 {"ok":true}` before Railway marks the deployment active.
5. `railway.json` configures healthcheck timeout at 120 s to allow the entrypoint's
   schema migration and seed to complete before health probing begins.

No daemon is deployed to Railway. Daemon package publishing remains governed by
the separate release discipline in `AGENTS.md`.

## Verification

### Static and automated

- `npm run typecheck`;
- all current `node:test` suites;
- local Docker image build.

### Live Railway checks

1. `GET /health` returns HTTP 200 and `{ "ok": true }`.
2. `/` renders the landing page over HTTPS.
3. `/login` renders, while `/api/auth/dev-login` returns 404.
4. One-time admin setup succeeds, then self-closes.
5. Admin login succeeds and loads the seeded `open-tag` workspace.
6. A test channel/message survives a Web service restart, proving Postgres
   persistence.
7. A browser receives a realtime message event without reload, proving
   Socket.IO routing.
8. A local daemon connects to `/daemon/connect`, appears online, and reconnects
   after a Web service restart.
9. Deployment logs contain no migration, seed, Redis, or unhandled request
   errors.

### Fail-loud handoff

The final report must list:

- skipped checks;
- warnings observed during build or runtime;
- paths not verified;
- the Railway project/service names and generated URL;
- whether the environment is merely deployed or approved for public beta.

## Public Beta Gate

The environment may be called a public beta only after all of the following are
implemented and verified:

- auth limits use Redis and are shared across restarts/instances;
- registration requires email ownership verification;
- attachments use durable S3-compatible storage;
- production secrets contain no development defaults;
- the remaining authorization roadmap is reviewed and accepted or closed;
- registration, login, password reset/recovery, and abuse paths have real
  integration tests;
- domain, privacy policy, terms, abuse contact, monitoring, backups, and a
  rollback procedure are in place.

Until then, the Railway deployment is preproduction infrastructure.


# Docker: one-command control plane

`docker compose --profile app up` runs the **control plane** — Postgres + Redis + the
API/web server — in containers. The **daemon (compute plane) stays on your host**: it runs
your locally-installed agent CLIs (`claude`/`codex`/`copilot`/`opencode`/`kimi`/`pi`/`cursor-agent`)
against your code and credentials, so it is not containerized. You connect it yourself after the stack is up.

> For the complete self-hosting guide (HTTPS, systemd, backup, secrets reference) see
> **[`docs/self-host.md`](self-host.md)**.

## What is / isn't containerized

| Plane | Where it runs | How |
|---|---|---|
| Postgres + Redis | container | compose services `postgres`, `redis` |
| API + web + docs (control plane) | container | compose service `app` (this image; serves the app at `/` and docs at `/docs/`) |
| daemon + agents (compute plane) | **your host** | `npx @fancyboi999/open-tag-daemon` — connects over the published WS port |

## First run

```bash
# 1. Configure secrets (never committed)
cp .env.docker.example .env.docker
#    fill JWT_SECRET, DAEMON_BOOTSTRAP_KEY, ADMIN_SETUP_TOKEN — each: openssl rand -hex 32
#    leave ALLOW_DEV_LOGIN unset (production default: dev-login is disabled)

# 2. Build + start postgres + redis + app (schema push + seed run automatically on boot)
docker compose --profile app up -d --build

# 3. Initialize the admin once (no hard-coded password; the endpoint self-closes afterwards)
curl -X POST http://localhost:7788/api/auth/setup \
  -H 'content-type: application/json' \
  -d '{"token":"<ADMIN_SETUP_TOKEN>","email":"you@example.com","password":"<min 8 chars>"}'
#    then clear ADMIN_SETUP_TOKEN from .env.docker and restart:
#    docker compose --profile app restart app

# 4. Connect your machine (host daemon → containerized server). --api-key MUST equal DAEMON_BOOTSTRAP_KEY.
npx @fancyboi999/open-tag-daemon@latest --server-url http://localhost:7788 --api-key <DAEMON_BOOTSTRAP_KEY>
```

Open `http://localhost:7788`, sign in with the admin email/password, create an agent, and mention it in `#all`.
The same server also serves the documentation page at `http://localhost:7788/docs/`.

## Notes

- `npm run infra` (no `--profile app`) still starts only postgres+redis — the host-run dev workflow
  (`npm run server` / `npm run daemon`) is unchanged.
- The `app` container reads config from `.env.docker` only (compose `env_file`); `DATABASE_URL`/`REDIS_URL`
  point at the internal service DNS (`postgres:5432` / `redis:6379`), not host `localhost:5433/6380`.
- Override the published port with `APP_PORT` (e.g. `APP_PORT=8080 docker compose --profile app up -d`).
  Stop any host-run server on the same port first.
- Schema migration (`drizzle-kit push` without `--force`) and seed run on every container start; both are idempotent.
  Additive-only schema changes apply automatically; destructive changes cause the container to fail rather than
  silently drop data — see `docs/self-host.md` for the manual migration procedure.
- The authoritative access-control model (three auth planes, capabilities, scopes) is `docs/authorization.md`; the deploy-facing `ALLOW_DEV_LOGIN` / `ADMIN_SETUP_TOKEN` flag summary is in `AGENTS.md`.

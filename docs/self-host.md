# Self-Hosting open-tag

> **Cloud deployment on Railway**: see [`docs/deploy-railway.md`](./deploy-railway.md)
> for a step-by-step guide to deploying on Railway (managed Postgres + Redis, custom
> domain, Cloudflare R2 storage, daemon from your own machine).

This guide walks you through running open-tag on your own infrastructure — from a
fresh Ubuntu VPS to a long-running production stack.

## Architecture overview

open-tag has two planes you need to run:

| Plane | What it is | Where it runs |
|---|---|---|
| **Control plane** | Postgres + Redis + API server + React web | One host (your VPS, a cloud VM, a home server) |
| **Compute plane** | Daemon + agent CLI runtimes | Any machine with the agent CLIs installed — can be the same host or a separate one |

The control plane is **stateful** (DB, uploads) and is containerized.
The compute plane runs **your actual agent CLIs** (`claude`, `codex`, etc.) and is not
containerized — it needs direct access to those CLIs, your code, and your credentials.

## Recommended path: Docker Compose

Docker Compose is the recommended way to run the control plane.
The bare Node.js path (below) is for advanced users who want more control.

### Prerequisites

- A Linux VPS (Ubuntu 22.04 LTS recommended) with at least 1 GB RAM
- Docker 24+ and Docker Compose v2 (`docker compose version`)
- A domain name pointed at the VPS (for HTTPS)
- At least one supported agent CLI on the **daemon host**: `claude`, `codex`, `copilot`, `opencode`, `kimi`, `pi`, or `cursor-agent`

### Step 1 — Clone and configure secrets

```bash
git clone https://github.com/fancyboi999/open-tag.git
cd open-tag
cp .env.docker.example .env.docker
```

Open `.env.docker` and fill the three required secrets. Generate each with:

```bash
openssl rand -hex 32
```

| Variable | What it is | Notes |
|---|---|---|
| `JWT_SECRET` | Signs human session tokens | At least 32 random bytes |
| `DAEMON_BOOTSTRAP_KEY` | Authenticates the daemon's WebSocket connection | At least 32 random bytes |
| `ADMIN_SETUP_TOKEN` | One-time token for the first admin bootstrap | At least 32 random bytes; **clear it after first use** |

The file already has the correct internal service URLs
(`DATABASE_URL=postgres://…@postgres:5432/opentag` and `REDIS_URL=redis://redis:6379`).
Leave those as-is.

**Security checklist before continuing:**

- `ALLOW_DEV_LOGIN` is commented out — leave it that way. It is only for development and
  gives anyone who can reach the server a passwordless login. Never set it in production.
- `JWT_SECRET` must be unique and random. The placeholder in `.env.docker.example` is not
  a secret — replace it.
- `.env.docker` is gitignored. Never commit it.

### Step 2 — Start the control plane

```bash
docker compose --profile app up -d --build
```

This builds the image (first run only), starts Postgres + Redis, waits for them to be
healthy, then starts the app container. The container entrypoint automatically:
1. Pushes the Drizzle schema (additive-safe; fails loudly if destructive changes would be applied)
2. Seeds the default workspace (`#all` channel, seeded owner)

Check that it is running:

```bash
docker compose ps
docker compose logs app --tail=50
```

The server is now on port **7788** (default) or `${APP_PORT}` if you overrode it.

> **Schema migration safety**: the entrypoint runs `drizzle-kit push` *without* `--force`.
> Additive-only migrations (the normal case) are applied automatically. If a future version
> requires a destructive migration (dropping a column or table), drizzle-kit will detect
> that stdin is not a TTY and exit with an error — causing the container to fail rather than
> silently destroy data. When that happens, run the migration manually on a temporary
> one-off container (the main container is stopped, so `docker exec` won't work):
> ```bash
> # Run drizzle-kit interactively against the running postgres service
> docker compose --profile app run --rm --entrypoint "" app \
>   npx drizzle-kit push --force
> # Review the diff and confirm, then start the app normally:
> docker compose --profile app up -d
> ```

### Step 3 — Initialize the admin account

The seeded owner has no password yet. Set it once with the `ADMIN_SETUP_TOKEN`:

```bash
curl -X POST http://localhost:7788/api/auth/setup \
  -H 'content-type: application/json' \
  -d '{"token":"<ADMIN_SETUP_TOKEN>","email":"you@example.com","password":"<min 8 chars>"}'
```

The endpoint returns `200 OK` on success and permanently self-closes (`410 Gone`) once
a password is set. After the call succeeds, **clear `ADMIN_SETUP_TOKEN`** from `.env.docker`
(set it to blank or remove the line) and restart the app:

```bash
docker compose --profile app restart app
```

From this point the `/api/auth/setup` endpoint returns `404` — no one can use it again.

### Step 4 — Connect the compute-plane daemon

The daemon runs on whatever machine has your agent CLIs. It connects back to the
control plane over WebSocket using `DAEMON_BOOTSTRAP_KEY`.

**Same machine** (daemon on the VPS):

```bash
# Using the published npm package — no repo clone needed:
npx @fancyboi999/open-tag-daemon@latest \
  --server-url http://localhost:7788 \
  --api-key <DAEMON_BOOTSTRAP_KEY>
```

**Remote machine** (daemon on your dev machine or another server):

```bash
npx @fancyboi999/open-tag-daemon@latest \
  --server-url https://your-domain.com \
  --api-key <DAEMON_BOOTSTRAP_KEY>
```

The daemon registers as a machine in the workspace. Go to **Settings → Computers** in the
web UI to confirm it appears online.

> The daemon stores agent workspaces, `MEMORY.md` files, and logs under `OPEN_TAG_HOME`
> (default: `~/.open-tag`). See [Data directory](#data-directory-open_tag_home) below.

### Step 5 — Firewall and HTTPS

**Open HTTP/HTTPS ports** if you have a firewall (Ubuntu ships with `ufw` enabled):

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

Running on a public VPS, you also need TLS. Two options below use port **7788** (the
Docker Compose default). If you are using bare Node.js with the default `PORT=7777`,
substitute `7777` for `7788` in the proxy config.

#### Option A — Caddy (automatic TLS)

```bash
# Install Caddy on the VPS: https://caddyserver.com/docs/install
cat > /etc/caddy/Caddyfile << 'EOF'
your-domain.com {
    reverse_proxy localhost:7788
}
EOF
systemctl reload caddy
```

Caddy handles Let's Encrypt certificate issuance and renewal automatically.

#### Option B — nginx + Certbot

```nginx
# /etc/nginx/sites-available/open-tag
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    # WebSocket support (required for daemon control plane and socket.io real-time)
    location / {
        proxy_pass         http://localhost:7788;  # change to :7777 for bare Node.js
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;   # keep long-lived WebSocket connections alive
    }
}
```

```bash
ln -s /etc/nginx/sites-available/open-tag /etc/nginx/sites-enabled/
certbot --nginx -d your-domain.com
nginx -s reload
```

### Step 6 — Verify

Open `https://your-domain.com` in a browser. Sign in with the email and password you set
in Step 3. Go to **Settings → Computers** and confirm the daemon is online.

Create an agent from **Members → New Agent**, assign it to the daemon machine, then
mention it in `#all`. It should wake, respond, and post the reply into the channel.

---

## Data directory (`OPEN_TAG_HOME`)

The daemon process stores everything on the host that runs it:

```
~/.open-tag/
  agents/<agent-id>/        # persistent agent workspaces + MEMORY.md
  bin/open-tag              # generated CLI wrapper injected into agents' PATH
  logs/                     # server and daemon logs
  uploads/                  # attachments (when using local storage)
```

`OPEN_TAG_HOME` defaults to `~/.open-tag`. Override it with the environment variable:

```bash
export OPEN_TAG_HOME=/data/open-tag
```

Set this in `.env.prod` or the systemd unit's `[Service]` section (see
[Bare Node.js](#bare-nodejs-advanced) below) to keep it consistent across restarts.

For the **control-plane server** (running in Docker), agent uploads are also written to
`OPEN_TAG_HOME/uploads/` on the container's filesystem. Since the container is stateless
by default, mount this directory as a volume if you want uploads to survive container
replacement:

```yaml
# In docker-compose.yml, under the `app` service:
volumes:
  - uploads:/home/node/.open-tag/uploads
```

Then add `uploads: {}` to the top-level `volumes:` section. Alternatively, use
[S3-compatible object storage](../README.md#object-storage-attachments) so the control
plane and daemon share one store across hosts.

---

## Backup and restore

### What to back up

| Data | Location | How |
|---|---|---|
| Database (all messages, tasks, agents, etc.) | Postgres `opentag` database | `pg_dump` |
| Agent workspaces + `MEMORY.md` | `$OPEN_TAG_HOME/agents/` on the daemon host | `rsync` / `tar` |
| Uploads (if local storage) | `$OPEN_TAG_HOME/uploads/` on the server host | `rsync` / `tar` |
| Secrets | `.env.docker` / `.env.prod` | Encrypted backup (1Password, etc.) |

### Database backup (Docker Compose)

```bash
# Dump to a timestamped file
docker exec open-tag-pg \
  pg_dump -U opentag -d opentag -Fc \
  > "open-tag-db-$(date +%Y%m%d-%H%M%S).dump"
```

Automate with a backup script and cron job:

```bash
# Create the backup directory
sudo mkdir -p /backups && sudo chown $(whoami) /backups

# Create the backup script
cat > /usr/local/bin/open-tag-backup.sh << 'SCRIPT'
#!/bin/bash
set -euo pipefail
DEST="/backups/open-tag-db-$(date +%Y%m%d-%H%M%S).dump"
docker exec open-tag-pg pg_dump -U opentag -d opentag -Fc > "$DEST"
find /backups -name 'open-tag-db-*.dump' -mtime +14 -delete
SCRIPT
sudo chmod +x /usr/local/bin/open-tag-backup.sh
```

```cron
# /etc/cron.d/open-tag-backup  (one line — no backslash continuation)
0 3 * * * root /usr/local/bin/open-tag-backup.sh
```

### Database restore

```bash
# Stop the app first so there are no active connections
docker compose --profile app stop app

# Restore (WARNING: this REPLACES all existing data)
docker exec -i open-tag-pg \
  pg_restore -U opentag -d opentag --clean --if-exists \
  < open-tag-db-YYYYMMDD-HHMMSS.dump

# Restart
docker compose --profile app start app
```

### Agent workspace backup

```bash
# Back up all agent workspaces from the daemon host
tar -czf "open-tag-agents-$(date +%Y%m%d).tar.gz" ~/.open-tag/agents/
```

---

## Optional: Redis password hardening

The default configuration leaves Redis unauthenticated — acceptable on a single-host
VPS where Redis is not exposed to the network (port 6380 is only used by the host or
other local containers). If your setup exposes Redis to a wider network, add auth:

1. Generate a password:

   ```bash
   openssl rand -hex 32
   # → e.g. ab12cd34ef56...
   ```

2. In `docker-compose.yml`, edit the `redis` service to add the `command` line:

   ```yaml
   redis:
     image: redis:7.2-alpine
     command: redis-server --requirepass ab12cd34ef56...
   ```

3. In `.env.docker`, update `REDIS_URL`:

   ```
   REDIS_URL=redis://:ab12cd34ef56...@redis:6379
   ```

4. Restart:

   ```bash
   docker compose --profile app down
   docker compose --profile app up -d
   ```

---

## Bare Node.js (advanced)

Use this if you prefer to run the server directly on the host without Docker, or if you
are already managing Postgres and Redis yourself.

### Prerequisites

- Node.js 20+
- PostgreSQL 15+ (running locally or remotely)
- Redis 7+ (running locally or remotely)
- A process manager: systemd (recommended), PM2, or `nohup`

### Step 1 — Infrastructure

If you don't have Postgres and Redis yet, start them with just the infra compose profile:

```bash
docker compose up -d   # starts only postgres + redis (no --profile app = no app container)
```

Or install them natively (system packages or managed cloud instances).

### Step 2 — Configure

```bash
cp .env.example .env.prod
```

> **Critical**: `.env.example` has `ALLOW_DEV_LOGIN=true` uncommented (it is a
> development convenience default). You **must** comment it out or remove it before
> starting the production server — leave it active and anyone who can reach your server
> gets a passwordless login for any account. The systemd unit (Step 5) sets
> `NODE_ENV=production` which disables dev-login at the code level regardless, but the
> env file is also read by manual `npm run start:prod` invocations, so it is safer to
> remove the line entirely.

Edit `.env.prod`:

```env
DATABASE_URL=postgres://opentag:opentag@localhost:5433/opentag
REDIS_URL=redis://localhost:6380
PORT=7777

JWT_SECRET=<openssl rand -hex 32>
DAEMON_BOOTSTRAP_KEY=<openssl rand -hex 32>
ADMIN_SETUP_TOKEN=<openssl rand -hex 32>

# ALLOW_DEV_LOGIN must be absent or commented out in production
# ALLOW_DEV_LOGIN=true   ← remove or comment this line from the copied .env.example

# Optional: override where agent workspaces and logs are stored
# OPEN_TAG_HOME=/data/open-tag
```

### Step 3 — Build and migrate

```bash
npm install
npm --prefix web install
npm --prefix docs-site install
npm run site:build

# Push schema (additive-safe; prompts on destructive changes)
npm run db:push:prod

# Seed the default workspace (idempotent)
ENV_FILE=.env.prod npx tsx src/db/seed.ts
```

### Step 4 — Initialize the admin account

Same as Docker: call the `/api/auth/setup` endpoint once (see [Step 3](#step-3--initialize-the-admin-account) above),
then clear `ADMIN_SETUP_TOKEN` from `.env.prod`.

### Step 5 — Start with systemd

Install the provided unit files:

```bash
# Edit the WorkingDirectory and User fields to match your setup, then:
sudo cp docs/systemd/open-tag-server.service /etc/systemd/system/
sudo cp docs/systemd/open-tag-daemon.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now open-tag-server
sudo systemctl enable --now open-tag-daemon
```

> **nvm users**: systemd starts services with a minimal `PATH` that does not include
> nvm-managed Node.js. If you installed Node via nvm, you have two options:
>
> **Option A** — use the full path. Find where npx lives:
> ```bash
> which npx   # e.g. /home/ubuntu/.nvm/versions/node/v22.x.x/bin/npx
> ```
> Then in the unit file, replace `npx` with that absolute path everywhere.
>
> **Option B** — add an `Environment=PATH=` line in `[Service]`:
> ```ini
> Environment=PATH=/home/ubuntu/.nvm/versions/node/v22.x.x/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
> ```
>
> Alternatively, install Node.js via the [official NodeSource PPA](https://github.com/nodesource/distributions)
> or [system packages](https://nodejs.org/en/download/package-manager) so it is on the system PATH.

Check status:

```bash
sudo systemctl status open-tag-server
sudo systemctl status open-tag-daemon
journalctl -u open-tag-server -f
journalctl -u open-tag-daemon -f
```

The server logs also land in `$OPEN_TAG_HOME/logs/` (default `~/.open-tag/logs/`).

### Updating (bare Node.js)

```bash
git pull --ff-only origin main
npm install
npm --prefix web install
npm --prefix docs-site install
npm run site:build
npm run db:push:prod     # migrate schema BEFORE restarting the server
sudo systemctl restart open-tag-server
# Daemon stays running; it reconnects automatically after the server restarts.
```

---

## Updating (Docker Compose)

```bash
git pull --ff-only origin main
docker compose --profile app up -d --build
# The container entrypoint migrates the schema automatically on restart.
```

The daemon process (on the host) keeps running across server restarts and reconnects
automatically. Restart it only when there is a new daemon version:

```bash
# Check the latest published version
npm show @fancyboi999/open-tag-daemon version

# To update, restart the daemon — npx will pull the latest bundle:
# (for systemd)
sudo systemctl restart open-tag-daemon
# (for a manual npx run, just re-run the command — npx @latest re-resolves)
```

> **Daemon versioning**: the daemon ships as a separate npm package
> (`@fancyboi999/open-tag-daemon`). A merged server change does **not** automatically
> reach running daemon processes — they keep running the version they were started with.
> Watch the repository releases for daemon updates and bounce the process after publishing.

---

## Environment variable reference

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | yes | — | Postgres connection string |
| `REDIS_URL` | yes | — | Redis connection string |
| `PORT` | no | `7777` | HTTP listen port |
| `JWT_SECRET` | yes | — | Human session signing key |
| `DAEMON_BOOTSTRAP_KEY` | yes | — | Daemon WS auth key (`openssl rand -hex 32`) — the server refuses to start without it |
| `ADMIN_SETUP_TOKEN` | yes (first deploy only) | — | One-time admin bootstrap; clear after use |
| `ALLOW_DEV_LOGIN` | no | unset | `true` enables passwordless dev-login — **never set in production** |
| `OPEN_TAG_HOME` | no | `~/.open-tag` | Base dir for agent workspaces, logs, uploads |
| `OPEN_TAG_UPLOAD_DIR` | no | `$OPEN_TAG_HOME/uploads` | Override local upload directory |
| `OPEN_TAG_STORAGE` | no | `local` | `local` or `s3` for S3-compatible object storage |
| `OPEN_TAG_S3_ENDPOINT` | if `s3` | — | S3 endpoint URL |
| `OPEN_TAG_S3_BUCKET` | if `s3` | — | Bucket name |
| `OPEN_TAG_S3_KEY` | if `s3` | — | Access key |
| `OPEN_TAG_S3_SECRET` | if `s3` | — | Secret key |
| `OPEN_TAG_S3_REGION` | no | `us-east-1` | S3 region |
| `OPEN_TAG_IDLE_MS` | no | `600000` | Agent idle-sleep timeout in ms (default 10 min) |

> The server has **no built-in fallback** for `JWT_SECRET` or `DAEMON_BOOTSTRAP_KEY` —
> `requireEnv()` (`src/server/auth.ts`) fails at startup if either is missing. (The literal
> `poc-secret-key` you may spot in the repo appears only in the `npm run daemon` dev script's
> `--api-key` argument, never as a server-side default.)

---

## Troubleshooting

**Container won't start**

Check the logs: `docker compose logs app`. If the schema migration exited because
destructive changes require confirmation, follow the manual migration procedure in
[Step 2](#step-2--start-the-control-plane).

**`/api/auth/setup` returns 404**

The endpoint is disabled when `ADMIN_SETUP_TOKEN` is unset. Set it to a random value,
restart the container, call the endpoint, then clear the token again.

**`/api/auth/setup` returns 410 Gone**

The admin password is already set. Use the normal login flow. If you lost the password,
reset it directly in Postgres:

```bash
# Generate a new scrypt hash (the server uses Node.js crypto.scrypt)
# The simplest path is to create a new user via the server's register endpoint
# if registration is enabled, or reach out to the project maintainer for a migration script.
```

**Daemon shows "MACHINE_REJECTED" in logs**

The daemon's `--api-key` does not match `DAEMON_BOOTSTRAP_KEY` on the server.
Verify the key in `.env.docker` / `.env.prod` matches what you passed to `--api-key`.
If the machine row was deleted from the UI, the key is also invalidated — reconnect
with the bootstrap key to re-register.

**Daemon connects but agents go offline immediately**

The selected runtime CLI is not on the daemon host's `PATH`. Run `which claude` (or the
relevant CLI) on the daemon host to confirm it is installed and executable. See the
[README runtime table](../README.md#supported-runtimes) for the binary name for each runtime.

**Port conflict on first run**

If port `7788` (or `5433`/`6380`) is already in use, override it:

```bash
APP_PORT=8080 docker compose --profile app up -d
```

For Postgres and Redis ports, edit `docker-compose.yml` and update `DATABASE_URL` /
`REDIS_URL` in `.env.docker` to match.

# Deploying open-tag to Railway (control plane)

This guide deploys the open-tag **control plane** (web + API + Postgres + Redis) to
Railway and binds `getopentag.com`. The daemon runs on your own machine and connects
back over the public WebSocket — the three-plane architecture is preserved.

---

## STOP — pre-public-beta red lines (read before touching anything)

The following MUST be true before this environment is announced or indexed publicly:

| # | Requirement | Status |
|---|---|---|
| 1 | Security PRs **#71 / #72 / #73 / #75** merged to `main` | you must verify |
| 2 | Registration page has a flag gate (currently **open to anyone**) | pending |
| 3 | **Attachments use R2** (see Step 5 below) — Railway filesystem is ephemeral, local-storage uploads survive zero restarts | must complete Step 5 |
| 4 | Rate-limit is Redis-backed and shared across instances (currently in-process only) | pending |

**Until all four are true: the Railway URL is preproduction infrastructure, not a public beta.**
Do not share it publicly, add it to search engines, or post it on social media.

---

## Architecture

Three Railway services:

```
open-tag-web           ← this repo root Dockerfile
  └─ NODE_ENV=production
  └─ PORT (Railway-injected)
  └─ DATABASE_URL=${{Postgres.DATABASE_URL}}
  └─ REDIS_URL=${{Redis.REDIS_URL}}

Postgres               ← Railway-managed
Redis                  ← Railway-managed

(daemon)               ← YOUR machine, not Railway
  └─ npx @fancyboi999/open-tag-daemon --server-url https://www.getopentag.com …
```

The server reads `PORT` from the environment (line 18 in `src/server/index.ts`:
`const PORT = Number(process.env.PORT ?? 7777)`). Railway injects `PORT` automatically;
no Dockerfile change is needed.

Container startup sequence (from `scripts/docker-entrypoint.sh`):
1. `npx drizzle-kit push` — applies additive schema migrations (fails loud if destructive changes would occur — container refuses to start rather than silently destroying data).
2. `npx tsx src/db/seed.ts` — seeds the default workspace (idempotent; skips if present).
3. `exec npx tsx src/server/index.ts` — starts the server.

---

## Step 1 — Generate secrets locally

Run each command, copy the output. **Never commit these values to git.**

```bash
openssl rand -hex 32   # → JWT_SECRET
openssl rand -hex 32   # → DAEMON_BOOTSTRAP_KEY
openssl rand -hex 32   # → ADMIN_SETUP_TOKEN
```

---

## Step 2 — Create the Railway project

1. Open [railway.com](https://railway.com) and log in.
2. **New Project → Empty Project**. Name it `open-tag`.

### Add Postgres

- Click **New → Database → PostgreSQL**.
- Railway creates a managed Postgres and exposes `DATABASE_URL`.

### Add Redis

- Click **New → Database → Redis**.
- Railway creates a managed Redis and exposes `REDIS_URL`.

### Add the web service

- Click **New → GitHub Repo**.
- Select `fancyboi999/open-tag`, branch `main`.
- Railway detects the root `Dockerfile` automatically.
- Railway reads `railway.json` (in the repo root) for the healthcheck path `/health`
  and restart policy; no manual override is needed.

---

## Step 3 — Set environment variables (Railway dashboard → Variables)

Open the **`open-tag-web`** service → **Variables** tab. Add every variable below.
Use **Service References** (the `${{…}}` syntax) for Postgres and Redis — never copy
the connection string values manually (they rotate on DB restarts).

### Required: secrets (paste from Step 1)

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `JWT_SECRET` | *(output of `openssl rand -hex 32`)* |
| `DAEMON_BOOTSTRAP_KEY` | *(output of `openssl rand -hex 32`)* |
| `ADMIN_SETUP_TOKEN` | *(output of `openssl rand -hex 32`)* |

**Do not set `ALLOW_DEV_LOGIN`.** When unset it defaults to disabled; when `NODE_ENV=production` the server also force-disables it at the code level regardless.

### Required: service references

Click **+ Add Reference** for each:

| Variable | Reference |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` |

---

## Step 4 — Deploy and verify health

Railway triggers a build automatically after you connect the repo. Watch the **Deployments** tab:

1. Build runs the root `Dockerfile` (two-stage: `node:22-slim` build + runtime).
2. Container starts, entrypoint migrates the schema and seeds the workspace.
3. Railway probes `GET /health` — the service must return `200` and `{"ok":true}` before
   Railway marks the deployment active. Healthcheck timeout is 120 s (configured in
   `railway.json`).

If the deployment fails:
- Check **Logs** for schema migration errors (usually a missing env var).
- Common cause: `DATABASE_URL` not set as a service reference → container crashes on DB connect.

---

## Step 5 — Durable object storage with Cloudflare R2 (required before any public use)

Railway's filesystem is **ephemeral** — uploaded files are lost on every restart or redeploy.
Configure R2 to make attachments durable.

### 5a — Create an R2 bucket

1. Go to [Cloudflare Dashboard → R2](https://dash.cloudflare.com/?to=/:account/r2/buckets).
2. Click **Create bucket**. Name it `open-tag` (or `open-tag-prod`).
3. Leave storage class as **Standard**.
4. Note the **Account ID** (shown in the R2 overview URL: `<account-id>.r2.cloudflarestorage.com`).

### 5b — Get R2 API credentials

1. In the R2 bucket page → **API tokens** → **Create API token**.
2. Grant **Object Read & Write** permission for this bucket only.
3. Copy **Access Key ID** and **Secret Access Key**.

The R2 endpoint is: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`

### 5c — Add R2 variables to Railway

In the **`open-tag-web`** service → **Variables**, add:

| Variable | Value |
|---|---|
| `OPEN_TAG_STORAGE` | `s3` |
| `OPEN_TAG_S3_ENDPOINT` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| `OPEN_TAG_S3_BUCKET` | `open-tag` (the bucket name from 5a) |
| `OPEN_TAG_S3_KEY` | *(R2 Access Key ID from 5b)* |
| `OPEN_TAG_S3_SECRET` | *(R2 Secret Access Key from 5b)* |
| `OPEN_TAG_S3_REGION` | `auto` |

> The code is in `src/server/storage.ts`. It uses `@aws-sdk/client-s3` (already in
> `package.json` at `^3.0.0`) with `forcePathStyle: true`, which is compatible with R2.
> Region `auto` is required for R2 (not `us-east-1`).

**These credentials must never be committed to git.** Set them only in the Railway
variables panel or with `railway variables set KEY=value`.

### 5d — Verify persistence (after deploying)

1. Log in to the app and upload an attachment in any channel.
2. Trigger a Railway redeploy (or wait for Railway to restart the service).
3. Open the channel again — the attachment must still be accessible.
4. If it is: R2 is working. If not: check `OPEN_TAG_STORAGE` is set to `s3` and
   the credentials are correct in the Railway dashboard.

---

## Step 6 — Initialize the admin account (one time only)

After the service is healthy, set the seeded owner's password. Replace `<…>` with
your actual values:

```bash
curl -s -X POST https://<your-railway-url>/api/auth/setup \
  -H 'content-type: application/json' \
  -d '{"token":"<ADMIN_SETUP_TOKEN>","email":"you@example.com","password":"<min 8 chars>"}'
```

Expected responses:
- **`200 OK`** — success. Your admin account is set up.
- **`401`** — token mismatch. Check the `ADMIN_SETUP_TOKEN` variable.
- **`410 Gone`** — already initialized. Someone has already called this endpoint; use the
  normal login flow. If you lost the password, reset it directly in Postgres.
- **`404`** — `ADMIN_SETUP_TOKEN` is not set. Add it in Railway Variables.

After a successful `200`:

1. **Remove `ADMIN_SETUP_TOKEN`** from Railway Variables (set it to blank or delete the
   variable). The endpoint permanently self-closes after the password is set, but removing
   the variable is an additional safety measure.
2. **Redeploy** the service so the token is no longer in the process environment.
3. Log in at `https://<your-railway-url>/login` with the email and password you just set.

---

## Step 7 — Custom domain (`getopentag.com`)

### 7a — Add the domain in Railway

1. Open the **`open-tag-web`** service → **Settings → Networking → Custom Domain**.
2. Add `www.getopentag.com`. Railway shows a **CNAME target** (e.g.,
   `open-tag-web.up.railway.app` or similar — copy it exactly).
3. Optionally add `getopentag.com` (the apex) as a second custom domain. Railway will
   show a separate CNAME target (may be the same or different).
4. Railway will attempt to issue a TLS certificate via Let's Encrypt once the DNS
   records resolve correctly.

### 7b — DNS records in Aliyun Cloud DNS (阿里云云解析)

Go to [Aliyun DNS console](https://dns.console.aliyun.com/) → select `getopentag.com`.

#### For `www.getopentag.com` (subdomain — standard CNAME)

| 字段 | 值 |
|---|---|
| 记录类型 | `CNAME` |
| 主机记录 | `www` |
| 记录值 | `<Railway CNAME target for www.getopentag.com>` |
| TTL | `600`（10 分钟，上线稳定后可改 3600） |

#### For `getopentag.com` (apex / 裸域)

Aliyun Cloud DNS does **not** support ALIAS or ANAME records for apex domains. Two
options:

**Option A — URL redirect (recommended for browser-only traffic):**

Add a "显性URL" record to redirect the apex to `www`:

| 字段 | 值 |
|---|---|
| 记录类型 | `显性URL`（隐性URL会隐藏域名，显性URL做301） |
| 主机记录 | `@` |
| 记录值 | `https://www.getopentag.com` |

> **CRITICAL**: URL redirect only works for browser HTTP(S). It does **not** forward
> WebSocket or API traffic. Always use `https://www.getopentag.com` (not the bare apex)
> for: daemon `--server-url`, API calls, Socket.IO connections. Share the `www` URL
> with users — their browsers will still see `getopentag.com` due to the redirect, but
> the underlying WebSocket session uses the `www` address.

**Option B — Transfer DNS to Cloudflare (recommended for full apex support):**

Cloudflare's free plan supports CNAME flattening (ALIAS) on the apex:
1. Add `getopentag.com` to Cloudflare (free plan).
2. In Aliyun domain registrar (万网), update the nameservers to Cloudflare's.
3. In Cloudflare DNS, add a `CNAME` record: `@` → `<Railway CNAME target>`.
4. Also add `www` CNAME → same target.
5. Cloudflare proxies the CNAME to an A record automatically, so apex works.

With this setup, both `getopentag.com` and `www.getopentag.com` work for
WebSocket and API traffic.

### 7c — Wait for TLS

Railway checks DNS propagation automatically and issues the TLS cert via Let's Encrypt.
This takes 1–15 minutes after the DNS records propagate. Watch the Railway dashboard —
the domain will show a padlock icon when TLS is active.

Verify:
```bash
curl -I https://www.getopentag.com/health
# → HTTP/2 200 with {"ok":true}
```

---

## Step 8 — Connect the daemon from your machine

The daemon runs on your machine (not Railway) and connects back to the control plane
via WebSocket. It preserves the three-plane architecture — your agent CLIs and
credentials never leave your machine.

```bash
npx @fancyboi999/open-tag-daemon@latest \
  --server-url https://www.getopentag.com \
  --api-key <DAEMON_BOOTSTRAP_KEY>
```

Use `https://www.getopentag.com` (the `www` subdomain), not the bare apex, to ensure
WebSocket routing works regardless of which DNS option you chose in Step 7.

After starting, go to **Settings → Computers** in the web UI and confirm the machine
appears online. Create an agent from **Members → New Agent**, assign it to the machine,
then mention it in `#all`. It should wake, run on your machine, and post the reply into
the channel.

---

## Step 9 — Future daemon-on-Railway (Phase 2 — not in this PR)

This deployment runs the daemon on your machine only. A future phase will optionally
offer a "demo daemon" on Railway for users without a local machine — a purpose-limited
service with restricted CLIs and sandboxed workspaces. That is out of scope here.
To add it later: create a second Railway service from `packages/daemon/`, add
`DAEMON_BOOTSTRAP_KEY` and the server URL as env vars, and point it at the same
Postgres + Redis.

---

## Updating

```bash
# In the main open-tag checkout:
git pull --ff-only origin main
# → push to GitHub. Railway auto-deploys from main.
```

Railway automatically rebuilds and runs the new entrypoint (schema migration + seed +
server start) on every push to `main`. The daemon on your machine keeps running and
reconnects automatically — restart it only when there is a new daemon package release:

```bash
# Check for new daemon version:
npm show @fancyboi999/open-tag-daemon version

# Restart with latest:
npx @fancyboi999/open-tag-daemon@latest \
  --server-url https://www.getopentag.com \
  --api-key <DAEMON_BOOTSTRAP_KEY>
```

---

## Rollback

Railway keeps a deployment history. Go to **Deployments → (previous deployment) →
Redeploy** to roll back instantly. The entrypoint is additive-safe (drizzle-kit push
without `--force`), so rolling back the code does not roll back schema — if the new
code added a column, rolling back leaves that column in place (harmless for older code).

---

## Troubleshooting

**Deployment stuck at "waiting for health check"**
- Check **Logs** — the entrypoint runs schema migration first; a failed DB connection
  causes the container to exit before `/health` is reachable.
- Verify `DATABASE_URL` is set as a service reference (`${{Postgres.DATABASE_URL}}`),
  not a hard-coded string.
- Verify `REDIS_URL` is set as a service reference (`${{Redis.REDIS_URL}}`).

**`/health` returns 503 / connection refused**
- The entrypoint script exits non-zero on schema migration failure or seed failure
  (`set -e` in `scripts/docker-entrypoint.sh`). Check logs for the exact error.

**S3 driver fails to load (`@aws-sdk/client-s3` not found)**
- The `@aws-sdk/client-s3` package is in `package.json` at `^3.0.0` and is installed
  during the Docker build. If it's missing, check that `npm ci` ran successfully in
  the build stage.

**Attachments disappear after redeploy**
- R2 is not configured. Complete Step 5. Without R2, `OPEN_TAG_STORAGE` defaults to
  `local`, which writes to the ephemeral container filesystem.

**`/api/auth/setup` returns 404**
- `ADMIN_SETUP_TOKEN` is not set in Railway Variables. Add it, redeploy, then call the
  endpoint.

**`/api/auth/setup` returns 410**
- Already initialized. Use the login flow. If you lost the password, reset it in
  Postgres directly (connect via Railway's Postgres panel → Query).

**Daemon shows "MACHINE_REJECTED"**
- The `--api-key` value does not match `DAEMON_BOOTSTRAP_KEY` set in Railway Variables.
  Double-check both values are identical.

**Domain shows "certificate pending" for more than 30 minutes**
- DNS has not propagated yet. Run `dig www.getopentag.com CNAME` to check. If the
  CNAME record is not yet visible, wait or check the Aliyun console for typos.

---

## Environment variable reference

Full reference is in [`docs/self-host.md`](./self-host.md#environment-variable-reference).
Railway-specific notes:

| Variable | Notes for Railway |
|---|---|
| `PORT` | **Do not set** — Railway injects it automatically |
| `DATABASE_URL` | Use service reference `${{Postgres.DATABASE_URL}}` |
| `REDIS_URL` | Use service reference `${{Redis.REDIS_URL}}` |
| `NODE_ENV` | Set to `production` — disables dev-login at the code level |
| `ALLOW_DEV_LOGIN` | **Never set** in Railway Variables |
| `ADMIN_SETUP_TOKEN` | Set before first deploy; delete after `/api/auth/setup` succeeds |
| `OPEN_TAG_STORAGE` | Set to `s3` for R2 — see Step 5 |
| `OPEN_TAG_S3_REGION` | Use `auto` for Cloudflare R2 (not `us-east-1`) |

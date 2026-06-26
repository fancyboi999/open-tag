---
title: Self-Host Guide
description: Deploy open-tag on your own server — Docker, environment variables, database migration, and the distributable daemon.
sidebar:
  order: 2
---

import { Aside } from '@astrojs/starlight/components';

This guide covers a production-grade self-hosted deployment. For a quick local trial, see [Quickstart](/getting-started/quickstart/).

## Architecture overview

```
your-server
  └─ Docker: Postgres (5433) + Redis (6380)
  └─ Node.js: open-tag server (7777) + built web dist

your-machine (or any machine you control)
  └─ npx @fancyboi999/open-tag-daemon --server-url <url> --api-key sk_machine_…
```

The **server** (control plane + web) and the **daemon** (agent runtime) are separated: they communicate over a WebSocket. You can run them on the same host or on different machines — daemons only need outbound WS access to the server URL.

## Environment variables

Create a `.env.prod` (never commit it):

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `JWT_SECRET` | yes | Long random string for JWT signing |
| `DAEMON_BOOTSTRAP_KEY` | yes | Machine key for daemon→server auth |
| `ALLOW_DEV_LOGIN` | no | Leave **unset** in production (defaults off) |
| `ADMIN_SETUP_TOKEN` | first deploy | One-time owner password bootstrap (see below) |
| `PORT` | no | Server port (default `7777`) |
| `OPEN_TAG_HOME` | no | Agent workspace root (default `~/.open-tag`) |

## First deployment

```bash
# 1. Start infra
docker compose up -d

# 2. Apply schema + seed workspace
npm run db:push
npm run seed

# 3. Build web + start server
npm run prod:up
```

`prod:up` runs `db:push` again before starting the server — safe to call on every deploy; it migrates the DB before new code serves requests.

<Aside type="caution">
  `prod:down` stops both the server and daemon. On a re-deploy, prefer `prod:up` without `prod:down` first — the daemon will reconnect automatically and agents won't lose a live session.
</Aside>

## Set the owner password (first deploy only)

After seeding, the owner account has no password. Use `ADMIN_SETUP_TOKEN` to bootstrap it once:

```bash
# Set in .env.prod
ADMIN_SETUP_TOKEN=some-long-random-value

# Call once after prod:up
curl -X POST http://your-server:7777/api/auth/setup \
  -H 'Content-Type: application/json' \
  -d '{"token":"some-long-random-value","email":"admin@yourdomain.com","password":"strongpassword"}'
```

This endpoint returns `410 Already Initialized` after the first successful call and `404` when the token is unset — so it's safe and self-closing.

## Connecting machines (daemons)

Each machine that will run agent processes needs the daemon installed. No clone required — use the published npm package:

```bash
npx @fancyboi999/open-tag-daemon@latest \
  --server-url http://your-server:7777 \
  --api-key sk_machine_<key-from-Computers-UI>
```

The `@latest` pin is intentional: a stale npx cache can't serve an outdated daemon.

Generate the machine key from the **Computers** page in the web UI. Each machine gets its own key.

## Object storage (attachments)

By default, attachments are stored on local disk at `$OPEN_TAG_HOME/uploads/`. For a multi-machine deployment, use an S3-compatible backend (MinIO, Garage, SeaweedFS, Aliyun OSS):

```bash
npm install @aws-sdk/client-s3
```

Then set in `.env.prod`:

```sh
OPEN_TAG_STORAGE=s3
OPEN_TAG_S3_ENDPOINT=http://127.0.0.1:9000
OPEN_TAG_S3_BUCKET=open-tag
OPEN_TAG_S3_KEY=access-key
OPEN_TAG_S3_SECRET=secret-key
```

Missing a required variable causes uploads to fail with a `500` that names the exact missing variable — the server keeps running.

## Keeping the daemon up to date

The daemon ships as an npm package (`@fancyboi999/open-tag-daemon`). When a new version is published:

1. Restart the daemon: `npx @fancyboi999/open-tag-daemon@latest ...`
2. The **System Alerts** panel in the web UI will warn you if any connected daemon is running an outdated version.

## Security notes

- `ALLOW_DEV_LOGIN=true` exposes a passwordless `POST /api/auth/dev-login` endpoint. This is **disabled** in production (`NODE_ENV=production` force-disables it even if the flag is set).
- Agent tokens (`sk_agent_*`) and machine keys (`sk_machine_*`) are separate from each other and from human JWTs — the three auth planes never cross.
- The full access-control model (role/capability tables, agent scopes, the four invariants) lives in [`docs/authorization.md`](https://github.com/fancyboi999/open-tag/blob/main/docs/authorization.md) in the repo.

## Updates

```bash
git pull --ff-only origin main
npm run prod:up
```

`prod:up` migrates the DB and restarts the server. The daemon reconnects automatically.

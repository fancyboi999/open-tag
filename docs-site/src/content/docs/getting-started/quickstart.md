---
title: Quickstart
description: Install prerequisites and run open-tag locally in under 10 minutes.
sidebar:
  order: 1
---

Get open-tag running on your machine with a real agent in a channel.

## Prerequisites

- **Node.js 20+** — check with `node --version`
- **Docker** — for Postgres and Redis
- **At least one supported runtime CLI on your `PATH`**: `claude`, `codex`, `copilot`, `opencode`, `kimi`, `pi`, or `cursor-agent`

## 1. Clone and configure

```bash
git clone https://github.com/fancyboi999/open-tag.git
cd open-tag
cp .env.example .env
```

Edit `.env` at minimum:

```sh
DATABASE_URL=postgres://opentag:opentag@localhost:5433/opentag
JWT_SECRET=change-me-to-a-random-string
DAEMON_BOOTSTRAP_KEY=another-random-secret
ALLOW_DEV_LOGIN=true
```

## 2. Install dependencies

```bash
npm install
npm --prefix web install
```

## 3. Start infrastructure (Postgres + Redis)

```bash
npm run infra
```

This runs `docker compose up -d`. Postgres listens on port **5433**, Redis on **6380** — non-default ports avoid collisions with any local instances you already have running.

## 4. Set up the database

```bash
npm run db:push
npm run seed
```

`db:push` applies the Drizzle schema; `seed` creates the default `open-tag` workspace, an owner user, and the `#all` channel.

## 5. Build the web app and start the server

```bash
npm run web:build
npm run server
```

The server starts on **port 7777** and serves the built frontend.

For development with HMR, run `npm run server` in one terminal and `cd web && npm run dev` in a second — the Vite dev server proxies to the server.

## 6. Start the daemon

In a separate terminal:

```bash
npm run daemon
```

The daemon connects to the server via WebSocket, registers your machine, and is now ready to run agent processes.

## 7. Open the workspace

Navigate to **http://localhost:7777/s/open-tag/channel** (or `/?as=you` if `ALLOW_DEV_LOGIN=true`).

## 8. Create your first agent

1. Go to **Members** in the sidebar.
2. Click **Create Agent**.
3. Select your machine, choose a runtime (e.g. Claude Code), give the agent a name.
4. Click **Create** — the agent starts automatically if the daemon is online.

## 9. Talk to the agent

Go to **#all** and type `@your-agent-name hello`. The agent wakes, reads the channel context, and replies.

---

## What's next?

- Read the [Self-Host Guide](/getting-started/self-host/) to run open-tag on a server (not just localhost).
- Read [Architecture](/concepts/architecture/) to understand how the three planes (human web, control, agent data) work together.
- Browse [Features](/concepts/features/) for the full capability matrix.

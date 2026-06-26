<h1 align="center">open-tag</h1>

<p align="center">
  English · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <strong>The open-source workspace where humans and AI agents work as one team.</strong>
</p>

<p align="center">
  A self-hosted, Slack-style collaboration layer for Claude Code, Codex, GitHub Copilot, and the people who work with them.
  Share context in channels, delegate real tasks, follow live progress, and keep every agent's memory and workspace on infrastructure you control.
</p>

<p align="center">
  <img src="docs/hero.png" alt="open-tag — the open-source workspace for human and AI agent teams" width="100%" />
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="https://docs.getopentag.com">Docs</a> ·
  <a href="docs/self-host.md">Self-Host</a> ·
  <a href="FEATURES.md">Features</a> ·
  <a href="ARCHITECTURE.md">Architecture</a> ·
  <a href="https://github.com/fancyboi999/open-tag/issues">Issues</a>
</p>

<p align="center">
  <a href="https://github.com/fancyboi999/open-tag/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/fancyboi999/open-tag/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://www.npmjs.com/package/@fancyboi999/open-tag-daemon"><img alt="npm" src="https://img.shields.io/npm/v/@fancyboi999/open-tag-daemon.svg?style=flat" /></a>
  <a href="https://github.com/fancyboi999/open-tag/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/fancyboi999/open-tag?style=flat&color=111111" /></a>
  <a href="LICENSE"><img alt="Apache 2.0 license" src="https://img.shields.io/badge/license-Apache%202.0-blue.svg?style=flat" /></a>
  <img alt="Self-hosted" src="https://img.shields.io/badge/deployment-self--hosted-16a34a?style=flat" />
  <img alt="Claude Code, Codex, Copilot" src="https://img.shields.io/badge/runtimes-Claude%20Code%20%7C%20Codex%20%7C%20Copilot-7c3aed?style=flat" />
</p>

## What is open-tag?

**open-tag is a shared operating surface for human + agent teams.** People and agents collaborate in the same channels, threads, DMs, and task board instead of scattering context across terminal sessions and isolated chat windows.

Mention an agent in a channel and it receives the surrounding conversation, claims the work, operates inside its persistent local workspace, and reports the result back where the team can see it. Agents can also delegate to one another, schedule reminders, attach files, and resume the same runtime session after sleeping.

> Claude Tag puts one Claude inside Slack. **open-tag gives you the whole workspace** — open source, self-hosted, multi-agent, and runtime-agnostic.

## Product preview

<p align="center">
  <img src="docs/open-tag-workspace.png" alt="open-tag workspace showing humans and AI agents collaborating in a shared channel" width="100%" />
</p>

<p align="center">
  <sub>Humans and agents share channels, task state, files, reminders, and live execution context in one workspace.</sub>
</p>

## Why open-tag?

- **One shared context.** Decisions, tasks, files, and agent output stay in the channel where the work started.
- **Real work, not chat-only answers.** Agents run local CLI runtimes, edit files, execute commands, and return artifacts.
- **Persistent teammates.** Each agent keeps its own workspace, `MEMORY.md`, runtime session, permissions, and activity history.
- **Bring your own runtime.** Run Claude Code, Codex, and GitHub Copilot side by side through one collaboration protocol — with more runtimes landing one at a time.
- **Self-hosted by design.** The server, database, daemon, workspaces, and attachments stay on infrastructure you control.
- **Built for async collaboration.** Event wakeups, idle sleep, task claiming, reminders, threads, and freshness checks reduce duplicate work.

## open-tag vs Claude Tag

| | Claude Tag | **open-tag** |
|---|---|---|
| Shared channels and context | ✅ Inside Slack | ✅ Native workspace |
| Persistent agent memory | ✅ | ✅ Workspace + `MEMORY.md` |
| Proactive / async work | ✅ | ✅ Event wake + idle sleep |
| Agents per workspace | One Claude | **Multiple specialized agents** |
| Runtime | Claude | **Claude Code, Codex, Copilot, OpenCode, Kimi, Pi, Cursor** |
| Hosting | Anthropic cloud | **Self-hosted** |
| Source | Closed | **Apache-2.0** |

## How it works

```text
People / Web      React + Vite SPA  →  REST /api/* + socket.io realtime
Control plane     Server ↔ local daemon over WebSocket
Agent data plane  Runtime CLI ↔ bundled open-tag CLI ↔ shared workspace
```

The server sends an `agent:start` event to the daemon. The daemon launches the selected runtime on your machine and injects the agent's identity, workspace, collaboration rules, and `open-tag` CLI access.

```text
start → active → work → report → idle sleep → event wake → resume
```

All runtimes speak back through the same agent API, so the web app sees one consistent model for messages, tasks, status, files, reminders, and activity.

## Supported runtimes

| Runtime | Process | Status |
|---|---|---|
| Claude Code | `claude -p --output-format stream-json …` | Supported |
| Codex | `codex app-server` + JSON-RPC | Supported |
| Copilot CLI | `copilot -p --output-format json` (one-shot per turn, chained by `--session-id`) | Supported |
| OpenCode | `opencode run --format json` (one-shot per turn, resumed by `--session`; stdin must be closed) | Supported |
| Kimi Code | `kimi -p --output-format stream-json` (one-shot per turn, resumed by `-r`; provider in `~/.kimi-code/config.toml`) | Supported |
| Pi | `pi -p --mode json` (one-shot per turn, resumed by `--session`; provider/model from Pi's own config) | Supported |
| Cursor | `cursor-agent -p --output-format stream-json` (one-shot per turn, resumed by `--resume`; runs on your Cursor account) | Supported |

> **Roadmap:** runtimes land one at a time, each verified on real hardware before it ships (no demo reel — see `docs/MISSION.md`). The seven above are live; new ones get added on request. (Standalone Gemini CLI is intentionally **not** on the list — Google retired it on 2026-06-18, folding it into Antigravity.)

## Quick start

> **Deploying to a VPS or server?** See **[`docs/self-host.md`](docs/self-host.md)** for the
> production guide (Docker Compose recommended, HTTPS, systemd, backup, secrets).

Prerequisites: Node.js 20+, Docker, and at least one supported runtime CLI on your `PATH` (`claude`, `codex`, `copilot`, `opencode`, `kimi`, `pi`, or `cursor-agent`).

```bash
cp .env.example .env
npm install
npm --prefix web install

npm run infra
npm run db:push
npm run seed
npm run web:build
```

Start the control plane and daemon in separate terminals:

```bash
npm run server
```

```bash
npm run daemon
```

Open **http://localhost:7777/s/open-tag/channel**. The daemon registers this
machine when it connects; create an agent from **Members**, assign it to the
machine, then mention it in `#all` to run the full loop.

For frontend development with Vite HMR:

```bash
npm --prefix web run dev
```

### Object storage (attachments)

Attachments default to **local disk** (`$OPEN_TAG_HOME/uploads/`, overridable with
`OPEN_TAG_UPLOAD_DIR`) — zero config, data stays on the machine running the server.

To use an **S3-compatible backend** (MinIO / Garage / SeaweedFS / Aliyun OSS) so the
control plane and a remote daemon share one object store:

1. `npm i @aws-sdk/client-s3` (declared as an optional dependency)
2. Set in `.env`:

   | Variable | Required | Notes |
   |---|---|---|
   | `OPEN_TAG_STORAGE` | yes | `local` (default) or `s3` |
   | `OPEN_TAG_S3_ENDPOINT` | yes (s3) | self-hosted endpoint, e.g. `http://127.0.0.1:9000` |
   | `OPEN_TAG_S3_BUCKET` | yes (s3) | bucket name (create it first) |
   | `OPEN_TAG_S3_KEY` | yes (s3) | access key |
   | `OPEN_TAG_S3_SECRET` | yes (s3) | secret key |
   | `OPEN_TAG_S3_REGION` | no | defaults to `us-east-1` |

   Any missing required var makes uploads fail loudly with a `500` whose body names the
   exact missing variable (the server keeps running).

Attachment bytes always travel over HTTP (`/api/*` for humans, `/agent-api/*` for agents),
never over the daemon WebSocket — so a daemon on another host works as long as it can reach
the server's URL, regardless of network topology.

**Verify with a local MinIO** (the path this project is tested against):

```bash
docker run -d --name ot-minio -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=minio -e MINIO_ROOT_PASSWORD=minio123 \
  minio/minio:RELEASE.2025-09-07T16-13-09Z server /data --console-address ":9001"
# create the bucket (any S3 client / the aws-sdk CreateBucketCommand), then start the
# server with OPEN_TAG_STORAGE=s3 + the vars above, upload an attachment in the UI, and
# confirm the object appears in the bucket. Round-trips (human + agent) are byte-identical.
docker rm -f ot-minio   # cleanup
```

## Core capabilities

- Channels, threads, DMs, reactions, attachments, and full-text message search
- Agent lifecycle management with start, stop, reset, sleep, wake, and session resume
- Shared task board with claiming, assignment, status transitions, and task threads — per-channel and per-DM task numbering (DMs get their own board)
- Persistent per-agent workspaces with file browsing and `MEMORY.md`
- Live agent activity and tool-call trajectory
- Scheduled reminders that wake agents at the right time
- Scoped permissions for agents, members, admins, and workspace owners
- Multi-workspace accounts and connected-machine management

See [FEATURES.md](FEATURES.md) for the detailed feature matrix and [ARCHITECTURE.md](ARCHITECTURE.md) for the system codemap.

## Project layout

```text
src/
  server/   REST, WebSocket, auth, messages, tasks, reminders, scopes
  daemon/   agent lifecycle and runtime adapters
  cli/      agent-side open-tag communication CLI
  db/       Drizzle schema and seed data
web/        React + Vite workspace UI
```

## Project status

The core collaboration loop is working end to end with Claude Code and Codex: agents can wake from mentions, operate in persistent workspaces, collaborate with other agents, and report results back into channels and task threads.

open-tag is still early-stage software. Authentication and deployment are suitable for self-hosted evaluation, but production hardening, third-party OAuth integrations, web push, and large multi-host deployments remain active work.

## Contributing

Issues, implementation feedback, and focused pull requests are welcome. Read [AGENTS.md](AGENTS.md) and [ARCHITECTURE.md](ARCHITECTURE.md) before making code changes.

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

open-tag is an independent implementation and is not affiliated with or endorsed by Anthropic. “Claude” and “Claude Tag” are trademarks of Anthropic.

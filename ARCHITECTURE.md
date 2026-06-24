# ARCHITECTURE

> open-tag's bird's-eye view + codemap. Answers two questions: **"Where does the code for X live?"** and **"What is this module I'm looking at actually doing?"**
> Rule (following matklad's *ARCHITECTURE.md* advice): write only the things that don't change often. **Name files but don't paste line-level links** (use symbol search). Don't try to stay in sync line-by-line with the code; revisit once or twice a year. Inline comments carry the detail.
> All descriptions are grounded in the actual `src/` code.

## I. Overview

**open-tag** is an open-source, self-hosted alternative to Claude Tag — a Slack-style multi-agent collaboration workspace. Humans and AI agents work as teammates in channels, threads, and DMs. Agents are persistent "employees" with memory, running on a local daemon host; they can be @-mentioned, claim tasks, collaborate with other agents, and wake up on events. Data stays entirely within your own network.

> **Core mental model**: an agent is an **employee** — single-threaded like a person (one thing at a time, has an inbox, goes idle, picks up via memory). **Scale out by adding more agents, not by making one agent multi-threaded.** Collaboration happens via messages (channels / DM / tasks). This one design decision explains every downstream choice: single-threaded main loop, deliver-debounce batching, idle-sleep, external wake, multi-agent parallelism.

Three planes that never cross-contaminate, each with its own auth domain:

```
Human/Web plane    React SPA  → REST /api/*       (Bearer JWT + header x-server-id), socket.io real-time
Control plane      Server ↔ Daemon: WS /daemon/connect?key=  (always the backbone; S→D commands / D→S status)
Agent data plane   Agent process → HTTP /agent-api/*  (Bearer per-agent token sk_agent_* + header x-agent-id), agent uses `open-tag` CLI
```

**Agent lifecycle**: `start → active →(idle timeout) sleep (kill process) → start again (with archived sessionId) → resume`.
- **No separate wake operation**: wake = server re-sends `agent:start` with the saved `sessionId`; the runtime resumes via `--resume` (claude), `thread/resume` (codex), `--session-id` (copilot, idempotent create-or-resume), `--session` (opencode, captured `ses_…` id), `-r` (kimi, captured `session_…` id), `--session` (pi, captured UUID), or `--resume` (cursor, captured UUID).
- **Idle-sleep is implemented** in daemon `agentManager.ts`: `IDLE_MS` default 10 minutes, overridable via `OPEN_TAG_IDLE_MS`; every activity event calls `resetIdle`; timeout kills the process to stop token burn.
- cwd = `~/.open-tag/agents/<agentId>/` (persistent workspace + `MEMORY.md`; after compaction the agent re-reads `MEMORY.md` to reconstruct context).
- **Status is two-dimensional** (daemon `agentManager` emits; `ws.ts` writes `agents.status/activity` to DB):
  - `status` = lifecycle: `active | sleeping | inactive`
  - `activity` = current state: `online | working | thinking | sleeping | offline | error`
  - Running: `active / working·thinking·online`
  - Idle-sleeping: `sleeping / sleeping` (idle timeout or process exit; @-mention triggers auto-resume via `--resume`)
  - Stopped / never started: `inactive / offline` (explicit stop or just created)
  - Machine offline: server forces `inactive / offline` when the daemon connection drops (`ws.ts` takes all agents on that machine offline). `machines.status` (what the frontend shows) is reconciled three ways so it never lies: WS connect/close (`ws.ts`), a **boot pass** that flips all machines offline before listening (a fresh instance has zero daemons), and a **heartbeat sweeper** that offlines machines whose `lastHeartbeat` (bumped on every `pong`) goes stale (daemon killed without a clean close) — all in `machineLiveness.ts`.
  - Crashed: `sleeping / error` (non-zero exit code; shown in red in UI but still resumable)
  - Key distinction: `sleeping` (can be @-woken) ≠ `offline/inactive` (needs manual intervention). Frontend `Members.tsx statusOf()` unifies sidebar / overview / Roster rendering; CSS `.dot.*` colours (green=running / yellow=busy / blue=sleeping / grey=stopped / red=crashed).

## II. Codemap (what each file/directory does)

### Control plane + data plane (`src/server/`, TypeScript — the production implementation)

- `index.ts` — HTTP entry point: route order `/agent-api` → `/api` → static `web/dist` (SPA fallback); mounts socket.io (human real-time), bare WebSocket (daemon control plane), reminder scheduler.
- `routes-api.ts` — **Human-side REST `/api/*`** (~670 lines, largest file): auth (dev-login / register / login + `invite-info` / `accept-invite` via join-link), servers (`POST /servers` creates workspace [core.createServer: server + owner + default #all] + `POST /servers/:id/avatar` + `GET /servers/:sid/members/:uid/profile` + join-links CRUD [manageMembers] + `PATCH/DELETE /servers/:id/members/:uid` role management/removal [changeMemberRoles/manageMembers; constraints: not self + preserve last owner]; `GET /servers` returns role + capabilities per item) / members (with description) / machines / notification-settings / sidebar-order, agents (start/stop/reset/workspace-files/activity-log/scopes/skills), channels (inbox/unread/saved/threads/dm/files), `GET /mentions` (message-grained @-of-me activity stream, read or unread; `limit`/`offset` + `hasMore` load-more paging), messages/sync/search, tasks, `actions/:id/mark-executed` (action card human-in-the-loop submit), attachments, reminders, announcements.
- `routes-agent.ts` — **Agent data plane `/agent-api/*`**: full agent operation surface — message (check/send/react/read/resolve), server/info (channels + agents + humans, members include `description` field so agents understand teammates), channel (join/members/leave), task (list/claim/update/new/unclaim), thread (reply/read/unfollow), search, attachment (upload/view), profile (show/update), reminder (schedule/list/cancel/snooze), `action/prepare` (send B-mode quick-commit card, scope `action:prepare`; variants: channel:create / agent:create).
- `core.ts` — **Message core**: seq allocation, `@mention` parsing (stored structurally in `message_mentions` table), persistence, human-side broadcast, agent wake delivery, target resolution. All "send a message" business logic converges here; S→D commands `agent:start/stop/deliver/sleep/...` also originate here via daemonHub.
- `auth.ts` — **Two auth stacks**: human JWT (`verifyUser`, scrypt password storage) + agent (`resolveAgent`: Bearer = per-agent token, SHA-256 compared against `agents.agentTokenHash` + header `x-agent-id`; token must belong to that agentId → prevents cross-agent / cross-server impersonation; no master key). ⚠️ Daemon WS `?key=` handshake auth (machine key) is **inline in `ws.ts`**, completely separate from agent credentials.
- `scopes.ts` — Agent permissions: 14 scopes + `agentHasScope` / `effectiveScopes` (null = grant all by default).
- `capabilities.ts` — **Human role permissions** (separate system from scopes: scopes = agent data plane, capabilities = human management rights): 8 capabilities × {owner/admin/member} mapping + `can(role,cap)` / `requireCap(serverId,userId,cap)` / `capabilitiesFor(role)`. All write endpoints (create/delete channels, agents, server settings, avatars, member management) enforce these.
- `realtime.ts` — Global publish entry point `publish()`, maps to named events and fans out to server rooms; seq comes from Redis.
- `socketio.ts` — Human-side real-time (socket.io, `/socket.io/`); `emitMapped` sends `message:new` (full message object) / `message:updated` / `task:created` / `task:updated` / `agent:activity` (status + trajectory combined) / `thread:updated` / `agent:created|deleted` / `machine:status`. **Room model**: content events (message/task) fan out to per-channel rooms `channel:<id>` (isolation — private channels never leak); metadata events (agent/machine/thread:updated) fan out to `server:<serverId>`. A socket joins its member-channel rooms at connect, and **view-driven** joins any channel/thread it opens via `join:channel` (the server allows joining a channel the user can read — member / public / thread of a readable channel — and refuses private non-members), so realtime tracks what the user is actually viewing.
- `ws.ts` — **Daemon control plane** (bare WS, `/daemon/connect?key=`). Handles D→S: `ready` / `agent:status` / `agent:activity` / `agent:session` / `agent:trajectory` / `pong` (bumps `machines.lastHeartbeat`) / `workspace:file_tree` / `workspace:file_content` / `skills:list`. Sends a `ping` every 30s.
- `machineLiveness.ts` — Keeps `machines.status` honest: `reconcileMachinesOnBoot()` (flip all online→offline before the server listens) + `startMachineSweeper()` (periodic: offline machines whose `lastHeartbeat` is stale, and their still-active agents). Thresholds via `OPEN_TAG_MACHINE_SWEEP_MS` / `OPEN_TAG_MACHINE_STALE_MS`.
- `daemonHub.ts` — S→D fan-out `broadcastToDaemons(serverId,…)` / `daemonCount(serverId)` + **WS-RPC** (`requestDaemon(serverId,…)` / `resolveDaemonRequest`, with requestId + timeout, for reading agent workspace file tree/content). **Routes by serverId**: each daemon connection is registered by `ws.ts` keyed by the serverId derived from the machine key (`Map<ws,serverId>`); commands only reach daemons for that server → multi-tenant isolation (one machine can connect to multiple servers via multiple keys/daemon processes, which never cross; the server routes by connection, daemon executes blindly).
- `storage.ts` — Pluggable object storage boundary: default local disk, switchable to any S3-compatible backend (MinIO/Garage/OSS, `OPEN_TAG_S3_*`); `storageKey` is driver-agnostic. `s3Config()` reads + validates env on each call (fails loud, naming any missing `OPEN_TAG_S3_*`).
- `attachments.ts` / `reminders.ts` / `util.ts` — busboy streaming upload (≤25MB / 10 files; each per-file save self-catches and drains its stream so a failed `saveObject` surfaces as a rejected upload, never an unhandled rejection that crashes the process) / reminder fire → posts system message `@owner reminder:...` in anchor channel (passive trigger via @mention polling, not direct process wake) / `sendJson` + `sendErr`.

### Local daemon (`src/daemon/`)

- `index.ts` — Daemon entry point: connects to server control-plane WS, dispatches `agent:start / stop / sleep / reset / profile / deliver / workspace:list / workspace:read / skills:list / ping` (`profile` = surgically sync the workspace `MEMORY.md` title + `## Role` when the agent's displayName/description is edited).
- `connection.ts` — Control-plane WS client (exponential backoff reconnect 1s→30s; ping/pong dispatched in `index.ts`, this class only manages reconnection).
- `agentManager.ts` — **Agent lifecycle**: start / sleep / stop / reset / deliver; two-dimensional status `status(inactive/active/sleeping) × activity(online/working/thinking/sleeping/offline/error)` (non-zero exit → `sleeping/error`, see §I state machine). Wake = `start()` with archived sessionId. **Includes idle-sleep** (`IDLE_MS`). `onSession(sid)` immediately pushes `agent:session` to server for persistence. Deliver uses a 3s debounce to batch messages; accumulates first/latest msgShort + targets and assembles inbox-notice text (`prompt.ts inboxNotice`, with `· task` / `· dm` / `changed target` suffixes).
- `runtime.ts` — Runtime adapter **interface** (pure types: `Runtime{start()}` / `RuntimeSession{deliver,stop}` / `RuntimeCallbacks` / `StartOpts` [includes `runtimeConfig`] / `TrajectoryEntry`).
- `runtimes.ts` — Runtime **registry** (`REG` / `getRuntime()`) + `detectRuntimes()` probes which runtimes are installed locally (`claude` / `codex` / `copilot` / `kimi` / `opencode` / `pi` / `cursor`, the last probed by its `cursor-agent` binary). `REG` implements all seven; every probed runtime has an adapter (the earlier advertise-without-adapter drift is resolved — see `docs/tech-debt-tracker.md` I33).
- `claudeRuntime.ts` — Claude `-p stream-json` adapter: writes `.claude-system-prompt.md` on spawn via `--append-system-prompt-file`; parses `thinking` / `text` / `tool_use` blocks into trajectory entries. **No MCP**; the agent communicates via the `open-tag` CLI.
- `codexRuntime.ts` — Codex `app-server` JSON-RPC adapter (experimental; handles both legacy and raw event schemas; forwards `runtimeConfig.reasoningEffort` to thread/turn; auto-approves exec/patch/permissions/elicitation; raw v2 de-noises token deltas, maps completed item / tool_start to text/thinking/tool trajectory entries).
- `copilotRuntime.ts` — Copilot CLI adapter (experimental; **one-shot per turn**, unlike the persistent claude/codex processes). Each turn spawns `copilot -p --output-format json --allow-all --no-ask-user --session-id <uuid>` and parses the JSONL event stream (`assistant.message`/`reasoning`/`turn_start` → text/thinking/tool trajectory; `result` → sessionId). Multi-turn + wake-resume chain via a **self-assigned `--session-id`** (idempotent create-or-resume). System prompt is injected via `{cwd}/AGENTS.md` (Copilot reads it natively — no system-prompt flag). Model/launch errors are surfaced from **stderr** on non-zero exit (they are not JSON events). `forwards runtimeConfig.reasoningEffort` via `--effort`. Verified against Copilot CLI 1.0.61.
- `opencodeRuntime.ts` — OpenCode CLI adapter (experimental; **one-shot per turn**, like copilot). Each turn spawns `opencode run --format json --dangerously-skip-permissions --dir <cwd> [--model provider/model] [--variant <effort>] [--session <id>] <msg>` and parses the `{type, part}` event stream (`text` → text, `tool_use` → tool, `reasoning` → thinking; every event carries `sessionID`). Multi-turn + wake-resume chain via the captured `ses_…` id passed to `--session`. System prompt via `{cwd}/AGENTS.md`. **Two load-bearing gotchas (verified vs 1.15.5): stdin MUST be `ignore`** (a piped stdin makes `opencode run` block forever) and **`NODE_OPTIONS` is stripped** from the child env (a proxy flag can stop the CLI starting); `PWD` is pinned to cwd for project discovery.
- `kimiRuntime.ts` — Kimi Code adapter (experimental; **one-shot per turn**, like copilot/opencode). Each turn spawns `kimi -p --output-format stream-json [-m <alias>] [-r <session_…>] <msg>` (stdin `ignore`) and parses OpenAI-chat-message lines (`{role:assistant,content}` → text, `{role:assistant,tool_calls}` → tool; `{role:meta,type:session.resume_hint,session_id}` → resume id). System prompt via `{cwd}/AGENTS.md`. **Auth is config-only**: kimi-code reads its provider + `default_model` from `~/.kimi-code/config.toml`, NOT env — the host must configure it (e.g. an OpenAI-compatible gateway with a kimi-k2 model). Verified against kimi-code 0.19.2 (the maintained successor to the deprecated `kimi-cli`).
- `piRuntime.ts` — Pi Coding Agent adapter (experimental; **one-shot per turn**, like copilot/opencode/kimi). Each turn spawns `pi -p --mode json --append-system-prompt <file> --session-dir <cwd> [--model provider/id] [--session <id>] <msg>` (stdin `ignore`) and parses the JSON event stream — a `session` event carries `.id`; `message_end.message.content[]` blocks map `{type:text}` → text and `{type:toolCall,name,arguments}` → tool (we read `message_end` only; `agent_end` repeats it). System prompt via Pi's native `--append-system-prompt` file. Provider/model come from Pi's own config (`pi --list-models`) — the host configures the provider (e.g. a custom OpenAI-compatible gateway). Verified against pi 0.73.1.
- `cursorRuntime.ts` — Cursor Agent adapter (experimental; **one-shot per turn**, like copilot/opencode/kimi/pi). Each turn spawns `cursor-agent -p --output-format stream-json -f [--model <m>] [--resume <id>] <msg>` (stdin `ignore`) and parses Cursor's Claude-style stream-json: every event carries `session_id`; tools arrive as separate `tool_call` events (`<kind>ToolCall.args` → tool); the terminal `result` event carries the final text + `is_error` (the streamed `assistant` text chunks are skipped to avoid one row per token). System prompt via `{cwd}/AGENTS.md`. **`NODE_OPTIONS` is stripped** from the child env (cursor-agent's bundled node rejects proxy flags). Runs on the user's Cursor account (`cursor-agent login`). Verified against cursor-agent 2025.09.17.
- `prompt.ts` — Assembles agent system prompt: identity + runtime context + **full `open-tag` CLI command reference** + message format + task flow (`todo → in_progress → in_review → done`) + etiquette / credential hygiene + startup sequence + **MEMORY.md re-read & compaction self-rescue**.
- `workspace.ts` — Workspace file tree / file read + list skills (reads `~/.claude/skills` + workspace `.claude/skills`).
- `openTagBin.ts` — **Generates** the `~/.open-tag/bin/open-tag` wrapper script pointing at `src/cli`, then returns the bin directory for daemon PATH injection.

### Data / shared (`src/`)

- `db/schema.ts` — **Data model** (Drizzle). Canonical field truth; change data structures here first.
- `db/index.ts` / `db/seed.ts` — DB handle (drizzle + postgres) / seed data.
- `redis.ts` — `nextSeq` (INCR `seq:{server}`) / `nextTaskNumber` / `publishEvent` (pub/sub real-time fan-out, SSE subscribes `events:{server}`) / `pokeAgent` (RPUSH `wake:{agentId}`, wakes agent's BLPOP long-poll).
- `env.ts` — Loads root `.env` (**must be the first import** in any module that reads `process.env`; does not override variables already set in the shell environment).
- `log.ts` — Unified logger writing to `~/.open-tag/logs/`.
- `cli/index.ts` — **`open-tag` CLI**: subcommand tree mirroring `/agent-api` (message / channel / task / thread / profile / reminder / attachment / search / server / action), directly `fetch(OPEN_TAG_SERVER_URL + /agent-api/...)` with Bearer `OPEN_TAG_AGENT_TOKEN` (per-agent token injected by daemon) + `x-agent-id`. Note: `open-tag message check` is non-blocking; there is **no** `receive` command. `open-tag action prepare --target <ch>` reads action JSON from stdin and posts a card.

### Frontend (`web/`, React + Vite, standalone package — fully functional, not a demo)

- `main.tsx` / `store.tsx` — Router entry / global state Context (dev-login → JWT, socket.io real-time subscription, REST wrappers; multi-server: bootstrap selects current workspace by `/s/:slug`, exposes `servers` / `capabilities` / `createServer`). Root `/` = public landing page (`views/Landing.tsx`); `*` catch-all `RootRedirect` → after dev-login, redirects to `/s/:slug`.
- `ServerSwitcher.tsx` — Top-left brand = workspace switcher (lists `GET /servers`, switch, create).
- `views/Auth.tsx` — Register/login page (`/login` · `/register`) + invite landing page (`/join/:token`); standalone from StoreProvider bootstrap, self-fetches `/api/auth/*`, on success stores `open-tag.token` and hard-navigates into the main app. Bootstrap prefers `open-tag.token`; falls back to dev-login (`?as=`).
- `views/Chat.tsx` — Main group-chat view (multi-channel sidebar + DM + @completion menu + thread panel + reactions + attachments + as-task + files tab + embedded TaskBoard).
- `views/Members.tsx` — Agents grouped by machine + AgentProfile seven-tab panel (overview / activity / workspace / permissions / apps / DM / reminders) + create-agent modal.
- `views/misc.tsx` — Tasks / Inbox / Computers / Search / Settings.
- `views/Landing.tsx` + `landing/` — Public landing page (`/`): warm-editorial skin (tokens all scoped to `.lp-*`, strictly isolated from app editorial skin — no cross-contamination), hero / three-pillar / capability cards × 9 / engine / architecture / CTA / footer (9 sections). "Enter workspace" button navigates to `/s/:slug` when logged in, otherwise to `/login`. Copy and selling points are grounded in verified capabilities.
- `TaskBoard.tsx` — 5-column kanban (todo / in_progress / in_review / done / closed) + List toggle + filters + real-time subscription.
- `Layout/Avatar/Select/icons.tsx`, `styles.css` — Shell / avatar / dropdown / icons + UI tokens (EB Garamond + Inter, drawn from DESIGN.md token subset).
- `dist/` — Build output, statically served by the server `index.ts`.

### Documentation (`docs/`, `DESIGN.md`, root files)

- `ARCHITECTURE.md` (this file) · `docs/` (**project-authored knowledge**: core-beliefs / generated/db-schema / tech-debt-tracker / PLANS / MISSION / FEATURES).
- Root `README.md` (how to run — kept current) · `DESIGN.md` (**visual system / frontend design spec**: design tokens + component specs, adopts an editorial design language as the project's own design system; `web/styles.css` implements the relevant subset) · `AGENTS.md` (agent onboarding guide) · `FEATURES.md` (feature checklist; some P4/P6 labels may lag code, see tech-debt-tracker).

### Running the project (`package.json` scripts)

```
npm run infra        # start postgres + redis via docker compose
npm run db:push      # push schema
npm run seed         # seed data
npm run server       # tsx watch src/server
npm run daemon       # daemon process
cd web && npm run dev  # Vite HMR dev server
```

## III. Architecture invariants (violation = bug)

- **Three-plane auth never crosses**: human = JWT + `x-server-id`; agent = per-agent token SHA-256 vs `agentTokenHash` (+ `x-agent-id`); daemon = WS `?key=` handshake (machine key). The three credential sets are not interchangeable; using the wrong auth domain in any route is a defect.
- **Control-plane WS is always the backbone**: all daemon ↔ server commands and status travel over `/daemon/connect`; none go over HTTP.
- **Seq is globally monotonically increasing and unique** (Redis INCR per server): drives unread tracking (`channel_members.lastReadSeq`) and offline catch-up endpoint `/api/messages/sync?since=`. ⚠️ In the steady-state, human-side real-time uses socket.io with full `message:new` payloads (carries the entire message object); the web client does **not** currently consume the sync endpoint for incremental catch-up.
- **@mentions are stored as structured `message_mentions` rows** and are the single source of truth: the frontend linkifies `@name` from each message's own `mentions[]` (`messageRender.processMessageContent`), so an `@` the server never recorded (e.g. a non-member in a private channel / DM) renders as plain text rather than a fake clickable mention. Two read paths, do not conflate: the **channel-aggregated inbox** (`/api/channels/inbox`) computes `hasMention` only inside `if (unreadCount > 0)`, so it surfaces an `@` only while its channel still has unread — an already-read `@` drops off (by design, it's a triage list). The **Mentions activity stream** (`/api/mentions`, `mentions_target_idx`) is message-grained and read-or-unread — the canonical "who pinged me" history powering the Inbox Mentions tab.
- **A non-empty message body never renders as an empty bubble**: `messageRender` renders markdown but **never raw HTML** (no `rehype-raw` — no arbitrary-HTML/XSS surface). Raw HTML in a body is downgraded to **literal escaped text** (`remarkHtmlAsText`), so an all-HTML message shows its source instead of being silently dropped. Rendering must degrade visibly, never to nothing.
- **Mention auto-join (Slack-style)**: in a **public `channel`**, `@`-mentioning a workspace member who isn't in the channel adds them to `channel_members` before the mention is recorded (`core.autoJoinMentioned`), so the mention actually delivers (wake / inbox) instead of being silently dropped. **Excluded for `private` / `dm` / `thread`** — auto-adding there would leak member-only history or break two-party DM semantics; an `@` to a non-member stays a no-op.
- **Threads anchor only on real (user/agent) messages**: `resolveTarget` (`core.ts`) creates a thread off the parent message a `#channel:<shortid>` resolves to; a `shortid` that lands on a **system message** ("X created task / claimed / moved …") is rejected (`return null` → `/agent-api` `404 TARGET_FAILED`). System messages have no "open thread" affordance in the UI, so a reply threaded onto one would be delivered + persisted but **unreachable** — the same silent-loss failure mode as an empty bubble.
- **`name` is the @mention handle, validated as a machine-safe identifier on creation** (`^[A-Za-z][A-Za-z0-9_-]*$`, ≤`MAX_AGENT_NAME` (64) chars since the column is unbounded `text`, `core.invalidAgentName`, enforced in `POST /api/agents` + frontend `CreateAgentModal`). It is used verbatim as `@<name>` (`parseMentions`, CLI, web) and as the `dm:@<name>` lookup key, so spaces / punctuation / emoji / leading digits would break mention parsing and DM resolution. Display-friendly text (Chinese, spaces, emoji) belongs in `displayName`, which is unconstrained. ⚠️ `users.name` carries a DB `UNIQUE` constraint; `agents.name` does **not** yet (per-server uniqueness is pending — see tech-debt-tracker).
- **Credential hygiene**: plain-text API keys / tokens only in DMs or private channels, **never in public channels**.
- **`storageKey` is driver-agnostic**: switching local ↔ S3 requires no changes to business logic.
- **Agent communication is unified through the `open-tag` CLI** (generated at `~/.open-tag/bin`, injected into the agent's PATH). Claude agents do **not** use MCP. What the agent cannot see in its context effectively does not exist — knowledge is persisted to the workspace `MEMORY.md`.
- **Agents are single-threaded / one agent = one session (intentional design, not a limitation)**: one agent = one process, one session; turns are **serial** (while busy, deliver-debounce batches incoming messages rather than interrupting). **Parallelism lives at the team level (multiple agents collaborating), not inside a single agent** — "employee mental model" (see §I): scale by hiring more people, not by making one person multi-thread. `Task` and sub-agents are **not blocked** (inherited from the host machine's tooling), but the standing prompt does not encourage their use → **do not build logic that depends on which sub-agents happen to be installed, and do not add `/fork`-style intra-agent parallelism**.
- **Single file ≤ 1000 lines** (split if exceeded). Currently the largest is `routes-api.ts` at ~670 lines.

## IV. Boundaries (made explicit because they are easy to miss)

- `/api` (human) ↔ `/agent-api` (agent) ↔ `/daemon` WS (control) — three independent entry points demultiplexed in order in `index.ts`.
- `realtime.publish()` — the **sole fan-out point** for all human-side real-time events.
- `storage.saveObject/readObject` — the **sole boundary** for all object I/O.
- `runtime.ts` interface — all differences between claude / codex / copilot / opencode / kimi / pi / cursor (incl. persistent-process vs one-shot-per-turn lifecycles) are contained behind adapters; the upper-layer `agentManager` is runtime-agnostic.
- Daemon ↔ server protocol (message `type`) — D→S defined in `ws.ts`; S→D defined in `core.ts` / `daemonHub`. This is the control-plane contract.

## V. Cross-cutting concerns

- `env.ts` must be imported before any module that reads `process.env`.
- `log.ts` spans all three planes; logs land in `~/.open-tag/logs/`.
- `redis.ts` seq / task-number / pub-sub / wake queue are shared infrastructure for real-time and sync.
- `auth.ts` (human/agent) + `ws.ts` (daemon key) + `scopes.ts` (agent permissions) + `capabilities.ts` (human role permissions) are enforced across all routes.

## VI. Maintenance notes

- This file is intentionally short. **Do not keep it in sync line-by-line with the code.** Come back only when a module's purpose, boundary, or invariant changes.
- `CLAUDE.md` acts only as a **directory** pointing here and to `docs/`; architecture detail does not belong in `CLAUDE.md`.
- When changing `src/db/schema.ts`, regenerate `docs/generated/db-schema.md`. When adding or removing routes or CLI subcommands, update the Codemap in §II. When completing a feature, tick it off in `FEATURES.md`.

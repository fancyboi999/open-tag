# Changelog

All notable changes to open-tag are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: these tags track the **compute-plane daemon** npm package
(`@fancyboi999/open-tag-daemon`). The server and web app ship continuously
from `main`; see commit history for fine-grained server/web changes.

## [Unreleased]

## [0.9.0] — 2026-07-06

### Added

- **Windows support**: daemon now runs natively on Windows (Docker Desktop + local daemon)
- `spawnSafe.ts` uses `cross-spawn` for correct Windows `.cmd` file resolution and argument escaping
- `killTree.ts`: process tree termination utility (`taskkill /T /F` on Windows, process group kill on POSIX)
- `docs/self-host-windows.md`: full Windows deployment guide

### Fixed

- Runtime detection (`command -v` → `powershell Get-Command` on Windows)
- CLI spawn: all 8 runtime adapters use `cross-spawn` instead of raw `spawn()`, avoiding Node v24 `.cmd` symlink bug
- Agent PATH separator: uses `path.delimiter` (`;` on Windows) instead of hardcoded `:`
- `.cmd` wrapper: `ensureOpenTagBin()` generates `open-tag.cmd` on Windows
- Signal handling: `SIGBREAK` (Ctrl+Break) registered for Windows graceful shutdown; `listModels` timeout uses signal-less `kill()` on Windows
- CRLF hazard in `scripts/docker-entrypoint.sh`

## [0.8.3] — 2026-07-06

### Fixed

- Daemon: a missing `claude` binary no longer crashes the whole daemon; spawn
  errors are surfaced as offline/error activity for that agent while the daemon
  keeps serving other agents.
- Server-side runtime reliability: clean machine disconnects immediately mark
  hosted agents offline, failed wake sends close any active reply preview with an
  error, and bound-machine starts require the selected machine's live websocket
  while legacy unbound agents keep the broadcast fallback for start, deliver, and
  lifecycle control messages.

## [0.8.2] — 2026-07-06

### Added

- Daemon/server reply-preview streaming contract: server wake messages now carry a
  stable `streamId` through `agent:deliver`, and the daemon reuses that id for
  `agent:reply` `delta`/`done` events so the web preview can stream into the
  same temporary card instead of replacing it at the end.

### Fixed

- Daemon: one-shot delivery debounce now keeps the latest server-provided
  `streamId`, preventing consecutive same-agent wakeups from leaving an orphan
  thinking preview.

## [0.8.1] — 2026-07-05

### Fixed

- Daemon: a missing `codex` binary no longer crashes the whole daemon — spawn
  errors (ENOENT etc.) are caught and surfaced as an `offline` agent activity
  (`codex not found`) while the daemon keeps serving its other agents (#163, #164).
- Server-side (ships from `main`, not this package): agent starts/wakes are gated
  on the assigned machine being online and advertising the agent's runtime, and
  are delivered to that machine only; unbound agents (`machineId = null`) keep
  the broadcast fallback.

## [0.8.0] — 2026-07-03

### Added

- **Experimental Hermes runtime** (#158, #159): one-shot `hermes chat -q` per turn,
  profiles discovered live from `~/.hermes/profiles` (+ `HERMES_PROFILE_DIR`) and
  selected per-agent via `HERMES_HOME`/`HERMES_PROFILE` — Hermes keeps owning
  provider credentials. Native `session_id` capture for resume, with a
  self-healing fresh retry when a resumed session is missing.
- **Hermes final-response bridge** (#159): a turn that read messages but never ran
  `message send` gets its stdout bridged back to the channel it read —
  evidence-gated, noise/error-filtered, freshness-hold-aware, loud on refusal.
- `Runtime.oneShotWake` capability flag: one-shot-per-turn runtimes get a concrete
  check→send wake instruction and a short delivery debounce, generically.

### Included from unreleased 0.7.2

- Workspace tab shows the real daemon workspace root when `OPEN_TAG_HOME` is
  non-default (#152). (0.7.2 was never published separately.)

## [0.7.1] — 2026-07-02

### Changed

- claude/codex model + reasoning effort are now optional (PR #151): an agent with
  `model = NULL` makes the daemon omit `--model`/`--effort` so the CLI uses its
  local config (`~/.claude` / `~/.codex`).

### Fixed

- `claudeRuntime` now actually forwards `--effort` (the #65 UI picker had only
  ever reached codex); `buildClaudeArgs` extracted as a unit-tested pure function
  with an effort allow-list.

## [0.7.0] — 2026-07-01

### Added

- **Agent task handoff**: `open-tag task assign --message-id <id> --to @agent`
  (or `--channel #ch --number N`) reassigns a task to another agent, records the
  handoff in the task thread, and wakes the assignee on the thread target.
- Stable `thread:shortid` thread-target form (alongside `#channel:shortid`) that
  resolves consistently across agents, private channels, and DMs; the shared
  agent prompt prefers it when a thread target crosses actors.

## [0.6.1] — 2026-06-27

### Fixed

- Machine liveness after server redeploys / half-open daemon WebSockets: the
  daemon closes and reconnects when server frames stop arriving (server-frame
  watchdog), and the server guards machine-offline handling so a stale socket
  close cannot override a newer connection for the same machine.

## [0.6.0] — 2026-06-26

### Removed

- The **demo runtime** (added in 0.5.0) is removed entirely (#112) — the
  Create-Agent dropdown, adapter, registry, and model-discovery entries are gone.
  The seven real runtimes are unchanged.

## [0.5.1] — 2026-06-26

### Fixed

- Remote daemons (daemon host ≠ server host) injected
  `OPEN_TAG_SERVER_URL=http://localhost:PORT` into spawned agents, so every
  `open-tag` CLI call failed with `fetch failed`. The daemon now spawns agents
  with the server URL it actually connected with (`--server-url`), overriding the
  server-reported `SELF_URL`. Same-host self-hosting is unchanged; split deploys
  now work. (tech-debt I66)

## [0.5.0] — 2026-06-26

### Added

- `demo` no-op runtime (#93) for stack smoke-testing without an external CLI.
  (Removed again in 0.6.0.)

## [0.4.0] — 2026-06-25

### Changed

- Daemon: skills are now resolved per the agent's runtime (`skillRootsFor`).
  Claude agents read `~/.claude/skills`, Codex reads `~/.codex/skills`,
  OpenCode reads `~/.config/opencode/skills`, Cursor/Pi/Copilot each use
  their own directory, plus the universal `~/.agents/skills` fallback.
  Previously all runtimes fell through to Claude's skills directory.
- The `agent:skills:list` WebSocket RPC now carries the agent's runtime so
  the server can forward the correct path.

### Fixed

- Non-Claude agents no longer accidentally load Claude's skill definitions.

## [0.3.0] — 2026-06-25

### Changed

- Daemon: the `daemonVersion` field in the `ready` payload now reflects the
  actual published package version instead of the hard-coded string `"0.1.0"`.
  The build script injects the version from `packages/daemon/package.json` at
  bundle time; local `tsx` runs report `"dev"`.

### Added

- Dynamic model discovery for OpenCode, Cursor, and Pi runtimes (model list
  fetched via a one-shot shell probe on first use, cached per session).
- Per-model effort-level filtering for Claude: Opus supports `low/med/high/
  xhigh/max`; Sonnet supports `low/med/high/max`; Haiku supports `low/med/high`.
  Prevents the UI from offering unsupported effort levels for a given model.

## [0.2.0] — 2026-06-25

### Added

- Five new runtime adapters: **Copilot CLI**, **OpenCode**, **Kimi Code**,
  **Pi**, and **Cursor** — each with a one-shot-per-turn adapter that resumes
  sessions via the runtime's own `--session`/`--resume` flag.
- `detectRuntimes()` now probes all seven supported runtime binaries.

### Fixed

- Daemons running `0.1.0` (published before #44 merged) reported
  `no runtime: copilot` on every agent start. `0.2.0` ships the five new
  runtimes and is published via OIDC Trusted Publishing (no stored npm token).

## [0.1.0] — 2026-06-24

### Added

- First release of the compute-plane daemon as a standalone npm package
  (`@fancyboi999/open-tag-daemon`).
- Self-contained esbuild bundle — daemon process + agent CLI — runnable with
  `npx @fancyboi999/open-tag-daemon --server-url <url> --api-key sk_machine_…`
  on any machine with Node ≥ 20, without cloning the repository.
- Supported runtimes at time of release: **Claude Code** and **Codex**.

[Unreleased]: https://github.com/fancyboi999/open-tag/compare/v0.8.3...HEAD
[0.8.3]: https://github.com/fancyboi999/open-tag/compare/v0.8.2...v0.8.3
[0.8.2]: https://github.com/fancyboi999/open-tag/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/fancyboi999/open-tag/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/fancyboi999/open-tag/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/fancyboi999/open-tag/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/fancyboi999/open-tag/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/fancyboi999/open-tag/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/fancyboi999/open-tag/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/fancyboi999/open-tag/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/fancyboi999/open-tag/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/fancyboi999/open-tag/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/fancyboi999/open-tag/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/fancyboi999/open-tag/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/fancyboi999/open-tag/releases/tag/v0.1.0

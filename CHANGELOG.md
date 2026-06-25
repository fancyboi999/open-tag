# Changelog

All notable changes to open-tag are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: these tags track the **compute-plane daemon** npm package
(`@fancyboi999/open-tag-daemon`). The server and web app ship continuously
from `main`; see commit history for fine-grained server/web changes.

## [Unreleased]

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

[Unreleased]: https://github.com/fancyboi999/open-tag/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/fancyboi999/open-tag/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/fancyboi999/open-tag/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/fancyboi999/open-tag/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/fancyboi999/open-tag/releases/tag/v0.1.0

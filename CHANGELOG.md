# Changelog

All notable changes to open-tag are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: these tags track the **compute-plane daemon** npm package
(`@fancyboi999/open-tag-daemon`). The server and web app ship continuously
from `main`; see commit history for fine-grained server/web changes.

## [Unreleased]

### Fixed

- Pi-compatible runtimes can be launched through an explicit `OPEN_TAG_PI_COMMAND`, avoiding
  Windows batch wrappers that truncate multiline wake prompts. A zero exit with no parseable JSON
  events is now reported as an error instead of producing a misleading empty "Handled" receipt.

## [0.15.0] — 2026-08-02

### Added

- **Reasonix runtime** (`reasonixRuntime.ts`): agents can now run on the Reasonix CLI
  (DeepSeek-native terminal coding agent, verified against v1.18.0 and re-verified live on v1.19.1).
  One-shot per turn —
  each turn spawns `reasonix run --output-format stream-json --permission-mode bypassPermissions`
  and parses the eventwire stream (the assembled `message` event → text, the incremental `text`
  slices dropped, `tool_dispatch` → tool with the partial+full pair deduped). Multi-turn +
  wake-resume chain by resuming the session file Reasonix persists under
  `~/.reasonix/projects/<encoded-cwd>/sessions/` (`--resume` takes a file path, not an id).
  `runtimeConfig.reasoningEffort` forwards via `--effort`, allow-listed to the values the CLI
  accepts (`low|medium|high|max`). `reasonix` joins `detectRuntimes()`, its skills resolve from
  `~/.reasonix/skills` + `<workspace>/.reasonix/skills`, and model discovery enumerates the
  resolved config via `reasonix doctor --json`.

### Fixed

- **Reasonix turn-livelock on wake nudges** (found on a live NAS deploy): the wake nudge was
  passed as a bare task, so Reasonix treated it as an original coding task and spiraled into a
  tool-exploration loop (`tool_dispatch` ~60× in 150s), and without a step bound the run never
  exited. The standing system prompt is now injected per turn via `runtimeInstructionEnvelope`,
  each run is bounded with `--max-steps 100`, and `oneShotWake` is left off so nudges take the
  normal delivery path.
- **Reasonix never published replies**: `--max-steps 3` was too tight for the open-tag
  collaboration loop (`message check` → `message decide` → work → `message send`), so a working
  agent hit the limit mid-turn, Reasonix forbade further tool calls, and the synthesized final
  answer stayed in the session — no channel reply was posted. The bound is set to `--max-steps 100`
  as an observation value: wide enough that real turns never hit it while a livelock still
  terminates, and a daemon warn logs whenever a turn does reach it — so if it never fires across a
  watch period the cap is redundant and can be removed; if it fires, Reasonix still needs the bound.
- **Reasonix streamed slices rendered one glyph per line**: `text` events carry one token slice
  at a time, so they are now dropped in favor of the assembled `message` event.
- **Reasonix model list never marked a default**: v1.18.0/v1.19.1 reports `is_default: false` on *every*
  provider even when `config.default_model` names one, so keying the default off that flag left
  the list unmarked and the create-agent modal preselected whichever provider came first in config
  order instead of the configured default. The default now resolves from `config.default_model`
  (`<provider>/<model>`, a bare provider name, or a bare model id).
- **Reasonix resume path was realpath-resolved, inverting the real behavior**: Reasonix keys
  session storage on its *logical* cwd (it honors `PWD`), so a run in a symlinked directory such as
  `/tmp/x` (getcwd `/private/tmp/x` on macOS) writes `projects/-tmp-x` and `-private-tmp-x` is
  never created. The computed path used `realpathSync`, so it missed on every symlinked cwd and
  resume survived only via the by-id fallback. It now encodes the cwd as given, with
  `findReasonixSessionFile` (a by-id search of `~/.reasonix/projects/*/sessions/`) remaining the
  fallback for bind-mount hosts (e.g. a Synology NAS where the home dir's logical path and real
  path differ).
- **Reasonix `--effort` accepted values the CLI rejects**: the allow-list carried the claude/codex
  vocabulary (`none`/`xhigh`), which an openai-kind provider refuses with a non-zero exit
  (`effort must be low, medium, or high`) — on a first turn that reported the agent as crashed.
  Narrowed to the probed set `low|medium|high|max`.
- **Reasonix agents listed and wrote Claude's skills**: `reasonix` was missing from the daemon and
  server skills registries, so both fell back to `.claude` — a reasonix agent enumerated
  `~/.claude/skills` and a skill upload landed in `.claude/skills/`. Added its documented dirs
  (`~/.reasonix/skills`, honoring `REASONIX_HOME`, + `<workspace>/.reasonix/skills`).

## [0.14.0] — 2026-07-28

### Added

- **Per-agent project directory binding**: an owner can bind an inactive agent to an existing
  absolute directory on its selected machine. The daemon canonicalizes the path on that machine,
  revalidates it before every start, and launches the runtime with it as `cwd`. OpenTag-owned
  memory, personality, notes, session artifacts, and reset scope remain under
  `OPEN_TAG_HOME/agents/<agent-id>`.
- Runtime instruction composition no longer writes generated `AGENTS.md` files into the runtime
  cwd. Claude and Pi use managed prompt files, Codex uses `developerInstructions`, Copilot uses
  `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`, OpenCode uses merged inline agent config, Cursor uses a
  managed always-on plugin rule, and Hermes/Kimi use per-turn envelopes. Existing project
  instructions and runtime/global configuration continue to load normally.
- New `project-directory-v2` daemon capability and targeted `project:resolve` RPC make mixed-version
  fleets fail closed instead of silently starting an agent in its old state directory. Changing a
  bound directory is allowed only while inactive and atomically clears the runtime session.
- A `project-browser-v1` machine-targeted RPC lets managers browse explicitly shared daemon roots
  and run bounded, marker-only project discovery from the Agent form. `OPEN_TAG_PROJECT_ROOTS` is the
  common fail-closed policy for the picker, manual paths, and every project-bound start; directory
  paths travel in authenticated POST bodies rather than query strings that reverse proxies may log.

### Fixed

- One-shot runtime stop now settles exactly once for both a live child and an already-idle adapter,
  so stop/reset/delete no longer wait for a process exit that already happened. This covers
  Copilot, Cursor, Hermes, Kimi, OpenCode, and Pi.
- A Hermes startup turn that successfully checks an empty inbox now completes as a normal no-op.
  Previously its explanatory stdout was misclassified as `no-open-tag-read`, suppressing the
  terminal `online` event and deadlocking a durable Turn queued just after startup.

### Security

- Agent detail responses now use an explicit serializer: environment variables and token/scope
  internals are no longer returned, and machine-local absolute project paths are visible only to
  members with `manageAgents`. Project-local skill metadata is also manager-only and project-local
  skills are read-only through OpenTag.
- Managed state reads/writes reject symbolic-link escapes, including generated runtime artifacts,
  `MEMORY.md` reset/profile synchronization, and workspace file operations. A bound agent cannot
  redirect an OpenTag management action into the operator-owned project through a state symlink.
- Project-bound deletion now requires a confirmed daemon stop, and daemon capability requirements
  are checked on the exact connection receiving each start/delivery frame. Durable multi-recipient
  preflight is read-only, so a blocked peer cannot leave other agents stuck in `starting`.
- Project-directory RPC responses are bound to the exact target daemon connection and expected
  response type, then schema-clamped by the server before directory metadata reaches the browser.
  Hidden/sensitive descendants and symbolic-link escapes cannot be selected even by manual path.

## [0.13.1] — 2026-07-28

### Fixed

- **Windows missing-runtime admission**: resolve the real CLI through `cwd`, `PATH`, and
  `PATHEXT` before handing `.cmd` shims to `cross-spawn`. A missing runtime now emits
  ENOENT before any process-spawn admission, instead of briefly admitting the fallback
  `cmd.exe` process and losing the Turn when it exits.

## [0.13.0] — 2026-07-27

### Fixed

- **Queued Turn isolation**: each agent now executes durable Conversation Turns in strict FIFO
  order. A second DM or channel Turn stays invisible to the active runtime and does not create a
  zero-event Activity placeholder until the prior runtime turn reaches its terminal `online` state.
  Runtime `error` events no longer advance the queue early, and cold start admits only the queue
  head instead of exposing every pending Turn to one startup inbox check. A rejected admission
  barrier now creates neither runtime input nor a phantom Activity receipt.
- **Two-phase delivery admission**: daemon capability `delivery-admission-v2` adds a
  `ready -> admitted` barrier. The server verifies tenant, current machine, agent ownership, Turn,
  recipient, and sequence, durably writes recipient admission, then allows the daemon to notify the
  runtime. This closes the race where a fast `message check` saw an empty inbox and finished as
  Handled without replying. Completed delivery ids survive ordinary final-ACK loss and process
  replacement; NACK or pre-ACK disconnect releases the in-flight admission for retry.
- **Freshness cursor safety**: send-time stale-draft checks may surface unseen ambient collecting
  context without consuming its formal inbox observation. Direct/DM queued Turns do not hold the
  previous reply, and neither freshness nor a later stable message may advance `lastReadSeq` across
  an unadmitted Turn. Observation and per-draft review ledgers prevent repeated holds across gaps.
- **Consistent agent identity in chat**: DM sidebar, live Activity, persisted replies, threads, and
  action cards use the same display identity for generated avatar fallbacks.

### Changed

- Non-ambient `direct`, `dm`, and `assigned` Turn rows require recipient runtime admission before
  `message check`, decide, message send, or legacy thread reply. Ambient channel context remains
  readable so unmentioned agents can still judge relevance without being forced to answer.

## [0.12.0] — 2026-07-24

### Added

- **Sender-scoped Conversation Turns**: daemon delivery notices now carry a durable Turn id,
  coalesced message count, attention class, and deterministic delivery id. Separate humans or
  agents in one channel stay isolated, while short same-sender bursts arrive as one work notice.
- **Admission-aware delivery fencing**: the daemon de-duplicates a repeated Turn delivery id and ACKs
  only after explicit runtime admission. A resource-pressure queue stays pending until the runtime
  accepts the startup nudge; dequeue, stop, spawn, stdin, or `turn/start` failure sends a NACK and
  clears the fence so the same id can retry. Concurrent retries share one admission result, and an
  ACK/NACK without the durable delivery id is rejected rather than treated as compatible. Successful
  ids are persisted across daemon process replacement with a locked read-merge ledger that remains
  coherent while old and replacement daemon processes overlap, and the server records admission per
  recipient so a partial multi-recipient retry delivers only unresolved recipients. A busy runtime
  emits pending heartbeats that renew the transport waiter without producing an early final ACK.
- **Mixed-version fail-closed gate**: a daemon must advertise `delivery-admission-v1` before it can
  receive or pull a Conversation Turn. Missing-capability Turns stay active and paused, emit no
  start/delivery frames, and resume automatically when a capable bound daemon reconnects or the
  sole capable daemon takes responsibility for a legacy unbound agent.
- **Settled lifecycle control**: start, stop, reset, and restart now use the
  `agent-control-ack-v1` request/ACK contract. The server waits for the daemon operation to settle,
  returns reset failures instead of swallowing them, and never starts the next restart phase after
  a failed stop/reset. Start waits for initial runtime-protocol admission, stop/reset wait for the
  old process exit, and a late old exit cannot remove a replacement instance.

### Changed

- Per-agent Activity previews are FIFO: a second Turn waits for the first runtime turn to finish
  instead of prematurely closing its Activity and stealing subsequent trajectory events.
- Multi-mention recipients are capability-preflighted as one intent, then delivered concurrently
  under an attempt-fenced lease. A mixed-version fleet therefore starts none of the named agents
  instead of half the team. A partial runtime
  NACK keeps the Turn and explicit grants visible while deterministic same-id retries finish; stale
  dispatchers cannot overwrite a newer attempt or a reply that already completed.
- The standing prompt handles every distinct canonical trigger in one inbox check, while preserving
  one decision and at most one granted public result per agent and trigger.

## [0.11.0] — 2026-07-23

### Added

- **Conversation-scoped Agent Activity**: daemon status and trajectory frames now carry the active
  `channelId`, reply `streamId`, and monotonically increasing `runSeq`. The server uses that context
  to persist complete thinking/tool/status history under the public messages produced by the run,
  including correct segmentation when one run sends multiple messages.

### Changed

- Runtime narration is no longer mirrored into provisional `agent:reply delta` text. It is emitted
  only as Activity; a public message exists only when the agent calls the message API. Runs that post
  no message finish as a human-visible handled/error Activity receipt, which agent inbox/read APIs
  exclude to prevent collaboration loops.

## [0.10.4] — 2026-07-23

### Changed

- **Explicit multi-agent work mentions**: the standing prompt recognizes independent
  `directed` grants for every explicitly mentioned contributor, requires each named
  agent to accept or choose no action, and lets ambient agents request the one
  supplemental slot for unique expertise without turning every observer into a reply.
- **Task collaboration**: one primary coordinator claims the parent Task while named
  contributors publish their scoped results in the Task thread without competing for
  assignment. The recorded `accept` decision now serves as acknowledgement, reserving
  each one-shot public grant for a completed result or concrete blocker instead of an
  acknowledgement, plan, or progress update. Parent-channel Task replies and contributor
  claim/assign/update attempts are rejected.
- **Existing-install index migration**: `db:push` now applies an idempotent explicit
  reply-index rebuild before Drizzle Kit, because Drizzle does not detect partial-index
  predicate changes. Fresh and upgraded databases therefore enforce the same budget.

### Fixed

- **Hermes directed replies**: the one-shot final-response bridge recognizes a
  `directed` grant instead of incorrectly requesting primary ownership again.
- **Agent-authored work mentions**: explicit mentions may auto-join reachable teammates
  under the same public/private reach boundary as human mentions; ambient agent chatter
  remains non-wakeable.

## [0.10.3] — 2026-07-23

### Added

- **Reply coordination CLI**: agents now see attention/decision/grant metadata, record a
  structured `message decide` outcome, and bind public replies with `message send
  --reply-to`. The daemon standing prompt no longer compels every awakened agent to
  answer; it requires observation and a decision, then permits a reply only when the
  server grants a primary or supplemental slot. Better-fit requests and transferred
  grants privately re-wake the relevant owner, while a bounded settlement window keeps
  an eager provisional owner from publishing before concurrent observers decide.

### Fixed

- **One-shot Hermes reply authorization**: the final-response bridge binds stdout to the
  checked trigger, requests a grant for ambient responses, and stays silent when denied;
  it can no longer bypass server-side coordination by posting an unbound message.

## [0.10.2] — 2026-07-20

### Fixed

- **Agents no longer double-reply on cold-start wake**: a message that woke a sleeping/stopped
  agent used to drive **two** turns — the wake nudge (STARTUP/RESUME) drove one, and the deliver
  that had queued during workspace preparation was re-flushed as a `[inbox notice]` ~3 s later,
  driving a second turn on the same (already-handled) message. Every persistent-runtime agent in
  a channel visibly replied twice to a single "hi". Deliveries queued before the runtime starts
  are now consumed by the wake nudge itself for **all** runtimes (previously only one-shot
  runtimes did this); messages are persisted server-side, so the nudge turn's `message check`
  still reads them, and the reply preview keeps working. Deliveries to an already-running agent
  are unchanged (3 s batched inbox notice).

## [0.10.1] — 2026-07-19

### Fixed

- **Version-skew NACK for unknown RPCs**: a daemon receiving an RPC `type` it doesn't know (a message
  carrying a `requestId`) now replies `{type:"rpc:nack", requestId, error}` instead of silently dropping
  it, so a ≥0.10.1 server can report "daemon too old — restart with `npx @fancyboi999/open-tag-daemon@latest`"
  instead of a generic RPC timeout. (Server-side in the same change, outside this package: personality/skills
  workspace RPCs are now routed to the agent's own machine via `requestDaemonByMachine` instead of a
  serverId-wide broadcast, and the web UI surfaces RPC errors as toasts instead of a false "saved".)

## [0.10.0] — 2026-07-19

<!-- PR #184 shipped as one package release: the 0.9.1/0.10.0 sections drafted during
     review never reached npm individually, so their entries are consolidated here. -->

### Added

- **Personality override**: place a `personality.md` file in the agent workspace
  (`~/.open-tag/agents/<agent-id>/`) to inject a detailed persona into the system
  prompt and MEMORY.md `## Role` section, overriding the agent's `description`
  field. Compatible with agency-agents personality files and any runtime.
- **Personality upload/delete (server + web UI)**: `GET/PUT/DELETE /api/agents/:id/personality` endpoints gate on `manageAgents`; the Profile tab now shows current `personality.md` content with Upload .md and Delete buttons. Uploaded files are auto-renamed to `personality.md` in the agent workspace; after write/delete the daemon re-syncs MEMORY.md `## Role` via `syncProfile()`.
- **Skills upload/delete (server + web UI)**: `PUT/DELETE /api/agents/:id/skills/:name` endpoints gate on `manageAgents`; the Skills section shows a "+ Skill" button. Uploaded `.md` files without frontmatter get auto-generated YAML (`name` + `userInvocable: true`). Workspace-scoped skills have a ✕ delete button; global skills are read-only.
- **Daemon workspace file write/delete**: `writeWorkspaceFile()` / `deleteWorkspaceFile()` exports in `workspace.ts`, wired as `agent:workspace:write` / `agent:workspace:delete` WS-RPC cases in the daemon message dispatcher. Used by the personality and skills endpoints.
- **Auto-frontmatter for skill uploads**: when a `.md` file without frontmatter is uploaded, the frontend prepends `---\nname: <skillName>\nuserInvocable: true\n---` so the skill is immediately recognized by the daemon's `readSkillsDir()`.
- **Dynamic memory pressure system**: replaced static per-agent resource limits with system-wide memory pressure management. When available memory drops below `OPEN_TAG_PRESSURE_MEM_MB` (default 500 MB), new agents are queued and running agents are capped at their current RSS + a fair-share margin. Available memory is read from `/proc/meminfo` `MemAvailable` on Linux; on macOS/Windows a conservative 0.15 × total-RAM estimate keeps the gate fail-open. The Windows Job Object and Linux cgroup handles are still created for pressure-ready enforcement.

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

[Unreleased]: https://github.com/fancyboi999/open-tag/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/fancyboi999/open-tag/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/fancyboi999/open-tag/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/fancyboi999/open-tag/compare/v0.8.3...v0.9.0
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
